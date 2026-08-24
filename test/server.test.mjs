/* Server tests: real HTTP against a real (temporary) SQLite database, with the
   OAuth round trip stubbed at the network boundary. No npm dependencies. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'trip-test-'));
process.env.DB_FILE = join(dir, 'test.db');
process.env.PORT = '0';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

let pass = 0;
const check = (name, fn) => fn().then(() => { pass++; console.log(`  ✓ ${name}`); },
  e => { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1; });

/* --- stub the provider: token exchange + profile --- */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token'))
    return new Response(JSON.stringify({ access_token: 'at-1' }), { headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo'))
    return new Response(JSON.stringify({ sub: 'g-1', email: 'traveller@example.com', name: 'Traveller', picture: 'https://x/y.png' }),
      { headers: { 'Content-Type': 'application/json' } });
  return realFetch(url, opts);
};

const { server, db } = await import('../server/main.js');
await new Promise(r => (server.listening ? r() : server.once('listening', r)));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.BASE_URL = base;

/* --- helpers --- */
let cookies = new Map();
const jar = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
    if (/Max-Age=0/.test(c) || v === '') cookies.delete(k); else cookies.set(k, v);
  }
  return res;
}
const req = (path, opts = {}) => fetch(base + path, {
  redirect: 'manual',
  ...opts,
  headers: { Cookie: jar(), ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.method && opts.method !== 'GET' ? { Origin: base } : {}), ...opts.headers },
}).then(absorb);
const jreq = async (...a) => { const r = await req(...a); return { status: r.status, body: await r.json().catch(() => null) }; };

const trip = (over = {}) => ({
  v: 1, id: 'trip-1', title: 'Kansai', currency: 'JPY',
  startDate: '2026-11-08', endDate: '2026-11-10',
  items: {}, stays: {}, order: { unscheduled: [] }, photos: {}, collapsed: {}, ...over,
});

/* ---------------- tests ---------------- */
console.log('server');

await check('serves the static app at /', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Trip Planner/);
});

await check('never serves its own source', async () => {
  assert.equal((await req('/server/.env')).status, 403);
  assert.equal((await req('/server/main.js')).status, 403);
});

await check('anonymous /api/me advertises providers but no user', async () => {
  const { status, body } = await jreq('/api/me');
  assert.equal(status, 200);
  assert.equal(body.user, null);
  assert.deepEqual(body.providers.map(p => p.id), ['google']);
});

await check('trip endpoints require a session', async () => {
  assert.equal((await jreq('/api/trip')).status, 401);
  assert.equal((await jreq('/api/trip', { method: 'PUT', body: '{}' })).status, 401);
});

await check('a bad oauth state is rejected', async () => {
  const r = await req('/auth/google/callback?code=x&state=wrong');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /sign-in-error/);
});

await check('the google round trip creates a session', async () => {
  const start = await req('/auth/google/start');
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');   // PKCE

  const state = cookies.get('oauth_state').split('%3A')[1] || decodeURIComponent(cookies.get('oauth_state')).split(':')[1];
  const back = await req(`/auth/google/callback?code=abc&state=${state}`);
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /#signed-in/);

  const { body } = await jreq('/api/me');
  assert.equal(body.user.email, 'traveller@example.com');
  assert.equal(body.user.provider, 'google');
});

await check('a cross-site write is refused even with the cookie', async () => {
  const r = await fetch(base + '/api/trip', {
    method: 'PUT', headers: { Cookie: jar(), Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ trip: trip() }),
  });
  assert.equal(r.status, 403);
});

let rev;
await check('first save creates rev 1 and reads back', async () => {
  const put = await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({ baseRev: 0, trip: trip() }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.rev, 1);
  rev = put.body.rev;

  const got = await jreq('/api/trip');
  assert.equal(got.body.trip.title, 'Kansai');
  assert.equal(got.body.rev, 1);
});

