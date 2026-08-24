/* Keyless geocoding + routing: Nominatim and Photon over OpenStreetMap data,
   geotagged Wikipedia articles, and the OSRM demo server. All of them ask for
   light, non-bulk use — results are cached per session and searches are
   debounced by the caller. */
import { haversine } from './util.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PHOTON = 'https://photon.komoot.io/api/';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const OSRM = 'https://router.project-osrm.org/route/v1';

const searchCache = new Map();
const routeCache = new Map();

/* ---------------- place search ----------------
   One source is never enough. Nominatim is authoritative for addresses but
   matches names strictly, so a ryokan called "Ochiairo" or a park spelled
   "Minoo" in one language and 箕面 in another simply returns nothing. So we
   ask three keyless sources at once and merge them:

     Nominatim  addresses and exact OSM names
     Photon     the same OSM data behind a fuzzy, typo-tolerant index, which
                is what actually finds partial and transliterated names
     Wikipedia  geotagged articles, which cover landmarks and attractions that
                OSM knows only under their local-language name

   Whatever answers first is merged, deduped by position, and re-ranked against
   the query; a source that fails or is slow just contributes nothing. */

const strip = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const tokens = s => strip(s).split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/).filter(t => t.length > 1);
/* "Minoo" should find "Minō" (a macron survives the accent strip as "Mino"),
   so a word also counts as matched when one spelling prefixes the other. */
const hasWord = (words, t) =>
  words.some(w => w === t || (t.length > 3 && w.length > 3 && (w.startsWith(t) || t.startsWith(w))));

export async function searchPlaces(query, { near = null, limit = 8, signal } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = `${q}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ''}`;
  if (searchCache.has(key)) return searchCache.get(key);

  const settled = await Promise.allSettled([
    fromNominatim(q, near, signal),
    fromPhoton(q, near, signal),
    fromWikipedia(q, signal),
  ]);
  const hits = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));
  // only surface an error if every source failed — one flaky endpoint is fine
  if (!hits.length && settled.every(s => s.status === 'rejected')) throw settled[0].reason;

  const out = dedupe(hits.map(h => ({ ...h, score: score(h, q, near) })))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  searchCache.set(key, out);
  return out;
}

async function fromNominatim(q, near, signal) {
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '8', addressdetails: '1', 'accept-language': 'en',
  });
  if (near) {
    const d = 1.2;
    params.set('viewbox', [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(','));
  }
  const res = await fetch(`${NOMINATIM}?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return (await res.json()).map((r, i) => ({
    name: r.name || r.display_name.split(',')[0],
    display: shortAddress(r.display_name, r.name),
    lat: Number(r.lat), lng: Number(r.lon),
    class: r.category || r.class, type: r.type,   // jsonv2 renames class to category
    importance: Number(r.importance) || 0,
    source: 'nominatim', rank: i,
  }));
}

/* Nominatim spells out the whole administrative hierarchy; keep the specific
   end of it plus the country and drop the name it repeats up front. */
function shortAddress(displayName, name) {
  const parts = (displayName || '').split(',').map(x => x.trim()).filter(Boolean);
  if (parts[0] === name) parts.shift();
  return (parts.length > 4 ? [...parts.slice(0, 3), parts[parts.length - 1]] : parts).join(', ');
}

async function fromPhoton(q, near, signal) {
  const params = new URLSearchParams({ q, limit: '10', lang: 'en' });
  if (near) { params.set('lat', String(near.lat)); params.set('lon', String(near.lng)); }
  const res = await fetch(`${PHOTON}?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();
  return (data.features || []).filter(f => f.properties?.name).map((f, i) => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    return {
      name: p.name,
      display: [
        [p.housenumber, p.street].filter(Boolean).join(' '),
        p.district, p.city || p.town || p.village || p.county, p.state, p.country,
      ].filter(Boolean).join(', '),
      lat, lng,
      class: p.osm_key, type: p.osm_value,
      source: 'photon', rank: i,
    };
  });
}

/* Geotagged Wikipedia articles. The search index happily returns loosely
   related pages, so we keep only articles that carry coordinates and share a
   word with the query — enough to drop "Iran" from a search for "Minoo Park"
   while keeping "Meiji no Mori Minō Quasi-National Park". */
