import {
  state, days, itemsIn, staysOn, dayCost, tripCost, photosOf, dayRoute, UNSCHEDULED,
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
  root.innerHTML = [scratchpadBlock(), ...days().map(dayBlock)].join('');
  root.scrollTop = scrollTop;
  paintLegs();
  hydratePhotos(root);
  renderTotals();
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

function gallery(bucket) {
  const photos = photosOf(bucket);
  if (!photos.length) return '';
  // column count follows the photo count, capped at three, so a gallery always
  // fills its width instead of leaving empty columns
  const cols = Math.min(photos.length, 3);
  return `<div class="gallery cols-${cols}" data-gallery="${bucket}">${photos.map((p, i) => `
    <figure data-photo="${p.id}" data-index="${i}">
      <img alt="${esc(p.caption || '')}" data-blob="${p.id}">
      ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}
      <button class="photo-del" data-photo-del="${p.id}" data-bucket="${bucket}" title="Remove">✕</button>
    </figure>`).join('')}</div>`;
}

async function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-blob]')) {
    const url = await db.blobURL(img.dataset.blob);
    if (url) img.src = url;
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
