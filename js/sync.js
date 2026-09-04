/* Optional cloud sync.
   ------------------------------------------------------------------
   The app is a static site first: with no server behind it, `probe()` finds no
   /api/me, sync stays switched off and nothing in the UI mentions it. When the
   Node server in server/ is serving the app, signing in with Google turns this
   on and the trip document plus its photo blobs follow you between computers.

   The model is deliberately small:
     · the whole trip document is one value, written wholesale
     · the server hands out a `rev` per save; a push carries the rev it was
       based on, and a mismatch is a conflict rather than a silent overwrite
     · blobs are content-addressed by the id already in the document, so they
       upload once and are never rewritten */
import { state, subscribe, emit, replaceTrip, referencedBlobs, isEmptyTrip } from './store.js';
import * as db from './db.js';

const MARK = id => `trip-planner:sync:${id}`;   // {rev, hash} of what the server last accepted
const PUSH_DELAY = 1400;
const POLL_MS = 120_000;

export const sync = {
  available: false,      // is there a server at all?
  user: null,
  providers: [],
  quota: null,
  status: 'off',         // off | signed-out | idle | syncing | error | conflict
  message: '',
  conflict: null,        // { remote, rev, updatedAt }
};

const announce = () => emit('sync');
function setStatus(status, message = '') {
  sync.status = status;
  sync.message = message;
  announce();
}

/* ---------------- transport ---------------- */
async function call(path, { method = 'GET', body, type, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: type ? { 'Content-Type': type } : undefined,
    body,
  });
  if (res.status === 401) { sync.user = null; setStatus('signed-out'); throw new Error('signed out'); }
  if (raw) {
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status})`);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status}`), { status: res.status, data });
  return data;
}

