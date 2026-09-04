/* The optional half of the app.
   ------------------------------------------------------------------
   Trip Planner works with no server at all: open index.html from any static
   host and everything lives in your browser. This process adds the part a
   static host cannot do — signing in and getting the same trip back on
   another computer — and serves the static site itself so one process is the
   whole deployment.

   No npm dependencies: node:sqlite for storage, node:http for serving,
   node:crypto for tokens. Node 22.5+ (or 24+) required.

     node server/main.js

   Configuration comes from the environment, optionally via server/.env —
   see server/.env.example. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDB } from './db.js';
import { PROVIDERS, configured, startURL, exchange } from './auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ---------------- config ---------------- */
loadDotEnv(join(HERE, '.env'));
const env = process.env;
const PORT = Number(env.PORT || 8123);
const HOST = env.HOST || '0.0.0.0';
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DB_FILE = env.DB_FILE || join(HERE, 'data', 'trip.db');
const SESSION_DAYS = Number(env.SESSION_DAYS || 90);
const MAX_DOC = Number(env.MAX_DOC_BYTES || 8 * 1024 * 1024);
const MAX_BLOB = Number(env.MAX_BLOB_BYTES || 25 * 1024 * 1024);
const QUOTA = Number(env.QUOTA_BYTES || 750 * 1024 * 1024);
const SECURE = BASE_URL.startsWith('https://');
const PLACES_KEY = env.GOOGLE_PLACES_KEY || '';

const db = openDB(DB_FILE);
const providers = configured(env);

/* ---------------- helpers ---------------- */
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store' });
  res.end(s);
};
const text = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const redirect = (res, to, cookies = []) => {
  res.writeHead(302, { Location: to, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
};

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';')
  .map(c => c.trim()).filter(Boolean)
  .map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));

const setCookie = (name, value, { maxAge = 0, clear = false } = {}) =>
  `${name}=${clear ? '' : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax` +
  `${SECURE ? '; Secure' : ''}; Max-Age=${clear ? 0 : maxAge}`;

async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { req.destroy(); throw Object.assign(new Error('too large'), { code: 413 }); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/* A state-changing request must come from our own origin. Combined with the
   SameSite=Lax session cookie this is enough to stop cross-site writes. */
const sameOrigin = req => {
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host === new URL(BASE_URL).host || o === `http://${req.headers.host}`; }
  catch { return false; }
};

const userOf = req => db.userForToken(cookies(req).sid);
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar, provider: u.provider });

/* ---------------- place search ----------------
   A thin, server-side-only proxy to Google Places API (New) Text Search. It
   lives here rather than being called straight from the browser because the
   Places web service is a server-to-server API — it doesn't send CORS
   headers, so a direct fetch() from js/geo.js would just fail. Keeping the
   key server-side is also strictly better than a browser-restricted key: it
   never appears in the page at all. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;                // per caller, per minute — generous for typing, tight for a scraper
const rateHits = new Map();
function placesRateLimited(req) {
  const key = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (rateHits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateHits.set(key, hits);
  return hits.length > RATE_MAX;
}

/* Field mask is kept to Text Search Pro–tier fields (no ratings, hours, price
   level, …) so this stays on Google's cheaper SKU — see
   developers.google.com/maps/documentation/places/web-service/text-search#fieldmask */
const PLACES_FIELDS = 'places.displayName,places.formattedAddress,places.location,places.primaryType,places.types';

async function placesTextSearch(q, near, limit) {
  const body = { textQuery: q, languageCode: 'en', maxResultCount: limit };
  if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': PLACES_FIELDS },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Places ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return (data.places || []).map(p => ({
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    lat: p.location?.latitude, lng: p.location?.longitude,
    primaryType: p.primaryType || '',
    types: (p.types || []).join(':'),
  }));
}

