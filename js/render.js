import {
  state, days, itemsIn, staysOn, dayCost, tripCost, photosOf, setPhotoRatio, dayRoute, UNSCHEDULED,
  groupFor, groupList, OVERVIEW,
} from './store.js';
import { catOf } from './categories.js';
import { $, esc, fmtDate, fmtDateShort, money, fmtKm, fmtDur, dayCount } from './util.js';
import * as db from './db.js';
import { estimateLegs, onLegs } from './map.js';

/* Real routed legs for whichever day is focused, filled in by map.js. */
const routedLegs = { bucket: null, legs: [] };
onLegs((bucket, legs) => {
  routedLegs.bucket = bucket;
  routedLegs.legs = legs;
  paintLegs();
});

const cur = () => state.trip.currency || 'USD';

export function render() {
  const root = $('#timeline');
  const scrollTop = root.scrollTop;
  root.innerHTML = [overviewBlock(), scratchpadBlock(), ...timelineBlocks()].join('');
  root.scrollTop = scrollTop;
  paintLegs();
  hydratePhotos(root);
  renderTotals();
}

/* ---------------- trip overview ---------------- */
/* A single glance at the shape of the trip: how long, how full, what it costs,
   and — if any days have been grouped ("Tokyo") — a segmented strip showing
   where each stretch falls across the whole timeline. */
function overviewBlock() {
  const ds = days();
  const stops = ds.reduce((n, d) => n + itemsIn(d).length, 0);
  const ideas = itemsIn(UNSCHEDULED).length;
  const nights = Object.values(state.trip.stays)
    .reduce((n, s) => n + (s.checkIn && s.checkOut ? Math.max(0, dayCount(s.checkIn, s.checkOut) - 1) : 0), 0);
  const cost = tripCost();
  const groups = groupList();
  const collapsed = state.trip.collapsed[OVERVIEW] ? ' collapsed' : '';
  const range = ds.length ? `${esc(fmtDateShort(ds[0]))} – ${esc(fmtDateShort(ds[ds.length - 1]))}` : 'Set a date range to begin';

  const stat = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  return `
  <section class="block overview${collapsed}" data-bucket="${OVERVIEW}">
    <header class="block-head" data-collapse>
      <span class="day-num">✦</span>
      <div>
        <div class="block-title">Trip overview</div>
        <div class="block-sub">${range}</div>
      </div>
      <div class="block-meta">
        <button class="icon-btn chev" data-collapse title="Collapse">▾</button>
      </div>
    </header>
    <div class="block-body">
      <div class="overview-stats">
        ${stat(ds.length, ds.length === 1 ? 'day' : 'days')}
        ${stat(nights, nights === 1 ? 'night' : 'nights')}
        ${stat(stops, stops === 1 ? 'stop' : 'stops')}
        ${ideas ? stat(ideas, ideas === 1 ? 'idea' : 'ideas') : ''}
        ${cost ? stat(money(cost, cur()), 'total') : ''}
      </div>
      ${groups.length ? overviewShape(ds, groups) : ''}
    </div>
  </section>`;
}

function overviewShape(ds, groups) {
  const bar = ds.map(d => {
    const g = groupFor(d);
    const style = g ? ` style="--seg:${esc(g.color)}"` : '';
    const label = g ? `${esc(fmtDateShort(d))} · ${esc(g.title || 'Untitled group')}` : esc(fmtDateShort(d));
    return `<span class="seg${g ? '' : ' seg-plain'}"${style} data-focus-day="${d}" title="${label}"></span>`;
  }).join('');
  const legend = groups.map(g => `
    <span class="legend-chip" style="--lc:${esc(g.color)}" data-focus-day="${g.start}" title="Jump to ${esc(g.title || 'this group')}">
      <i></i>${esc(g.title || 'Untitled group')}
    </span>`).join('');
  return `<div class="overview-bar">${bar}</div><div class="overview-legend">${legend}</div>`;
}

/* Days render one after another, except that a run of consecutive days under
   the same group gets wrapped in a single coloured, titled section instead of
   standing alone. */
function timelineBlocks() {
  const all = days();
  const out = [];
  for (let i = 0; i < all.length;) {
    const g = groupFor(all[i]);
    if (!g) { out.push(dayBlock(all[i], i)); i++; continue; }
    const start = i;
    const keys = [];
    while (i < all.length && groupFor(all[i])?.id === g.id) { keys.push(all[i]); i++; }
    out.push(groupBlock(g, keys, start));
  }
  return out;
}