async function fromWikipedia(q, signal) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: q, gsrlimit: '8',
    prop: 'coordinates|description', colimit: 'max',
  });
  const res = await fetch(`${WIKI}?${params}`, {
    signal, headers: { 'Api-User-Agent': 'TripPlanner/1.0 (static personal trip planner)' },
  });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const pages = Object.values((await res.json()).query?.pages || {});
  const want = tokens(q);
  return pages
    .filter(p => p.coordinates?.length)
    .filter(p => want.some(t => strip(p.title).includes(t)))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p, i) => ({
      name: p.title,
      display: [p.description, 'Wikipedia'].filter(Boolean).join(' · '),
      lat: p.coordinates[0].lat, lng: p.coordinates[0].lon,
      class: 'wikipedia', type: p.description || '',
      source: 'wiki', rank: i,
    }));
}

/* Anything a traveller would not put on an itinerary; kept in the results but
   pushed below the real places that share the name. */
const JUNK = /motorway_junction|bus_stop|toilets|parking_space|traffic_signals|construction|proposed/;

/* How well a hit answers the query. Name match alone is not enough — "Minoo
   Park" is the exact name of a park in Iran and a loose translation of one of
   Japan's best-known ones — so prominence and place matter as much: how
   important OSM thinks the place is, whether a second source found it too, and
   how close it is to what the map is showing. */
function score(h, q, near) {
  const name = strip(h.name);
  const nq = strip(q);
  let s = 0;
  if (name === nq) s += 3;
  else if (name.startsWith(nq)) s += 2;
  else if (name.includes(nq)) s += 1;

  const want = tokens(q);
  const words = tokens(h.name);
  const got = want.filter(t => hasWord(words, t)).length;
  s += want.length ? 4 * (got / want.length) : 0;
  if (!got) s -= 2;               // matched on address only

  s += 5 * (h.importance || 0);   // Nominatim's own prominence measure
  if (h.source === 'wiki') s += 2.5;  // having an article is prominence too
  s -= 0.15 * (h.rank || 0);
  if (JUNK.test(`${h.class}:${h.type}`)) s -= 2;

  // what the map is looking at is the strongest hint about which "Minoo Park"
  if (near) {
    const km = haversine(near, h);
    s += km < 25 ? 5 : km < 150 ? 3 : km < 800 ? 1.5 : 0;
  }
  return s;
}

/* Two sources describing the same place. Keep the better-scoring one, but
   count the agreement: a place three indexes know about is a real landmark,
   not a namesake. */
function dedupe(hits) {
  const out = [];
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    const km = o => haversine(o, h);
    const a = strip(h.name);
    const twin = out.find(o => {
      const b = strip(o.name);
      return (a === b && km(o) < 0.3) || ((a.includes(b) || b.includes(a)) && km(o) < 0.25);
    });
    if (!twin) { out.push(h); continue; }
    if (!twin.also) twin.also = new Set([twin.source]);
    if (!twin.also.has(h.source)) {
      twin.also.add(h.source);
      twin.score += 1.2;
      twin.importance = Math.max(twin.importance || 0, h.importance || 0);
      if (h.source === 'wiki') twin.score += 1.3;   // corroborated by an article
    }
  }
  return out;
}

/* Straight-line fallback used when routing is unavailable. */
function crowFlies(points) {
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const km = haversine(points[i - 1], points[i]);
    legs.push({ km, min: (km / 35) * 60, estimated: true });
  }
  return { legs, geometry: null, estimated: true };
}

/* Returns { legs:[{km,min,estimated}], geometry:[[lat,lng],…] } for a day's stops. */
export async function routeFor(points, profile = 'driving') {
  if (points.length < 2) return { legs: [], geometry: null };
  const key = profile + '|' + points.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');
  if (routeCache.has(key)) return routeCache.get(key);

  const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
  try {
    const res = await fetch(
      `${OSRM}/${profile}/${coords}?overview=full&geometries=geojson&steps=false`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('no route');
    const out = {
      legs: route.legs.map(l => ({ km: l.distance / 1000, min: l.duration / 60, estimated: false })),
      geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      estimated: false,
    };
    routeCache.set(key, out);
    return out;
  } catch {
    const out = crowFlies(points);
    routeCache.set(key, out);
    return out;
  }
}
