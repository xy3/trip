/* End-to-end sync: two browsers, one account, a real server and a real SQLite
   database. Google's consent screen is the only thing stubbed — the OAuth
   redirects, the session cookie, the trip document and the photo blobs are all
   the real code paths.

   Needs a browser, which the repo does not depend on. Install one first:

     npm i playwright-core && npx playwright install chromium
     node test/sync.e2e.mjs

   Set CHROMIUM_PATH to point at a browser binary playwright did not install.

   Without it the test reports itself as skipped rather than failing. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch {
  console.log('sync (end to end)\n  – skipped: playwright-core is not installed');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'trip-e2e-'));
process.env.DB_FILE = join(dir, 'e2e.db');
process.env.PORT = '0';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

/* --- stand in for Google --- */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token'))
    return new Response(JSON.stringify({ access_token: 'at' }), { headers: { 'Content-Type': 'application/json' } });
  if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo'))
    return new Response(JSON.stringify({ sub: 'g-1', email: 'traveller@example.com', name: 'Ada Traveller' }),
      { headers: { 'Content-Type': 'application/json' } });
  return realFetch(url, opts);
};

const { server } = await import('../server/main.js');
await new Promise(r => (server.listening ? r() : server.once('listening', r)));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ok = [], bad = [];
const check = (name, cond) => { (cond ? ok : bad).push(name); console.log(`  ${cond ? '✓' : '✗'} ${name}`); };

let browser;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
} catch (e) {
  console.log(`sync (end to end)\n  – skipped: no browser to launch (${e.message.split('\n')[0]})`);
  server.close(); rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
console.log('sync (end to end)');

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => { bad.push('page error: ' + e.message); console.log('  ✗ page error: ' + e.message); });
  await p.goto(BASE);
  await p.waitForTimeout(900);
  return { ctx, p };
}

/* The context's request client shares the browser's cookie jar, so walking the
   two redirects through it lands a real session cookie in the page. */
async function signIn({ ctx, p }) {
  await ctx.request.get(`${BASE}/auth/google/start`, { maxRedirects: 0 });
  const state = decodeURIComponent((await ctx.cookies()).find(c => c.name === 'oauth_state').value).split(':')[1];
  await ctx.request.get(`${BASE}/auth/google/callback?code=abc&state=${state}`, { maxRedirects: 0 });
  await p.reload();
  await p.waitForTimeout(2500);
}

const status = p => p.evaluate(async () => {
  const { sync } = await import('/js/sync.js');
  return { status: sync.status, user: sync.user?.email || null, conflict: !!sync.conflict };
});
const summary = p => p.evaluate(async () => {
  const { state } = await import('/js/store.js');
  const db = await import('/js/db.js');
  const t = state.trip;
  const ids = Object.values(t.photos).flat().map(x => x.id);
  let blobs = 0;
  for (const id of ids) if ((await db.getBlob(id)) instanceof Blob) blobs++;
  return { id: t.id, title: t.title, items: Object.values(t.items).map(i => i.name).sort(),
    stays: Object.values(t.stays).map(s => s.name), photos: ids.length, blobs };
});

/* ---------- one laptop plans a trip, then signs in ---------- */
const A = await device();
check('the account button appears when a server is present', await A.p.isVisible('#btnAccount'));
check('nothing is signed in yet', (await status(A.p)).status === 'signed-out');

await A.p.route('**/auth/google/start', r => r.abort());
await A.p.click('#btnAccount');
const [started] = await Promise.all([
  A.p.waitForRequest('**/auth/google/start', { timeout: 5000 }).catch(() => null),
  A.p.click('[data-signin="google"]'),
]);
check('the Google button starts the OAuth flow', !!started);
await A.p.unroute('**/auth/google/start');
await A.p.goto(BASE);
await A.p.waitForTimeout(700);

await A.p.evaluate(async () => {
  const store = await import('/js/store.js');
  const db = await import('/js/db.js');
  const { uid } = await import('/js/util.js');
  store.setTripField('title', 'Kansai in November');
  store.setTripField('startDate', '2026-11-08');
  store.setTripField('endDate', '2026-11-10');
  store.addItem({ name: 'Gio Temple', lat: 35.0136, lng: 135.6666, category: 'sightseeing', cost: 300 }, '2026-11-08');
  store.addStay({ name: 'Hotel Kanra', lat: 34.9963, lng: 135.7595, checkIn: '2026-11-08', checkOut: '2026-11-10' });
  const canvas = new OffscreenCanvas(600, 400);
  canvas.getContext('2d').fillRect(0, 0, 600, 400);
  const id = uid();
  await db.putBlob(id, await canvas.convertToBlob({ type: 'image/png' }));
  store.addPhoto('2026-11-08', id, 'momiji');
});
await A.p.waitForTimeout(400);
await signIn(A);