/* ---------------- routes ---------------- */
async function api(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/me' && method === 'GET') {
    const u = userOf(req);
    return json(res, 200, {
      user: publicUser(u),
      providers: providers.map(p => ({ id: p, label: PROVIDERS[p].label })),
      quota: u ? { used: db.usage(u.id).bytes, total: QUOTA } : null,
    });
  }

  /* Place search has to work before you have an account — a static deployment
     has no server for this at all, and js/geo.js falls back to keyless
     OpenStreetMap sources whenever this 404s or errors. No sign-in gate, so a
     lightweight per-caller rate limit stands in: enough to stop a stray bot
     from running up the Google bill without getting in the way of a person
     typing. */
  if (path === '/api/places/search' && method === 'GET') {
    if (!PLACES_KEY) return json(res, 404, { error: 'place search is not configured on this server' });
    if (placesRateLimited(req)) return json(res, 429, { error: 'search is being rate-limited — try again shortly' });
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json(res, 200, { results: [] });
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    const limit = Math.min(10, Number(url.searchParams.get('limit')) || 8);
    try {
      const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      return json(res, 200, { results: await placesTextSearch(q, near, limit) });
    } catch (e) {
      console.error('places search failed:', e.message);
      return json(res, 502, { error: 'place search is temporarily unavailable' });
    }
  }

  if (path === '/api/signout' && method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
    db.endSession(cookies(req).sid);
    res.writeHead(200, { 'Set-Cookie': setCookie('sid', '', { clear: true }), 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  const me = userOf(req);
  if (!me) return json(res, 401, { error: 'sign in first' });
  if (method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });

  /* --- trips --- */
  if (path === '/api/trips' && method === 'GET') {
    return json(res, 200, { trips: db.listTrips(me.id).map(t => ({
      id: t.trip_id, rev: t.rev, updatedAt: t.updated_at,
      title: t.title, startDate: t.start_date, endDate: t.end_date })) });
  }

  if (path === '/api/trip' && method === 'GET') {
    const id = url.searchParams.get('id');
    const row = id ? db.getTrip(me.id, id) : db.newestTrip(me.id);
    if (!row) return json(res, 200, { trip: null });
    return json(res, 200, { trip: JSON.parse(row.doc), rev: row.rev, updatedAt: row.updated_at });
  }

  if (path === '/api/trip' && method === 'PUT') {
    let payload;
    try { payload = JSON.parse((await body(req, MAX_DOC)).toString('utf8')); }
    catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: 'unreadable trip' }); }

    const trip = payload?.trip;
    if (!trip?.id) return json(res, 400, { error: 'trip.id is required' });

    const current = db.getTrip(me.id, trip.id);
    const baseRev = Number(payload.baseRev || 0);
    // somebody else's device already moved this trip on
    if (current && current.rev !== baseRev) {
      return json(res, 409, { error: 'stale', trip: JSON.parse(current.doc), rev: current.rev,
        updatedAt: current.updated_at });
    }
    const saved = db.saveTrip(me.id, trip.id, JSON.stringify(trip), (current?.rev || 0) + 1);
    db.sweepBlobs(me.id);
    return json(res, 200, saved);
  }

  if (path === '/api/trip' && method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { error: 'id required' });
    db.deleteTrip(me.id, id);
    db.sweepBlobs(me.id);
    return json(res, 200, { ok: true });
  }

  /* --- blobs --- */
  if (path === '/api/blobs/missing' && method === 'POST') {
    let ids;
    try { ids = JSON.parse((await body(req, 1024 * 1024)).toString('utf8')).ids; }
    catch { return json(res, 400, { error: 'bad request' }); }
    if (!Array.isArray(ids)) return json(res, 400, { error: 'ids must be an array' });
    return json(res, 200, { missing: ids.filter(id => !db.hasBlob(me.id, id)) });
  }

  const blob = /^\/api\/blobs\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (blob) {
    const id = blob[1];
    if (method === 'GET') {
      const row = db.getBlob(me.id, id);
      if (!row) return json(res, 404, { error: 'no such blob' });
      res.writeHead(200, { 'Content-Type': row.type, 'Content-Length': row.bytes.length,
        'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(Buffer.from(row.bytes));
    }
    if (method === 'PUT') {
      if (db.hasBlob(me.id, id)) return json(res, 200, { ok: true, already: true });
      const used = db.usage(me.id).bytes;
      let bytes;
      try { bytes = await body(req, MAX_BLOB); }
      catch { return json(res, 413, { error: 'file too large' }); }
      if (used + bytes.length > QUOTA) return json(res, 507, { error: 'storage full', used, total: QUOTA });
      db.putBlob(me.id, id, req.headers['content-type'] || 'application/octet-stream', bytes);
      return json(res, 200, { ok: true, used: used + bytes.length, total: QUOTA });
    }
  }

  return json(res, 404, { error: 'no such endpoint' });
}

async function auth(req, res, url) {
  const m = /^\/auth\/([a-z]+)\/(start|callback)$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'not found' });
  const [, name, step] = m;
  if (!providers.includes(name)) return text(res, 404, `${name} sign-in is not configured on this server`);

  if (step === 'start') {
    const { url: to, state, verifier } = startURL(name, env, BASE_URL);
    return redirect(res, to, [
      setCookie('oauth_state', `${name}:${state}:${verifier || ''}`, { maxAge: 600 }),
    ]);
  }

  // callback
  const saved = (cookies(req).oauth_state || '').split(':');
  const [savedName, savedState, savedVerifier] = saved;
  const clear = setCookie('oauth_state', '', { clear: true });
  if (url.searchParams.get('error')) return signInFailed(res, url.searchParams.get('error'), clear);
  if (savedName !== name || !savedState || savedState !== url.searchParams.get('state'))
    return signInFailed(res, 'the sign-in link expired — please try again', clear);

  try {
    const profile = await exchange(name, url.searchParams.get('code'), savedVerifier || null, env, BASE_URL);
    const user = db.upsertUser(profile);
    const sid = db.startSession(user.id, SESSION_DAYS * 86400_000);
    return redirect(res, '/#signed-in', [clear, setCookie('sid', sid, { maxAge: SESSION_DAYS * 86400 })]);
  } catch (e) {
    console.error('sign-in failed:', e.message);
    return signInFailed(res, e.message, clear);
  }
}

const signInFailed = (res, why, clear) => {
  res.writeHead(302, { Location: `/#sign-in-error=${encodeURIComponent(why)}`, 'Set-Cookie': clear });
  res.end();
};

/* ---------------- static site ---------------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = join(ROOT, normalize(rel));
  if (!file.startsWith(ROOT) || file.startsWith(join(ROOT, 'server'))) return text(res, 403, 'nope');
  try {
    const info = await stat(file);
    if (info.isDirectory()) return serveStatic(req, res, new URL(rel + '/', 'http://x'));
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // the app is small and edited often; let the browser revalidate
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    text(res, 404, 'Not found');
  }
}

/* ---------------- server ---------------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/auth/')) return await auth(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url);
    text(res, 405, 'Method not allowed');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Trip Planner on ${BASE_URL}  (listening ${HOST}:${PORT})`);
  console.log(`  database  ${DB_FILE}`);
  console.log(`  sign-in   ${providers.length ? providers.join(', ') : 'not configured — the app still works, without sync'}`);
  console.log(`  places    ${PLACES_KEY ? 'Google Places search enabled' : 'not configured — search falls back to OpenStreetMap'}`);
});

/* tiny .env reader: KEY=value lines, # comments, optional quotes */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export { server, db };