await check('a stale save is a 409 carrying the winning copy', async () => {
  const ok = await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({ baseRev: rev, trip: trip({ title: 'Kansai v2' }) }) });
  assert.equal(ok.body.rev, 2);

  const stale = await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({ baseRev: rev, trip: trip({ title: 'from the other laptop' }) }) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 2);
  assert.equal(stale.body.trip.title, 'Kansai v2');
  rev = 2;
});

await check('a second trip does not overwrite the first', async () => {
  await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({ baseRev: 0, trip: trip({ id: 'trip-2', title: 'Lisbon' }) }) });
  const list = await jreq('/api/trips');
  assert.deepEqual(list.body.trips.map(t => t.id).sort(), ['trip-1', 'trip-2']);
  const newest = await jreq('/api/trip');
  assert.equal(newest.body.trip.title, 'Lisbon');        // most recently written
  const byId = await jreq('/api/trip?id=trip-1');
  assert.equal(byId.body.trip.title, 'Kansai v2');
});

await check('blobs upload once, report as present, and come back', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const before = await jreq('/api/blobs/missing', { method: 'POST', body: JSON.stringify({ ids: ['b1'] }) });
  assert.deepEqual(before.body.missing, ['b1']);

  const up = await req('/api/blobs/b1', { method: 'PUT', body: bytes, headers: { 'Content-Type': 'image/png' } });
  assert.equal(up.status, 200);

  const after = await jreq('/api/blobs/missing', { method: 'POST', body: JSON.stringify({ ids: ['b1', 'b2'] }) });
  assert.deepEqual(after.body.missing, ['b2']);

  // keep it alive: the sweep runs on every save
  await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({
    baseRev: rev, trip: trip({ title: 'Kansai v3', photos: { '2026-11-08': [{ id: 'b1', caption: '' }] } }) }) });
  rev = 3;

  const down = await req('/api/blobs/b1');
  assert.equal(down.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await down.arrayBuffer()), bytes);
});

await check('unreferenced blobs are swept on save', async () => {
  await req('/api/blobs/orphan', { method: 'PUT', body: new Uint8Array([1]), headers: { 'Content-Type': 'image/png' } });
  assert.equal((await req('/api/blobs/orphan')).status, 200);

  await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({
    baseRev: rev, trip: trip({ title: 'Kansai v4', photos: { '2026-11-08': [{ id: 'b1', caption: '' }] } }) }) });
  rev = 4;

  assert.equal((await req('/api/blobs/orphan')).status, 404);   // not referenced by any trip
  assert.equal((await req('/api/blobs/b1')).status, 200);       // still referenced
});

await check('attachments count as references too', async () => {
  await req('/api/blobs/ticket', { method: 'PUT', body: new Uint8Array([9]), headers: { 'Content-Type': 'application/pdf' } });
  await jreq('/api/trip', { method: 'PUT', body: JSON.stringify({ baseRev: rev, trip: trip({
    title: 'Kansai v5',
    items: { a: { id: 'a', name: 'Flight', files: [{ id: 'ticket', name: 't.pdf' }] } },
    order: { unscheduled: ['a'] },
    photos: { '2026-11-08': [{ id: 'b1', caption: '' }] },
  }) }) });
  rev = 5;
  assert.equal((await req('/api/blobs/ticket')).status, 200);
});

await check('one account cannot read another account\'s blobs', async () => {
  const mine = cookies;
  cookies = new Map();
  const other = db.upsertUser({ provider: 'google', providerId: 'g-2', email: 'other@example.com', name: 'Other' });
  cookies.set('sid', db.startSession(other.id, 60_000));
  assert.equal((await req('/api/blobs/b1')).status, 404);
  assert.equal((await jreq('/api/trip')).body.trip, null);
  cookies = mine;
});

await check('signing out invalidates the session', async () => {
  assert.equal((await jreq('/api/signout', { method: 'POST' })).status, 200);
  assert.equal((await jreq('/api/trip')).status, 401);
  assert.equal((await jreq('/api/me')).body.user, null);
});

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? '\nsome server checks failed' : `\nall ${pass} server checks passed`);
