/* Representative photo lookup, keyless: Wikipedia's API (CORS-enabled, and
   the images it points at on upload.wikimedia.org are too). We ask for a
   large thumbnail rather than the original file so a place does not drag a
   20 MB TIFF into IndexedDB. */
import { haversine } from './util.js';

const API = 'https://en.wikipedia.org/w/api.php';
const WIDTH = 1600;
const NEARBY_M = 250;   // how close an unrelated page must be to stand in as scenery

const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').trim();

/* Wikimedia asks API clients to identify themselves; browsers cannot set
   User-Agent, so Api-User-Agent is the sanctioned stand-in. It goes on api.php
   requests ONLY: upload.wikimedia.org does not list it in
   Access-Control-Allow-Headers, so sending it there turns a simple image GET
   into a preflight that the image host rejects. */
const UA = { 'Api-User-Agent': 'TripPlanner/1.0 (static personal trip planner)' };

const call = async params => {
  const url = `${API}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  const data = await res.json();
  return Object.values(data.query?.pages || {})
    .filter(p => p.thumbnail?.source)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
};

/* Pages near the coordinates, closest first, carrying their distance in metres. */
const byLocation = (lat, lng) => call({
  generator: 'geosearch', ggscoord: `${lat}|${lng}`, ggsradius: '1000', ggslimit: '10',
  prop: 'pageimages|coordinates', piprop: 'thumbnail', pithumbsize: String(WIDTH),
});
/* geosearch does not report distance when used as a generator, so measure it */
const metresFrom = (origin, p) => {
  const c = p.coordinates?.[0];
  return c ? haversine(origin, { lat: c.lat, lng: c.lon }) * 1000 : Infinity;
};

/* Pages matching the name, best match first. */
const byName = name => call({
  generator: 'search', gsrsearch: name, gsrlimit: '5',
  prop: 'pageimages', piprop: 'thumbnail', pithumbsize: String(WIDTH),
});

/* A page whose title actually looks like the place beats a merely nearby one —
   otherwise "Louvre" picks up the Regent Diamond, which happens to sit inside it. */
const matches = (title, name) => {
  const t = norm(title), w = norm(name);
  if (!t || !w || t.length < 4) return false;
  return t === w || t.includes(w) || w.includes(t);
};

const pick = (pages, name) => pages.find(p => matches(p.title, name)) || null;

/**
 * Best-effort photo for a place.
 * @returns {Promise<{blob:Blob, caption:string, source:string}|null>}
 */
export async function findPhoto({ name, lat, lng }, { signal } = {}) {
  let page = null;
  const origin = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  try {
    if (origin) {
      const near = await byLocation(lat, lng);
      // a page named after the place wins anywhere in the radius; otherwise
      // only something practically on the spot can stand in as scenery
      page = pick(near, name)
        || near.map(p => [metresFrom(origin, p), p])
             .filter(([m]) => m <= NEARBY_M)
             .sort((a, b) => a[0] - b[0])
             .map(([, p]) => p)[0]
        || null;
    }
    // a name hit beats a merely nearby page; never accept an unrelated title
    if (name && !(page && matches(page.title, name))) {
      const named = pick(await byName(name), name);
      if (named) page = named;
    }
    if (!page) return null;

    const res = await fetch(page.thumbnail.source, { signal });   // no custom headers: keep it a simple request
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;

    const nearby = !matches(page.title, name);
    return {
      blob,
      nearby,
      caption: `${page.title}${nearby ? ' · nearby' : ''} · Wikipedia`,
      source: `https://en.wikipedia.org/?curid=${page.pageid}`,
    };
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('No photo found for', name, e);
    return null;
  }
}