check('signed in', (await status(A.p)).user === 'traveller@example.com');
check('the first device pushes and settles', (await status(A.p)).status === 'idle');
const first = await summary(A.p);
check('and keeps the trip it already had', first.title === 'Kansai in November' && first.photos === 1);

/* ---------- a different computer, same account ---------- */
const B = await device();
check('a fresh browser starts empty', !(await summary(B.p)).title);
await signIn(B);
const got = await summary(B.p);
check('the trip arrives on the second device', got.title === 'Kansai in November' && got.id === first.id);
check('with its activity and its stay', got.items.join() === 'Gio Temple' && got.stays.join() === 'Hotel Kanra');
check('and the photo blob is downloaded, not just referenced', got.photos === 1 && got.blobs === 1);
check('the photo really renders', await B.p.evaluate(() => {
  const img = document.querySelector('.gallery img');
  return !!img && img.naturalWidth === 600;
}));

/* ---------- an edit on one device reaches the other ---------- */
await B.p.evaluate(async () => (await import('/js/store.js'))
  .addItem({ name: 'Nishiki Market', lat: 35.005, lng: 135.7649, category: 'food' }, '2026-11-09'));
await B.p.waitForTimeout(3000);
await A.p.evaluate(async () => (await import('/js/sync.js')).syncNow());
await A.p.waitForTimeout(2500);
check('an edit made elsewhere comes back', (await summary(A.p)).items.join() === 'Gio Temple,Nishiki Market');

/* ---------- simultaneous edits fork, and the user chooses ---------- */
await A.p.evaluate(async () => (await import('/js/store.js')).setTripField('title', 'Kansai — laptop'));
await B.p.evaluate(async () => (await import('/js/store.js')).setTripField('title', 'Kansai — desktop'));
await A.p.waitForTimeout(4000);
await B.p.waitForTimeout(4000);

const [sa, sb] = [await status(A.p), await status(B.p)];
check('exactly one device reports a conflict', (sa.status === 'conflict') !== (sb.status === 'conflict'));
const loser = sa.status === 'conflict' ? A : B;
const winner = loser === A ? B : A;
check('the device that won the race is unaffected', (loser === A ? sb : sa).status === 'idle');
check('the other one shows the conflict banner', await loser.p.isVisible('#conflictBanner'));

const mine = (await summary(loser.p)).title;
await loser.p.click('#btnKeepLocal');
await loser.p.waitForTimeout(3000);
check('keeping the local copy clears the conflict', (await status(loser.p)).status === 'idle'
  && !(await loser.p.isVisible('#conflictBanner')));
await winner.p.evaluate(async () => (await import('/js/sync.js')).syncNow());
await winner.p.waitForTimeout(3000);
check('and the kept copy reaches the other device', (await summary(winner.p)).title === mine);

await A.p.evaluate(async () => (await import('/js/store.js')).setTripField('title', 'A again'));
await B.p.evaluate(async () => (await import('/js/store.js')).setTripField('title', 'B again'));
await A.p.waitForTimeout(4000);
await B.p.waitForTimeout(4000);
const loser2 = (await status(A.p)).status === 'conflict' ? A : B;
const theirs = await (loser2 === A ? B : A).p.evaluate(async () => (await import('/js/store.js')).state.trip.title);
await loser2.p.click('#btnKeepRemote');
await loser2.p.waitForTimeout(3000);
check('taking the saved copy instead replaces the local one', (await summary(loser2.p)).title === theirs);

/* ---------- signing out leaves the browser's copy alone ---------- */
const before = (await summary(A.p)).title;
await A.p.evaluate(async () => (await import('/js/sync.js')).signOut());
await A.p.waitForTimeout(700);
check('sign-out returns to the signed-out state', (await status(A.p)).status === 'signed-out');
await A.p.reload();
await A.p.waitForTimeout(1200);
check('and the trip is still there afterwards', (await summary(A.p)).title === before);

await browser.close();
server.close();
rmSync(dir, { recursive: true, force: true });
console.log(bad.length ? `\n${bad.length} of ${ok.length + bad.length} end-to-end checks FAILED` : `\nall ${ok.length} end-to-end checks passed`);
process.exit(bad.length ? 1 : 0);