function groupBlock(g, keys, startIndex) {
  return `
  <section class="day-group" style="--group-color:${esc(g.color)}">
    <header class="group-head">
      <span class="group-bar"></span>
      <div class="group-title" data-edit-group="${g.id}" title="Edit group">${esc(g.title || 'Untitled group')}</div>
      <div class="group-actions">
        <button class="icon-btn" data-edit-group="${g.id}" title="Edit group">✎</button>
        <button class="icon-btn" data-del-group="${g.id}" title="Remove group label">🗑</button>
      </div>
    </header>
    ${keys.map((k, j) => dayBlock(k, startIndex + j)).join('')}
  </section>`;
}

function renderTotals() {
  const total = tripCost();
  const n = days().length;
  $('#tripTotal').innerHTML = total
    ? `<b>${money(total, cur())}</b> total${n ? ` · ${money(total / n, cur())}/day` : ''}`
    : `${n} day${n === 1 ? '' : 's'}`;
}

/* ---------------- blocks ---------------- */
function scratchpadBlock() {
  const items = itemsIn(UNSCHEDULED);
  const collapsed = state.trip.collapsed[UNSCHEDULED] ? ' collapsed' : '';
  const focused = state.focusDay === UNSCHEDULED ? ' focused' : '';
  return `
  <section class="block scratchpad${collapsed}${focused}" data-bucket="${UNSCHEDULED}">
    <header class="block-head" data-toggle>
      <span class="day-num">💡</span>
      <div>
        <div class="block-title">Ideas scratchpad</div>
        <div class="block-sub">Places to slot in later</div>
      </div>
      <div class="block-meta">
        <span>${items.length} idea${items.length === 1 ? '' : 's'}</span>
        <button class="icon-btn chev" data-collapse title="Collapse">▾</button>
      </div>
    </header>
    <div class="block-body">
      ${cardList(UNSCHEDULED, items, false)}
      ${addRow(UNSCHEDULED, false)}
      ${gallery(UNSCHEDULED)}
    </div>
  </section>`;
}

function dayBlock(key, i) {
  const items = itemsIn(key);
  const stays = staysOn(key);
  const route = dayRoute(key);
  const legTo = new Set(route.slice(1).map(r => r.id));   // things you travel *to*
  const last = route[route.length - 1];
  const tailLeg = last && last.role === 'to-stay'
    ? `<div class="leg leg-stay" data-legfor="${last.id}"></div>` : '';
  const collapsed = state.trip.collapsed[key] ? ' collapsed' : '';
  const focused = state.focusDay === key ? ' focused' : '';
  const cost = dayCost(key);
  return `
  <section class="block${collapsed}${focused}" data-bucket="${key}">
    <header class="block-head" data-toggle>
      <span class="day-num">${i + 1}</span>
      <div>
        <div class="block-title">${esc(fmtDate(key))}</div>
        <div class="block-sub">${items.length} stop${items.length === 1 ? '' : 's'}${stays.length ? ` · ${esc(stays[0].name)}` : ''}</div>
      </div>
      <div class="block-meta">
        ${cost ? `<span>${money(cost, cur())}</span>` : ''}
        <button class="icon-btn chev" data-collapse title="Collapse">▾</button>
      </div>
    </header>
    <div class="block-body">
      ${stays.map(s => stayRow(s, key)).join('')}
      ${cardList(key, items, true, legTo)}
      ${tailLeg}
      ${addRow(key, true)}
      ${gallery(key)}
    </div>
  </section>`;
}

function stayRow(s, dayKey) {
  const nights = s.checkIn && s.checkOut ? Math.max(1, dayCount(s.checkIn, s.checkOut) - 1) : 1;
  const which = s.checkIn === dayKey ? 'Check-in' : s.checkOut === dayKey ? 'Check-out' : 'Staying';
  return `
  <div class="stay-block" data-id="${s.id}">
    <div class="stay" data-stay="${s.id}" draggable="true" title="Drag to another day to move this stay">
      <span class="stay-icon">🛏</span>
      <span class="stay-name">${esc(s.name)}</span>
      <span class="stay-tag">${which} · ${esc(fmtDateShort(s.checkIn))}–${esc(fmtDateShort(s.checkOut))} · ${nights} night${nights === 1 ? '' : 's'}</span>
      <span class="spacer"></span>
      ${s.cost ? `<span class="card-cost">${money(Number(s.cost), cur())}</span>` : ''}
      <div class="card-actions" style="opacity:1">
        <button class="icon-btn" data-nights="${s.id}" data-delta="-1" title="One night shorter">−</button>
        <button class="icon-btn" data-nights="${s.id}" data-delta="1" title="One night longer">+</button>
        ${Number.isFinite(s.lat) ? `<button class="icon-btn" data-locate="${s.id}" title="Show on map">◎</button>` : ''}
        <button class="icon-btn" data-add-photo="${s.id}" title="Add photos">🖼</button>
        <button class="icon-btn" data-edit="${s.id}" title="Edit">✎</button>
        <button class="icon-btn" data-del="${s.id}" title="Delete">🗑</button>
      </div>
    </div>
    ${s.checkIn === dayKey ? gallery(s.id) : ''}
  </div>`;
}

