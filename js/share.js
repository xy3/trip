/* Read-only share links carry the whole itinerary in the URL fragment, so the
   app stays a static site — nothing is uploaded anywhere. Photos and file
   attachments are left out (they live in the author's browser); export/import
   of a .trip.json file carries everything. */
import { state, referencedBlobs } from './store.js';
import * as db from './db.js';

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

/* Trimmed copy: no binaries, no UI-only state. */
function shareableTrip() {
  const t = JSON.parse(JSON.stringify(state.trip));
  t.photos = {};
  for (const o of [...Object.values(t.items), ...Object.values(t.stays)]) o.files = [];
  return t;
}

export async function buildShareLink() {
  const json = JSON.stringify(shareableTrip());
  let payload;
  if (typeof CompressionStream === 'function') {
    payload = 'z' + b64(await squeeze(CompressionStream, enc.encode(json)));
  } else {
    payload = 'j' + b64(enc.encode(json));
  }
  const base = location.href.split('#')[0];
  return `${base}#t=${payload}`;
}

export async function tripFromHash(hash = location.hash) {
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
