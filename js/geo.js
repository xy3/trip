/* Keyless geocoding + routing: Nominatim (OpenStreetMap) and OSRM demo server.
   Both ask for light, non-bulk use — results are cached per session and
   searches are debounced by the caller. */
import { haversine } from './util.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1';

const searchCache = new Map();
const routeCache = new Map();

export async function searchPlaces(query, { near = null, limit = 8, signal } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = `${q}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
  if (searchCache.has(key)) return searchCache.get(key);

  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: String(limit), addressdetails: '1',
  });
  if (near) {
    const d = 1.2;
    params.set('viewbox', [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(','));
  }
  const res = await fetch(`${NOMINATIM}?${params}`, {
    signal, headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const raw = await res.json();

  const out = raw.map(r => ({
    name: r.name || r.display_name.split(',')[0],
    display: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
    class: r.class,
    type: r.type,
  }));
  searchCache.set(key, out);
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
