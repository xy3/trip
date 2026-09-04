/* Two kinds of share link.
   ------------------------------------------------------------------
   Signed in, with a server behind the app: Share pushes the trip and asks
   for a token (js/sync.js `shareTrip`), and the link is just that token —
   `#s=<token>`. Photos are never encoded into it at all; they're ordinary
   images at their own server URL (GET /api/shares/:token/photos/:id), fetched
   the normal way when the page loads. That's what makes this the good path:
   no size limit, no downscaling, no base64 bloat.

   No server, or not signed in: the whole itinerary is deflate-compressed and
   base64url-encoded straight into the URL fragment, so the app stays usable
   as a static site with nothing to upload. Photos and file attachments are
   left out here — there is no server to host them, and embedding binaries
   in a URL is exactly what the token path above exists to avoid. Use
   export/import for a `.trip.json` file with everything, full quality. */
import { state, referencedBlobs } from './store.js';
import * as db from './db.js';
import * as cloud from './sync.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = str => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

async function squeeze(stream, bytes) {
  const cs = new stream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/* Trimmed copy for the fragment path: no binaries, no attachments. */
function shareableTrip() {
  const t = JSON.parse(JSON.stringify(state.trip));
  t.photos = {};
  for (const o of [...Object.values(t.items), ...Object.values(t.stays)]) o.files = [];
  return t;
}

export async function buildShareLink() {
  const base = location.href.split('#')[0];

  let shareError = null;
  if (cloud.sync.user) {
    try {
      const token = await cloud.shareTrip();
      return { url: `${base}#s=${token}`, photosIncluded: true };
    } catch (e) {
      shareError = e.message;   // fall through to the lighter link below
    }
  }

  // no account, or the server call above failed: a lighter link with no photos
  const json = JSON.stringify(shareableTrip());
  let payload;
  if (typeof CompressionStream === 'function') {
    payload = 'z' + b64(await squeeze(CompressionStream, enc.encode(json)));
  } else {
    payload = 'j' + b64(enc.encode(json));
  }
  return { url: `${base}#t=${payload}`, photosIncluded: false, error: shareError };
}

export async function tripFromHash(hash = location.hash) {
  const s = /[#&]s=([^&]+)/.exec(hash);
  if (s) {
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(s[1])}`, { credentials: 'same-origin' });
      return res.ok ? (await res.json()).trip : null;
    } catch (e) {
      console.warn('Could not load shared trip', e);
      return null;
    }
  }

  const m = /[#&]t=([^&]+)/.exec(hash);
  if (!m) return null;
  try {
    const raw = m[1];
    const bytes = unb64(raw.slice(1));
    let json;
    if (raw[0] === 'z') {
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter();
      w.write(bytes); w.close();
      json = dec.decode(await new Response(ds.readable).arrayBuffer());
    } else {
      json = dec.decode(bytes);
    }
    return JSON.parse(json);
  } catch (e) {
    console.warn('Bad share link', e);
    return null;
  }
}

/* ---------------- file export / import (includes photos & attachments) --------------- */
export async function exportBundle() {
  const trip = JSON.parse(JSON.stringify(state.trip));
  const blobs = {};
  for (const id of referencedBlobs()) {
    const blob = await db.getBlob(id);
    if (!blob) continue;
    blobs[id] = {
      type: blob.type || 'application/octet-stream',
      data: b64(new Uint8Array(await blob.arrayBuffer())),
    };
  }
  return new Blob([JSON.stringify({ format: 'trip-planner', v: 1, trip, blobs }, null, 2)],
    { type: 'application/json' });
}

export async function importBundle(file) {
  const data = JSON.parse(await file.text());
  const trip = data.trip || data;            // accept a bare trip document too
  for (const [id, b] of Object.entries(data.blobs || {}))
    await db.putBlob(id, new Blob([unb64(b.data)], { type: b.type }));
  return trip;
}
