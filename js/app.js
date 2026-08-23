import { $, $$, uid, debounce, esc, toast, download, fmtDate, clamp } from './util.js';
import * as store from './store.js';
import { UNSCHEDULED, state } from './store.js';
import { guessCategory } from './categories.js';
import { searchPlaces } from './geo.js';
import * as map from './map.js';
import { render } from './render.js';
import { initDnD, dropPlace, PLACE } from './dnd.js';
import { openEditor } from './editor.js';
import { openLightbox } from './lightbox.js';
import { buildShareLink, tripFromHash, exportBundle, importBundle } from './share.js';
import * as db from './db.js';
import { findPhoto } from './photos.js';

/* ---------------- boot ---------------- */
async function boot() {
  const shared = await tripFromHash();
  if (shared) {
    store.replaceTrip(shared, { readonly: true });
    document.body.classList.add('readonly', 'has-banner');
    $('#readonlyBanner').hidden = false;
    $$('#tripTitle, #startDate, #endDate').forEach(el => (el.readOnly = el.disabled = true));
  } else {
    store.load();
  }

  map.initMap();
  syncHeader();
  redraw({ fit: true });
  db.gc(store.referencedBlobs()).catch(() => {});

  store.subscribe(reason => {
    syncHeader();
    redraw({ fit: reason === 'replace' });
  });
}

function syncHeader() {
  const t = state.trip;
  if (document.activeElement !== $('#tripTitle')) $('#tripTitle').value = t.title;
  $('#startDate').value = t.startDate || '';
  $('#endDate').value = t.endDate || '';
  document.title = (t.title || 'Trip Planner') + ' · Trip Planner';
  document.body.dataset.printTitle = t.title || 'Itinerary';
  document.body.dataset.printSub =
    `${t.startDate ? fmtDate(t.startDate) : ''}${t.endDate ? ` – ${fmtDate(t.endDate)}` : ''}`;
}

function redraw(opts = {}) {
  render();
  map.renderLegend();
  map.refresh(opts);
}

/* ---------------- header ---------------- */
$('#tripTitle').addEventListener('input', e => store.setTripField('title', e.target.value));
$('#startDate').addEventListener('change', e => store.setTripField('startDate', e.target.value));
$('#endDate').addEventListener('change', e => store.setTripField('endDate', e.target.value));

$('#btnPrint').addEventListener('click', () => window.print());

$('#btnShare').addEventListener('click', async () => {
  const url = await buildShareLink();
  try {
    await navigator.clipboard.writeText(url);
    toast(`Read-only link copied to your clipboard. ${url.length > 12000 ? '<br>Heads up: it is very long — some chat apps may truncate it.' : ''}`);
  } catch {
    toast(`Read-only link: <a href="${esc(url)}">${esc(url.slice(0, 80))}…</a>`, 8000);
  }
});

$('#btnCopyToMine').addEventListener('click', () => {
  const copy = JSON.parse(JSON.stringify(state.trip));
  copy.id = uid();
  state.readonly = false;
  store.replaceTrip(copy);
  history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.remove('readonly', 'has-banner');
  $('#readonlyBanner').hidden = true;
  $$('#tripTitle, #startDate, #endDate').forEach(el => (el.readOnly = el.disabled = false));
  toast('Copied into this browser — edit away.');
});

/* ---------------- auto-photo ---------------- */
/* A newly searched place gets one representative Wikipedia image, fetched in
   the background so adding a place never waits on the network. */
async function autoPhoto(place) {
  if (!place || !state.autoPhoto || state.readonly) return;
  if (store.photosOf(place.id).length) return;
  const found = await findPhoto(place);
  if (!found || !store.getAny(place.id)) return;
  const id = uid();
  await db.putBlob(id, found.blob);
  store.addPhoto(place.id, id, found.caption, found.source);
}