/* ---------------- what the server last saw ---------------- */
const hashOf = s => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h}:${s.length}`;
};
const docString = () => JSON.stringify(state.trip);
const readMark = id => { try { return JSON.parse(localStorage.getItem(MARK(id))) || null; } catch { return null; } };
const writeMark = (id, rev, hash) => localStorage.setItem(MARK(id), JSON.stringify({ rev, hash }));

/* Has this device changed the trip since the server last accepted it? */
export function isDirty() {
  const mark = readMark(state.trip.id);
  return !mark || mark.hash !== hashOf(docString());
}

/* ---------------- blobs ---------------- */
async function uploadBlobs() {
  const ids = [...referencedBlobs()];
  if (!ids.length) return;
  const { missing } = await call('/api/blobs/missing', {
    method: 'POST', type: 'application/json', body: JSON.stringify({ ids }),
  });
  for (const id of missing) {
    const blob = await db.getBlob(id);
    if (!blob) continue;                       // referenced but gone locally; the doc still carries the id
    await call(`/api/blobs/${id}`, {
      method: 'PUT', raw: true,
      type: blob.type || 'application/octet-stream',
      body: blob,
    });
  }
}

/* Fetch anything the document points at that this device does not have yet. */
async function downloadBlobs() {
  for (const id of referencedBlobs()) {
    if (await db.getBlob(id)) continue;
    try {
      const res = await call(`/api/blobs/${id}`, { raw: true });
      await db.putBlob(id, await res.blob());
    } catch { /* a missing blob must not stop the rest of the sync */ }
  }
}

/* ---------------- pull / push ---------------- */
async function adopt(remote, rev) {
  const incoming = JSON.stringify(remote);
  replaceTrip(remote);
  writeMark(remote.id, rev, hashOf(docString()));
  await downloadBlobs();
  emit('photos');
  // normalize() may have tidied the document as it came in; send that back so
  // the two copies stay byte-identical
  if (docString() !== incoming) await push();
}

export async function push() {
  if (!sync.user || state.readonly) return;
  const trip = state.trip;
  const mark = readMark(trip.id);
  setStatus('syncing');
  try {
    await uploadBlobs();
    const snapshot = docString();               // hash exactly what we send
    const saved = await call('/api/trip', {
      method: 'PUT', type: 'application/json',
      body: JSON.stringify({ baseRev: mark?.rev || 0, trip: JSON.parse(snapshot) }),
    });
    writeMark(trip.id, saved.rev, hashOf(snapshot));
    sync.conflict = null;
    setStatus('idle');
  } catch (e) {
    if (e.status === 409) return conflict(e.data);
    if (e.status === 507) return setStatus('error', 'Cloud storage is full — remove some photos.');
    if (e.message !== 'signed out') setStatus('error', e.message);
  }
}

/* The server moved on without us. If this device has no unsent edits the
   remote copy simply wins; otherwise it is a real fork and the user chooses. */
async function conflict(data) {
  if (!isDirty()) {
    await adopt(data.trip, data.rev);
    return setStatus('idle');
  }
  sync.conflict = { remote: data.trip, rev: data.rev, updatedAt: data.updatedAt };
  setStatus('conflict', 'This trip was also changed on another device.');
}

export async function resolveConflict(keep) {
  const c = sync.conflict;
  if (!c) return;
  sync.conflict = null;
  if (keep === 'remote') {
    await adopt(c.remote, c.rev);
    return setStatus('idle');
  }
  writeMark(state.trip.id, c.rev, '');          // adopt their rev, keep our document
  await push();
}

export async function pull() {
  if (!sync.user) return;
  setStatus('syncing');
  try {
    const mine = await call(`/api/trip?id=${encodeURIComponent(state.trip.id)}`);
    if (mine.trip) {
      const mark = readMark(state.trip.id);
      if (mark && mine.rev === mark.rev) {
        // the document itself hasn't moved, but a photo can still be missing
        // locally (cleared site data, a gc bug, browser storage eviction) while
        // the server still has it — worth a cheap check every time
        await downloadBlobs().catch(() => {});
        emit('photos');
        return setStatus('idle');
      }
      if (isDirty()) return conflict(mine);
      await adopt(mine.trip, mine.rev);
      return setStatus('idle');
    }

    // this device's trip is unknown to the account
    const newest = await call('/api/trip');
    if (newest.trip && isEmptyTrip(state.trip)) {
      await adopt(newest.trip, newest.rev);
      return setStatus('idle');
    }
    if (newest.trip) {
      sync.conflict = { remote: newest.trip, rev: newest.rev, updatedAt: newest.updatedAt, other: true };
      return setStatus('conflict', 'This account already has a saved trip.');
    }
    await push();                                // first device: seed the account
  } catch (e) {
    if (e.message !== 'signed out') setStatus('error', e.message);
  }
}

/* ---------------- lifecycle ---------------- */
export const signIn = provider => { location.href = `/auth/${provider}/start`; };

export async function signOut() {
  try { await call('/api/signout', { method: 'POST' }); } catch { /* already gone */ }
  sync.user = null;
  sync.quota = null;
  setStatus('signed-out');
}

let queued;
const schedulePush = () => {
  clearTimeout(queued);
  queued = setTimeout(() => { if (isDirty()) push(); }, PUSH_DELAY);
};

export async function probe() {
  let me;
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
    me = await res.json();
  } catch {
    return;                                     // static hosting: no sync, no UI
  }
  sync.available = true;
  sync.providers = me.providers || [];
  sync.user = me.user || null;
  sync.quota = me.quota || null;
  setStatus(sync.user ? 'idle' : 'signed-out');

  if (!sync.user) return;
  await pull();

  subscribe(reason => { if (reason !== 'sync' && !state.readonly) schedulePush(); });
  addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(refresh, POLL_MS);
}

/* Cheap catch-up: push what we owe, otherwise look for another device's work. */
function refresh() {
  if (!sync.user || sync.status === 'syncing' || sync.status === 'conflict') return;
  isDirty() ? push() : pull();
}

export const syncNow = () => (isDirty() ? push() : pull());

/* Publish the current trip at a stable, public read-only URL. Requires an
   account: the link is just a token pointing at what's already saved
   server-side, which is what lets photos ride as ordinary images instead of
   being crammed into the link itself. Pushes first so the token always
   reflects what's on screen, not whatever the server last happened to have. */
export async function shareTrip() {
  if (!sync.user) return null;
  await push();                                   // push() swallows its own errors — check the outcome
  if (sync.conflict) throw new Error('resolve the sync conflict before sharing');
  if (sync.status === 'error') throw new Error(sync.message || 'could not save the trip before sharing');
  const { token } = await call('/api/share', {
    method: 'POST', type: 'application/json', body: JSON.stringify({ tripId: state.trip.id }),
  });
  return token;
}