function cardList(bucket, items, withLegs, legTo = null) {
  const inner = items.map((it, i) => card(it, i, withLegs, legTo)).join('');
  return `<div class="drop${items.length ? '' : ' empty'}" data-drop="${bucket}"
    data-empty="${bucket === UNSCHEDULED ? 'Drop ideas here, or search for a place above' : 'Drag a place here to schedule it'}">${inner}</div>`;
}

function card(it, i, withLegs, legTo) {
  const c = catOf(it.category);
  const leg = withLegs && legTo?.has(it.id)
    ? `<div class="leg" data-legfor="${it.id}"></div>` : '';
  const links = (it.links || []).map(l =>
    `<a class="pill" href="${esc(l.url)}" target="_blank" rel="noopener">🔗 ${esc(l.label || hostOf(l.url))}</a>`).join('');
  const files = (it.files || []).map(f =>
    `<button class="pill" data-file="${f.id}" data-fname="${esc(f.name)}">📎 ${esc(f.name)}</button>`).join('');
  return `
  ${leg}
  <article class="card" draggable="true" data-id="${it.id}" style="--cat:${c.color}">
    <span class="card-index">${withLegs ? i + 1 : '•'}</span>
    <div class="card-main">
      <div class="card-name">${esc(it.name)} <span class="cat-tag">${c.icon} ${c.label}</span></div>
      ${it.address ? `<div class="card-sub">${esc(it.address)}</div>` : ''}
      ${it.notes ? `<div class="card-notes">${esc(it.notes)}</div>` : ''}
      ${links || files ? `<div class="card-links">${links}${files}</div>` : ''}
      ${gallery(it.id)}
    </div>
    <div class="card-right">
      ${it.cost ? `<span class="card-cost">${money(Number(it.cost), cur())}</span>` : ''}
      <div class="card-actions">
        ${Number.isFinite(it.lat) ? `<button class="icon-btn" data-locate="${it.id}" title="Show on map">◎</button>` : ''}
        ${it.category === 'lodging' ? `<button class="icon-btn" data-to-stay="${it.id}" title="Make this the accommodation">🛏</button>` : ''}
        <button class="icon-btn" data-add-photo="${it.id}" title="Add photos">🖼</button>
        <button class="icon-btn" data-edit="${it.id}" title="Edit">✎</button>
        <button class="icon-btn" data-del="${it.id}" title="Delete">🗑</button>
      </div>
    </div>
  </article>`;
}

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; } };

function addRow(bucket, isDay) {
  return `<div class="add-row">
    <button class="btn btn-sm" data-add="${bucket}">+ Add place</button>
    ${isDay ? `<button class="btn btn-sm" data-add-stay="${bucket}">+ Accommodation</button>` : ''}
    <button class="btn btn-sm" data-add-photo="${bucket}">+ Photos</button>
  </div>`;
}

/* gallery — a justified grid: photos are laid in rows of at most three and
   every photo in a row gets the same height, with widths proportional to its
   aspect ratio. Each row therefore fills the full width exactly and no image
   ends up towering over its neighbours. The ratio is learned on first paint
   (see measure below) and cached on the photo record; until then we assume a
   mild landscape so the first frame is close. */
const DEFAULT_RATIO = 1.5;
const clampRatio = p => Math.min(2.4, Math.max(0.62, p.r || DEFAULT_RATIO));

/* Within a row we lay photos out by the square root of their ratio rather than
   the ratio itself. Sharing the width by the raw ratio is faithful but unkind —
   a panorama beside a portrait leaves the portrait a sliver — and the square
   root pulls the shares toward each other, so the row reads as evenly weighted
   and object-fit takes up the small difference. A photo alone in its row keeps
   its true shape; there is nothing to balance it against. */