/* menu */
const menu = $('#menu');
$('#btnMenu').addEventListener('click', e => {
  e.stopPropagation();
  menu.querySelector('[data-act="autophoto"]').textContent =
    `${state.autoPhoto ? '✓' : '　'} Auto-photo new places`;
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', () => { menu.hidden = true; });
menu.addEventListener('click', async e => {
  const act = e.target.dataset.act;
  menu.hidden = true;
  if (act === 'autophoto') {
    store.setAutoPhoto(!state.autoPhoto);
    toast(state.autoPhoto
      ? 'New places will get a photo from Wikipedia when one exists.'
      : 'Auto-photo off — use ✨ Find a photo in the editor instead.');
  } else if (act === 'export') {
    download(`${(state.trip.title || 'trip').replace(/\W+/g, '-').toLowerCase()}.trip.json`, await exportBundle());
  } else if (act === 'import') {
    $('#importInput').click();
  } else if (act === 'fit') {
    map.fitAll();
  } else if (act === 'reset') {
    if (confirm('Delete this trip and all its photos from this browser?')) {
      localStorage.removeItem('trip-planner:v1');
      await db.gc(new Set());
      store.replaceTrip(store.blankTrip());
      toast('Trip cleared.');
    }
  }
});

$('#importInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    store.replaceTrip(await importBundle(file));
    toast('Trip imported.');
  } catch (err) {
    toast(`Could not read that file: ${esc(err.message)}`);
  }
});

/* ---------------- place search ---------------- */
const searchInput = $('#placeSearch');
const resultsEl = $('#searchResults');
let results = [];
let searchAbort;

const runSearch = debounce(async () => {
  const q = searchInput.value.trim();
  if (q.length < 2) { hideResults(); return; }
  searchAbort?.abort();
  searchAbort = new AbortController();
  showResults('<div class="res-empty">Searching…</div>');
  try {
    const near = mapCenter();
    results = (await searchPlaces(q, { near, signal: searchAbort.signal }))
      .map(r => ({ ...r, category: guessCategory(r) }));
    if (!results.length) return showResults('<div class="res-empty">Nothing found. Try a more specific name or add the place manually.</div>');
    showResults(results.map((r, i) => `
      <div class="res" data-res="${i}" draggable="true" title="Drag onto a day, or click to add">
        <div>
          <div class="res-name">${esc(r.name)}${r.category === 'lodging' ? ' <span class="cat-tag" style="--cat:#ff7fb0">🛏 stay</span>' : ''}</div>
          <div class="res-sub">${esc(r.display)}</div>
        </div>
        <span class="res-add">${esc(addTarget(r))}</span>
      </div>`).join(''));
  } catch (err) {
    if (err.name !== 'AbortError') showResults(`<div class="res-empty">Search unavailable: ${esc(err.message)}</div>`);
  }
}, 400);

const dayTarget = () =>
  (state.focusDay && state.focusDay !== UNSCHEDULED ? state.focusDay : null);
const addTarget = r =>
  r?.category === 'lodging'
    ? (dayTarget() ? `Stay from ${fmtDate(dayTarget())}` : 'Add as accommodation')
    : (dayTarget() ? `Add to ${fmtDate(dayTarget())}` : 'Add to ideas');

function mapCenter() {
  const pts = [...Object.values(state.trip.items), ...Object.values(state.trip.stays)]
    .filter(p => Number.isFinite(p.lat));
  if (!pts.length) return null;
  return { lat: pts[0].lat, lng: pts[0].lng };
}

const showResults = html => { resultsEl.innerHTML = html; resultsEl.hidden = false; };
const hideResults = () => { resultsEl.hidden = true; };

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') hideResults(); });
$('#btnSearch').addEventListener('click', () => runSearch());
document.addEventListener('click', e => {
  if (!e.target.closest('.searchbar')) hideResults();
});

resultsEl.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-res]');
  if (!el) return;
  e.dataTransfer.setData(PLACE, JSON.stringify(results[Number(el.dataset.res)]));
  e.dataTransfer.effectAllowed = 'copy';
});

