import { uid, dateRange, todayKey, addDays, fromKey, dayCount } from './util.js';
import * as db from './db.js';

const KEY = 'trip-planner:v1';
const VERSION = 1;

export const UNSCHEDULED = 'unscheduled';
export const OVERVIEW = 'overview';   // synthetic bucket id: the collapsible summary card

export function blankTrip() {
  const start = todayKey();
  return {
    v: VERSION,
    id: uid(),
    title: '',
    currency: 'USD',
    startDate: start,
    endDate: addDays(start, 4),
    items: {},
    stays: {},
    order: { [UNSCHEDULED]: [] },
    photos: {},
    collapsed: {},
    groups: [],
  };
}

export const state = {
  trip: blankTrip(),
  focusDay: null,        // null = whole trip
  readonly: false,
  activeItem: null,      // id highlighted on the map
  includeStays: localStorage.getItem('trip-planner:stays-in-route') !== '0',
  autoPhoto: localStorage.getItem('trip-planner:auto-photo') !== '0',
};

export function setAutoPhoto(on) {
  state.autoPhoto = on;
  localStorage.setItem('trip-planner:auto-photo', on ? '1' : '0');
  emit('auto-photo');
}

export function setIncludeStays(on) {
  state.includeStays = on;
  localStorage.setItem('trip-planner:stays-in-route', on ? '1' : '0');
  emit('route-mode');
}

const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function emit(reason = 'change') { listeners.forEach(fn => fn(reason)); }

/* ---------------- persistence ---------------- */
export function save() {
  if (state.readonly) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state.trip));
  } catch (e) {
    console.warn('Could not persist trip', e);
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state.trip = migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('Stored trip was unreadable; starting fresh.', e);
  }
  normalize();
  return state.trip;
}

/* Nothing planned yet: used to decide whether a signed-in account's saved trip
   can simply replace what is in this browser. */
export function isEmptyTrip(t = state.trip) {
  return !t.title
    && !Object.keys(t.items || {}).length
    && !Object.keys(t.stays || {}).length
    && !Object.values(t.photos || {}).some(list => list?.length);
}

export function replaceTrip(trip, { readonly = false } = {}) {
  state.trip = migrate(trip);
  state.readonly = readonly;
  state.focusDay = null;
  normalize();
  save();
  emit('replace');
}

function migrate(t) {
  const base = blankTrip();
  const trip = { ...base, ...t };
  trip.items = trip.items || {};
  trip.stays = trip.stays || {};
  trip.order = trip.order || {};
  trip.photos = trip.photos || {};
  trip.collapsed = trip.collapsed || {};
  trip.groups = trip.groups || [];
  return trip;
}

/* Keep `order` consistent with the date range: create buckets for every day,
   and push activities from removed days back into the scratchpad. */
