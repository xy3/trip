import { state, mapPlaces, dayRoute, staySpine, days, UNSCHEDULED } from './store.js';
import { catColor } from './categories.js';
import { routeFor } from './geo.js';
import { $, esc, fmtKm, fmtDur, haversine } from './util.js';

let map, layer, routeLayer;
const legListeners = new Set();
/** legs for the focused day, published so the timeline can label them */
export const onLegs = fn => legListeners.add(fn);
const publish = (bucket, legs) => legListeners.forEach(fn => fn(bucket, legs));

export function initMap() {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([48.8566, 2.3522], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  return map;
}

const pinIcon = (label, color, isStay = false) => L.divIcon({
  className: '',
  html: `<div class="pin${isStay ? ' stay' : ''}" style="background:${color}"><span>${esc(label)}</span></div>`,
  iconSize: [26, 26],
  iconAnchor: isStay ? [13, 13] : [13, 24],
  popupAnchor: [0, -22],
});

function popupFor(p, label) {
  return `<b>${esc(p.name)}</b>${label ? ` <span style="opacity:.6">(${esc(label)})</span>` : ''}
    ${p.address ? `<br><span style="opacity:.7">${esc(p.address)}</span>` : ''}
    ${p.notes ? `<br>${esc(p.notes).slice(0, 200)}` : ''}`;
}

let fitPending = true;
export function requestFit() { fitPending = true; }

export function refresh({ fit = false } = {}) {
  if (!map) return;
  layer.clearLayers();
  routeLayer.clearLayers();

  const { route, stays, loose } = mapPlaces();
  const bounds = [];

  route.forEach((p, i) => {
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(String(i + 1), catColor(p.category)) })
      .bindPopup(popupFor(p))
      .on('click', () => { state.activeItem = p.id; highlightCard(p.id); });
    m.addTo(layer);
    bounds.push([p.lat, p.lng]);
    if (state.activeItem === p.id) m.openPopup();
  });

  stays.forEach(s => {
    L.marker([s.lat, s.lng], { icon: pinIcon('🛏', catColor('lodging'), true) })
      .bindPopup(popupFor(s, `${s.checkIn} → ${s.checkOut}`))
      .addTo(layer);
    bounds.push([s.lat, s.lng]);
  });

  loose.forEach(p => {
    L.circleMarker([p.lat, p.lng], {
      radius: 6, color: '#fff', weight: 2, fillColor: catColor(p.category), fillOpacity: .9,
    }).bindPopup(popupFor(p, 'unscheduled')).addTo(layer);
    bounds.push([p.lat, p.lng]);
  });

  drawRoutes();

  if ((fit || fitPending) && bounds.length) {
    fitPending = false;
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
  setTimeout(() => map.invalidateSize(), 0);
}

/* Focused single day gets real road routing; the whole-trip view uses light
   straight lines per day so we don't hammer the public routing service. */
async function drawRoutes() {
  const focus = state.focusDay;
  const summary = $('#routeSummary');

  if (focus && focus !== UNSCHEDULED) {
    const seq = dayRoute(focus);
    line(seq.map(p => [p.lat, p.lng]), true);
    if (seq.length < 2) { summary.hidden = true; publish(focus, []); return; }
    summary.hidden = false;
    summary.textContent = 'Calculating route…';
    const { legs, geometry, estimated } = await routeFor(seq);
    if (state.focusDay !== focus) return;
    if (geometry) { routeLayer.clearLayers(); line(geometry, false); }
    const km = legs.reduce((n, l) => n + l.km, 0);
    const min = legs.reduce((n, l) => n + l.min, 0);
    const beds = seq.filter(p => p.role !== 'stop').length;
    summary.textContent =
      `${estimated ? '\u2248 ' : ''}${fmtKm(km)} \u00b7 ${fmtDur(min)} travel${beds ? ' \u00b7 incl. lodging' : ''}`;
    publish(focus, legs);
    return;
  }

  summary.hidden = true;
  for (const d of days()) line(dayRoute(d).map(p => [p.lat, p.lng]), true);
  if (state.includeStays) spine(staySpine());
}

/* Hotel-to-hotel across the trip, so the shape of the journey is readable
   even when no single day is focused. */
function spine(stays) {
  if (stays.length < 2) return;
  L.polyline(stays.map(s => [s.lat, s.lng]), {
    color: '#9d8bff', weight: 2.5, opacity: .65, dashArray: '1 7',
    lineCap: 'round', lineJoin: 'round',
  }).addTo(routeLayer);
}

function line(latlngs, dashed) {
  if (latlngs.length < 2) return;
  L.polyline(latlngs, {
    color: '#7ab8ff', weight: dashed ? 2 : 4, opacity: dashed ? .5 : .85,
    dashArray: dashed ? '6 6' : null, lineJoin: 'round',
  }).addTo(routeLayer);
}

/* Crow-flies leg estimates, used to label days in the whole-trip view. */
export function estimateLegs(points) {
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const km = haversine(points[i - 1], points[i]);
    legs.push({ km, min: (km / 35) * 60, estimated: true });
  }
  return legs;
}

export function flyTo(p, zoom = 15) {
  if (!map || !Number.isFinite(p.lat)) return;
  map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), zoom), { duration: .6 });
}

export const fitAll = () => { fitPending = true; refresh({ fit: true }); };
export const invalidate = () => map && map.invalidateSize();

/* Where the user is currently looking. Place search leans on this to decide
   between namesakes, so only answer once the view is tighter than continental —
   a world view says nothing about which country is meant. */
export function viewCenter() {
  if (!map || map.getZoom() < 5) return null;
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

function highlightCard(id) {
  document.querySelectorAll('.card.active').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
}

export function renderLegend() {
  const el = $('#mapLegend');
  const used = new Set([
    ...Object.values(state.trip.items).map(i => i.category),
    ...(Object.keys(state.trip.stays).length ? ['lodging'] : []),
  ]);
  if (!used.size) { el.innerHTML = ''; return; }
  import('./categories.js').then(({ CATEGORIES }) => {
    el.innerHTML = [...used]
      .filter(c => CATEGORIES[c])
      .map(c => `<span><i style="background:${CATEGORIES[c].color}"></i>${CATEGORIES[c].label}</span>`)
      .join('');
  });
}