resultsEl.addEventListener('click', e => {
  const el = e.target.closest('[data-res]');
  if (!el) return;
  const r = results[Number(el.dataset.res)];
  // a hotel becomes accommodation for the focused day (or day one); anything
  // else is a stop on the focused day, or an idea for later
  const bucket = r.category === 'lodging'
    ? (dayTarget() || state.trip.startDate)
    : (dayTarget() || UNSCHEDULED);
  const made = dropPlace(r, bucket);
  autoPhoto(made);
  hideResults();
  searchInput.value = '';
  map.flyTo(made);
  toast(made.checkIn
    ? `“${esc(made.name)}” is now your stay from ${fmtDate(made.checkIn)}. Drag it to another day, or use −/+ for more nights.`
    : `Added “${esc(made.name)}” to ${bucket === UNSCHEDULED ? 'your ideas' : fmtDate(bucket)}.`);
});

/* ---------------- timeline interactions ---------------- */
const timeline = $('#timeline');
initDnD(timeline, { onCreate: autoPhoto });

timeline.addEventListener('click', async e => {
  const t = e.target;
  const block = t.closest('.block');
  const bucket = block?.dataset.bucket;

  const hit = sel => t.closest(`[${sel}]`)?.getAttribute(sel);

  const editId = hit('data-edit');
  if (editId) return openEditor(editId);

  const delId = hit('data-del');
  if (delId) {
    const it = store.getAny(delId);
    if (it && confirm(`Delete “${it.name}”?`)) await store.removeItem(delId);
    return;
  }

  const locId = hit('data-locate');
  if (locId) {
    const it = store.getAny(locId);
    state.activeItem = locId;
    map.refresh();
    return map.flyTo(it);
  }

  const nightsBtn = t.closest('[data-nights]');
  if (nightsBtn) return store.addStayNights(nightsBtn.dataset.nights, Number(nightsBtn.dataset.delta));

  const promote = hit('data-to-stay');
  if (promote) {
    const stay = store.convertToStay(promote, bucket === UNSCHEDULED ? null : bucket);
    if (stay) toast(`“${esc(stay.name)}” is now your accommodation from ${fmtDate(stay.checkIn)}.`);
    return;
  }

  const addTo = hit('data-add');
  if (addTo) {
    const item = store.addItem({ name: '' }, addTo);
    return openEditor(item.id);
  }

  const stayFor = hit('data-add-stay');
  if (stayFor) {
    const stay = store.addStay({ checkIn: stayFor, checkOut: stayFor });
    return openEditor(stay.id);
  }

  const photoFor = hit('data-add-photo');
  if (photoFor) return pickPhotos(photoFor);

  const photoDel = t.closest('[data-photo-del]');
  if (photoDel) {
    return store.removePhoto(photoDel.dataset.bucket, photoDel.dataset.photoDel);
  }

  const fig = t.closest('figure[data-photo]');
  if (fig) return openLightbox(fig.closest('[data-gallery]').dataset.gallery, Number(fig.dataset.index));

  const fileBtn = t.closest('[data-file]');
  if (fileBtn) {
    const url = await db.blobURL(fileBtn.dataset.file);
    if (url) window.open(url, '_blank');
    else toast('That attachment is not in this browser (share links do not carry files).');
    return;
  }

  if (t.closest('[data-collapse]')) return store.toggleCollapsed(bucket);

  if (t.closest('[data-toggle]')) {          // header click focuses this day on the map
    focusBucket(bucket);
    return;
  }

  const card = t.closest('.card');
  if (card) {
    state.activeItem = card.dataset.id;
    const it = store.getAny(card.dataset.id);
    map.refresh();
    if (Number.isFinite(it?.lat)) map.flyTo(it);
  }
});

timeline.addEventListener('dblclick', e => {
  const card = e.target.closest('.card');
  if (card) openEditor(card.dataset.id);
});

function focusBucket(bucket) {
  state.focusDay = state.focusDay === bucket ? null : bucket;
  $('.tab[data-view="all"]').classList.toggle('active', !state.focusDay);
  redraw({ fit: true });
}

const stayToggle = $('#btnStayRoute');
stayToggle.classList.toggle('active', state.includeStays);
stayToggle.addEventListener('click', () => {
  store.setIncludeStays(!state.includeStays);
  stayToggle.classList.toggle('active', state.includeStays);
});

$('.tab[data-view="all"]').addEventListener('click', () => {
  state.focusDay = null;
  $('.tab[data-view="all"]').classList.add('active');
  redraw({ fit: true });
});