export function normalize() {
  const t = state.trip;
  const days = dateRange(t.startDate, t.endDate);
  const valid = new Set([UNSCHEDULED, ...days]);

  t.order[UNSCHEDULED] = t.order[UNSCHEDULED] || [];
  for (const d of days) t.order[d] = t.order[d] || [];

  for (const bucket of Object.keys(t.order)) {
    if (!valid.has(bucket)) {
      t.order[UNSCHEDULED].push(...t.order[bucket]);
      delete t.order[bucket];
    }
  }
  // drop ids with no item, and de-duplicate
  const seen = new Set();
  for (const bucket of Object.keys(t.order)) {
    t.order[bucket] = t.order[bucket].filter(id => {
      if (!t.items[id] || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  // orphan items (present in items but no bucket) go to the scratchpad
  for (const id of Object.keys(t.items)) if (!seen.has(id)) t.order[UNSCHEDULED].push(id);

  // day groups: drop ones the range no longer touches at all, and pull the
  // rest back inside it so a group can never point at a day that doesn't exist
  if (days.length) {
    const first = days[0], last = days[days.length - 1];
    t.groups = (t.groups || [])
      .filter(g => g.end >= first && g.start <= last)
      .map(g => ({ ...g, start: g.start < first ? first : g.start, end: g.end > last ? last : g.end }));
  } else {
    t.groups = [];
  }
}

export const days = () => dateRange(state.trip.startDate, state.trip.endDate);

/* ---------------- queries ---------------- */
export const itemsIn = bucket => (state.trip.order[bucket] || []).map(id => state.trip.items[id]).filter(Boolean);

export const bucketOf = id =>
  Object.keys(state.trip.order).find(b => state.trip.order[b].includes(id)) || null;

export function staysOn(dayKey) {
  return Object.values(state.trip.stays)
    .filter(s => s.checkIn && s.checkOut && dayKey >= s.checkIn && dayKey <= s.checkOut)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
}

export const dayCost = dayKey =>
  itemsIn(dayKey).reduce((n, i) => n + (Number(i.cost) || 0), 0) +
  Object.values(state.trip.stays)
    .filter(s => s.checkIn === dayKey)
    .reduce((n, s) => n + (Number(s.cost) || 0), 0);

export const tripCost = () =>
  Object.values(state.trip.items).reduce((n, i) => n + (Number(i.cost) || 0), 0) +
  Object.values(state.trip.stays).reduce((n, s) => n + (Number(s.cost) || 0), 0);

const hasCoords = p => Number.isFinite(p.lat) && Number.isFinite(p.lng);

/* The day as actually travelled: out of the bed you woke in, through the
   stops, into the bed you sleep in. On a check-in day there is no morning
   stay; on a check-out day there is no evening one; a transition day runs
   from one hotel to the next. */
export function dayRoute(dayKey) {
  const stops = itemsIn(dayKey).filter(hasCoords).map(p => ({ ...p, role: 'stop' }));
  if (!state.includeStays) return stops;

  const covering = staysOn(dayKey).filter(hasCoords);
  const morning = covering.find(s => s.checkIn < dayKey);
  const evening = covering.find(s => s.checkOut > dayKey);

  const seq = [];
  if (morning) seq.push({ ...morning, role: 'from-stay' });
  seq.push(...stops);
  if (evening) seq.push({ ...evening, role: 'to-stay' });

  // sleeping in the same place with nothing planned is not a journey
  if (seq.length === 2 && morning && evening && morning.id === evening.id) return [];
  return seq;
}

/* The lodging spine: hotel to hotel across the whole trip. */
export function staySpine() {
  return Object.values(state.trip.stays)
    .filter(hasCoords)
    .sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''))
    .filter((s, i, arr) => i === 0 || s.id !== arr[i - 1].id);
}

/* All places to show for the current view, in order. */
export function mapPlaces() {
  const t = state.trip;
  const has = p => Number.isFinite(p.lat) && Number.isFinite(p.lng);
  if (state.focusDay && state.focusDay !== UNSCHEDULED) {
    return {
      route: itemsIn(state.focusDay).filter(has),
      stays: staysOn(state.focusDay).filter(has),
      loose: [],
    };
  }
  if (state.focusDay === UNSCHEDULED) {
    return { route: [], stays: [], loose: itemsIn(UNSCHEDULED).filter(has) };
  }
  return {
    route: days().flatMap(d => itemsIn(d)).filter(has),
    stays: Object.values(t.stays).filter(has),
    loose: itemsIn(UNSCHEDULED).filter(has),
  };
}

/* ---------------- mutations ---------------- */
export function setTripField(field, value) {
  state.trip[field] = value;
  if (field === 'startDate' || field === 'endDate') {
    const t = state.trip;
    if (t.startDate && t.endDate && fromKey(t.endDate) < fromKey(t.startDate)) {
      if (field === 'startDate') t.endDate = t.startDate; else t.startDate = t.endDate;
    }
    normalize();
  }
  save();
  emit(field === 'title' ? 'title' : 'dates');
}

export function addItem(data, bucket = UNSCHEDULED, index = -1) {
  const item = {
    id: uid(), name: 'New place', address: '', lat: null, lng: null,
    category: 'other', cost: null, notes: '', links: [], files: [], ...data,
  };
  state.trip.items[item.id] = item;
  const list = state.trip.order[bucket] || (state.trip.order[bucket] = []);
  if (index < 0 || index > list.length) list.push(item.id); else list.splice(index, 0, item.id);
  save(); emit('items');
  return item;
}

export function updateItem(id, patch) {
  const it = state.trip.items[id] || state.trip.stays[id];
  if (!it) return;
  Object.assign(it, patch);
  save(); emit('items');
}

export async function removeItem(id) {
  const t = state.trip;
  const target = t.items[id] || t.stays[id];
  if (!target) return;
  for (const f of target.files || []) await db.delBlob(f.id).catch(() => {});
  for (const p of t.photos[id] || []) await db.delBlob(p.id).catch(() => {});
  delete t.photos[id];
  delete t.items[id];
  delete t.stays[id];
  for (const b of Object.keys(t.order)) t.order[b] = t.order[b].filter(x => x !== id);
  if (state.activeItem === id) state.activeItem = null;
  save(); emit('items');
}

export function moveItem(id, toBucket, toIndex) {
  const t = state.trip;
  if (!t.items[id]) return;
  for (const b of Object.keys(t.order)) {
    const i = t.order[b].indexOf(id);
    if (i >= 0) {
      t.order[b].splice(i, 1);
      if (b === toBucket && i < toIndex) toIndex--;
    }
  }
  const list = t.order[toBucket] || (t.order[toBucket] = []);
  const idx = toIndex == null || toIndex < 0 || toIndex > list.length ? list.length : toIndex;
  list.splice(idx, 0, id);
  save(); emit('items');
}

export function addStay(data) {
  const stay = {
    id: uid(), name: 'Accommodation', address: '', lat: null, lng: null,
    category: 'lodging', cost: null, notes: '', links: [], files: [],
    checkIn: state.trip.startDate, checkOut: addDays(state.trip.startDate, 1), ...data,
  };
  state.trip.stays[stay.id] = stay;
  save(); emit('items');
  return stay;
}

/* Promote a searched place into the accommodation for a day: it leaves the
   activity list and becomes a stay block spanning check-in → check-out. */
export function convertToStay(id, dayKey) {
  const t = state.trip;
  const it = t.items[id];
  if (!it) return null;
  const from = bucketOf(id);
  const day = dayKey || (from && from !== UNSCHEDULED ? from : t.startDate);
  const stay = {
    ...it, id: uid(), category: 'lodging',
    checkIn: day, checkOut: clampDay(addDays(day, 1)),
  };
  delete t.items[id];
  for (const b of Object.keys(t.order)) t.order[b] = t.order[b].filter(x => x !== id);
  if (t.photos[id]) { t.photos[stay.id] = t.photos[id]; delete t.photos[id]; }
  t.stays[stay.id] = stay;
  save(); emit('items');
  return stay;
}

/* Shift a whole stay so it now checks in on `dayKey`, keeping its length. */
export function moveStay(id, dayKey) {
  const s = state.trip.stays[id];
  if (!s || !dayKey) return;
  const nights = Math.max(1, dayCount(s.checkIn, s.checkOut) - 1);
  s.checkIn = dayKey;
  s.checkOut = clampDay(addDays(dayKey, nights));
  save(); emit('items');
}

export function addStayNights(id, delta) {
  const s = state.trip.stays[id];
  if (!s) return;
  const nights = Math.max(1, dayCount(s.checkIn, s.checkOut) - 1 + delta);
  s.checkOut = clampDay(addDays(s.checkIn, nights));
  save(); emit('items');
}

/* keep a date inside the trip so a stay can never fall off the timeline */
const clampDay = k => (state.trip.endDate && k > state.trip.endDate ? state.trip.endDate : k);

export const isStay = id => !!state.trip.stays[id];
export const getAny = id => state.trip.items[id] || state.trip.stays[id] || null;

/* ---------------- photos ---------------- */
export function photosOf(bucket) { return state.trip.photos[bucket] || []; }

export function addPhoto(bucket, blobId, caption = '', source = '') {
  (state.trip.photos[bucket] || (state.trip.photos[bucket] = [])).push({ id: blobId, caption, source });
  save(); emit('photos');
}

export async function removePhoto(bucket, blobId) {
  state.trip.photos[bucket] = photosOf(bucket).filter(p => p.id !== blobId);
  await db.delBlob(blobId).catch(() => {});
  db.forgetURL(blobId);
  save(); emit('photos');
}

/* Aspect ratio, learned the first time a photo paints. It only feeds layout,
   so it is persisted without an emit: the caller retunes the gallery in place
   rather than re-rendering the timeline under the user's scroll position. */
export function setPhotoRatio(bucket, blobId, r) {
  const p = photosOf(bucket).find(x => x.id === blobId);
  if (!p || !(r > 0) || p.r === r) return false;
  p.r = r; save(); return true;
}

export function setPhotoCaption(bucket, blobId, caption) {
  const p = photosOf(bucket).find(x => x.id === blobId);
  if (p) { p.caption = caption; save(); emit('photo-caption'); }
}

export function toggleCollapsed(bucket) {
  state.trip.collapsed[bucket] = !state.trip.collapsed[bucket];
  save(); emit('collapse');
}

/* ---------------- day groups ---------------- */
/* A labelled, coloured span of consecutive days, e.g. "Tokyo" over the days
   the trip is there. Spans may not overlap: dropping a group onto days another
   group already covers clips or removes whichever side lost the argument. */
export const groupList = () => [...(state.trip.groups || [])].sort((a, b) => a.start.localeCompare(b.start));

export const groupFor = dayKey =>
  (state.trip.groups || []).find(g => dayKey >= g.start && dayKey <= g.end) || null;

function deconflict(groups, id, start, end) {
  const out = [];
  for (const g of groups) {
    if (g.id === id) continue;
    if (g.end < start || g.start > end) { out.push(g); continue; }        // no overlap
    if (g.start < start && g.end > end) {                                  // engulfed: split
      out.push({ ...g, id: uid(), end: addDays(start, -1) });
      out.push({ ...g, start: addDays(end, 1) });
    } else if (g.start < start) out.push({ ...g, end: addDays(start, -1) });
    else if (g.end > end) out.push({ ...g, start: addDays(end, 1) });
    // else: fully covered by the new span — drop it
  }
  return out;
}

export function addGroup({ title = '', color, start, end }) {
  const g = { id: uid(), title, color, start, end: end < start ? start : end };
  state.trip.groups = [...deconflict(state.trip.groups || [], null, g.start, g.end), g];
  save(); emit('groups');
  return g;
}

export function updateGroup(id, patch) {
  const g = (state.trip.groups || []).find(x => x.id === id);
  if (!g) return;
  Object.assign(g, patch);
  if (g.end < g.start) g.end = g.start;
  state.trip.groups = [...deconflict(state.trip.groups, id, g.start, g.end), g];
  save(); emit('groups');
}

export function removeGroup(id) {
  state.trip.groups = (state.trip.groups || []).filter(g => g.id !== id);
  save(); emit('groups');
}

/* Every blob id the trip still points at. */
export function referencedBlobs() {
  const t = state.trip;
  const set = new Set();
  for (const list of Object.values(t.photos)) for (const p of list) set.add(p.id);
  for (const o of [...Object.values(t.items), ...Object.values(t.stays)])
    for (const f of o.files || []) set.add(f.id);
  return set;
}