const ratioOf = (p, n) => (n === 1 ? clampRatio(p) : Math.sqrt(clampRatio(p)));

/* flex-grow shares, normalised to sum to 100: raw factors under 1 would leave a
   lone photo short of the full width, since flex only hands out that fraction. */
const share = (r, sum) => (r / sum * 100).toFixed(3);

/* rows of three, except that a lone leftover is paired instead: 4 photos read
   better as 2 + 2 than as 3 + 1. */
function chunk(photos) {
  const out = [];
  for (let i = 0; i < photos.length;) {
    const left = photos.length - i;
    const take = left === 4 ? 2 : Math.min(3, left);
    out.push(photos.slice(i, i + take));
    i += take;
  }
  return out;
}

function gallery(bucket) {
  const photos = photosOf(bucket);
  if (!photos.length) return '';
  let index = -1;
  const rows = chunk(photos).map(row => {
    const rs = row.map(p => ratioOf(p, row.length));
    const sum = rs.reduce((a, b) => a + b, 0);
    return `<div class="grow" style="--ar:${sum.toFixed(4)}">${row.map((p, j) => {
      index++;
      return `<figure data-photo="${p.id}" data-index="${index}" style="--r:${share(rs[j], sum)}">
        <img alt="${esc(p.caption || '')}" data-blob="${p.id}"${p.url ? ` src="${esc(p.url)}"` : ''}>
        ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}
        <button class="photo-del" data-photo-del="${p.id}" data-bucket="${bucket}" title="Remove">✕</button>
      </figure>`;
    }).join('')}</div>`;
  }).join('');
  return `<div class="gallery" data-gallery="${bucket}">${rows}</div>`;
}

function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-blob]')) {
    if (img.getAttribute('src')) {           // a shared trip: the photo has a real server URL already
      img.addEventListener('load', () => measure(img), { once: true });
      continue;
    }
    db.blobURL(img.dataset.blob).then(url => {
      if (!url) return;
      img.addEventListener('load', () => measure(img), { once: true });
      img.src = url;
    });
  }
}

/* first paint of a photo tells us its true shape; record it and rebalance the
   row widths in place (no re-render, so the scroll position stays put) */
function measure(img) {
  const gal = img.closest('.gallery');
  if (!gal || !img.naturalWidth || !img.naturalHeight) return;
  if (setPhotoRatio(gal.dataset.gallery, img.dataset.blob, img.naturalWidth / img.naturalHeight)) retune(gal);
}

function retune(gal) {
  const list = photosOf(gal.dataset.gallery);
  const ratios = new Map();
  for (const row of gal.querySelectorAll('.grow')) {
    for (const f of row.children) {
      const rec = list.find(p => p.id === f.dataset.photo);
      if (rec) ratios.set(rec.id, ratioOf(rec, row.children.length));
    }
    const figs = [...row.children];
    const rs = figs.map(f => ratios.get(f.dataset.photo) ?? DEFAULT_RATIO);
    const sum = rs.reduce((a, b) => a + b, 0);
    figs.forEach((f, i) => f.style.setProperty('--r', share(rs[i], sum)));
    row.style.setProperty('--ar', sum.toFixed(4));
  }
}

/* ---------------- travel-time labels ---------------- */
function paintLegs() {
  for (const block of document.querySelectorAll('.block[data-bucket]')) {
    const bucket = block.dataset.bucket;
    if (bucket === UNSCHEDULED) continue;

    const route = dayRoute(bucket);
    const legs = routedLegs.bucket === bucket && routedLegs.legs.length === route.length - 1
      ? routedLegs.legs
      : estimateLegs(route);

    block.querySelectorAll('.leg').forEach(n => { n.textContent = ''; });
    route.slice(1).forEach((to, j) => {
      const node = block.querySelector(`.leg[data-legfor="${to.id}"]`);
      const leg = legs[j];
      if (!node || !leg) return;
      const from = route[j];
      const where =
        to.role === 'to-stay' ? ` \u2192 ${to.name}`
        : from.role === 'from-stay' ? ` from ${from.name}`
        : '';
      node.textContent = `${leg.estimated ? '\u2248 ' : ''}${fmtDur(leg.min)} \u00b7 ${fmtKm(leg.km)}${where}`;
    });
  }
}

export { paintLegs };