/* photos */
function pickPhotos(bucket) {
  const input = Object.assign(document.createElement('input'),
    { type: 'file', accept: 'image/*', multiple: true });
  input.addEventListener('change', () => addPhotos(bucket, [...input.files]));
  input.click();
}

/* Drop image files straight onto a day block or onto a single activity card.
   The drop target decides where the photos land: a card keeps them on that
   activity, anywhere else in a block adds them to the day's gallery. */
const isImageDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');
const photoTarget = el =>
  el?.closest('.card') || el?.closest('.stay-block') || el?.closest('.block');

function markTarget(el) {
  timeline.querySelectorAll('.filedrop').forEach(n => n !== el && n.classList.remove('filedrop'));
  el?.classList.add('filedrop');
}

timeline.addEventListener('dragover', e => {
  if (!isImageDrag(e) || state.readonly) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  markTarget(photoTarget(e.target));
});

timeline.addEventListener('dragleave', e => {
  if (!e.relatedTarget || !timeline.contains(e.relatedTarget)) markTarget(null);
});

timeline.addEventListener('drop', async e => {
  if (!isImageDrag(e) || state.readonly) return;
  e.preventDefault();
  markTarget(null);
  const target = photoTarget(e.target);
  const bucket = target?.dataset.id || target?.dataset.bucket;   // card id, or day / scratchpad
  const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
  if (!bucket || !files.length) return;
  await addPhotos(bucket, files);
  toast(`Added ${files.length} photo${files.length === 1 ? '' : 's'} to ${bucketLabel(bucket)}.`);
});

async function addPhotos(bucket, files) {
  for (const file of files) {
    const id = uid();
    await db.putBlob(id, file);
    store.addPhoto(bucket, id, '');
  }
}

const bucketLabel = bucket =>
  store.isStay(bucket) || state.trip.items[bucket]
    ? `“${store.getAny(bucket)?.name || 'activity'}”`
    : bucket === UNSCHEDULED ? 'your ideas' : fmtDate(bucket);

/* ---------------- paste images ---------------- */
/* Photos paste onto whatever is under the pointer; failing that the selected
   activity, the focused day, or the scratchpad. */
let hoverTarget = null;
timeline.addEventListener('mousemove', e => { hoverTarget = photoTarget(e.target); });
timeline.addEventListener('mouseleave', () => { hoverTarget = null; });

window.addEventListener('paste', async e => {
  if (state.readonly || !$('#lightbox').hidden) return;
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;   // let fields keep their paste

  const files = [...(e.clipboardData?.items || [])]
    .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    .map(i => i.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();

  const fallback = state.activeItem
    ? timeline.querySelector(`.card[data-id="${state.activeItem}"]`)
    : state.focusDay && timeline.querySelector(`.block[data-bucket="${state.focusDay}"]`);
  const target = hoverTarget || fallback;
  const bucket = target?.dataset.id || target?.dataset.bucket || UNSCHEDULED;

  await addPhotos(bucket, files);
  toast(`Pasted ${files.length} image${files.length === 1 ? '' : 's'} into ${bucketLabel(bucket)}.`);
});

/* dropping a file anywhere else must not navigate away from the app */
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, e => {
    if (isImageDrag(e) && !e.defaultPrevented) e.preventDefault();
  });
}

/* ---------------- resizable split ---------------- */
const divider = $('#divider');
divider.addEventListener('pointerdown', e => {
  divider.setPointerCapture(e.pointerId);
  const move = ev => {
    const pct = clamp((ev.clientX / window.innerWidth) * 100, 22, 78);
    document.documentElement.style.setProperty('--left-w', `${pct}%`);
    map.invalidate();
  };
  const up = () => {
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    localStorage.setItem('trip-planner:split', getComputedStyle(document.documentElement).getPropertyValue('--left-w'));
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
});
const savedSplit = localStorage.getItem('trip-planner:split');
if (savedSplit) document.documentElement.style.setProperty('--left-w', savedSplit);

window.addEventListener('resize', () => map.invalidate());
boot();
