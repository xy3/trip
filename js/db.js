/* Binary side-store: photos and attachments live in IndexedDB, keyed by id.
   The trip document only carries the ids, so localStorage stays small. */
const DB_NAME = 'trip-planner';
const STORE = 'blobs';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    out = fn(store);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}

export const putBlob = (id, blob) => tx('readwrite', s => s.put(blob, id));
export const getBlob = id => tx('readonly', s => s.get(id));
export const delBlob = id => tx('readwrite', s => s.delete(id));
export const allKeys = () => tx('readonly', s => s.getAllKeys());

/* Object URLs are cached so repeated renders don't leak. */
const urls = new Map();
export async function blobURL(id) {
  if (urls.has(id)) return urls.get(id);
  const b = await getBlob(id);
  if (!b) return null;
  const url = URL.createObjectURL(b);
  urls.set(id, url);
  return url;
}
export function forgetURL(id) {
  const u = urls.get(id);
  if (u) { URL.revokeObjectURL(u); urls.delete(id); }
}

/* Drop blobs no longer referenced by the trip document. */
export async function gc(referenced) {
  const keys = await allKeys();
  await Promise.all(keys.filter(k => !referenced.has(k)).map(k => { forgetURL(k); return delBlob(k); }));
}
