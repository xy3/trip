import { $, $$, uid, debounce, esc, toast, download, fmtDate, clamp } from './util.js';
import * as store from './store.js';
import { UNSCHEDULED, state } from './store.js';
import { guessCategory } from './categories.js';
import { searchPlaces } from './geo.js';
import * as map from './map.js';
import { render } from './render.js';
import { initDnD, dropPlace, PLACE } from './dnd.js';
import { openEditor } from './editor.js';
import { openGroupEditor } from './groups.js';
import { openLightbox } from './lightbox.js';
import { buildShareLink, tripFromHash, exportBundle, importBundle } from './share.js';
import * as db from './db.js';
import { findPhoto } from './photos.js';
import * as cloud from './sync.js';

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
    if (reason === 'sync') return paintAccount();
    syncHeader();
    redraw({ fit: reason === 'replace' });
    paintAccount();
  });

  // does this deployment have a server behind it? if not, sync stays invisible
  cloud.probe().then(paintAccount);
  reportSignIn();
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
    if (!results.length) return showResults(`<div class="res-empty">Nothing found for “${esc(q)}”.
      <button type="button" class="btn btn-sm" data-add-manual>Add it manually</button></div>`);
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

/* Context for the search: what the map is showing wins — panning to Japan is
   how you say which "Minoo Park" you mean — and the trip's own places stand in
   while the map is still zoomed out to the world. */
function mapCenter() {
  const view = map.viewCenter();
  if (view) return view;
  const pts = [...Object.values(state.trip.items), ...Object.values(state.trip.stays)]
    .filter(p => Number.isFinite(p.lat));
  return pts.length ? { lat: pts[0].lat, lng: pts[0].lng } : null;
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
  if (e.target.closest('[data-add-manual]')) {
    const bucket = dayTarget() || UNSCHEDULED;
    const item = store.addItem({ name: searchInput.value.trim() }, bucket);
    hideResults();
    searchInput.value = '';
    openEditor(item.id);
    return;
  }

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

  const focusDayKey = hit('data-focus-day');
  if (focusDayKey) return focusBucket(focusDayKey);

  const editGroupId = hit('data-edit-group');
  if (editGroupId) return openGroupEditor({ id: editGroupId });

  const delGroupId = hit('data-del-group');
  if (delGroupId) {
    if (confirm('Remove this group label? The days themselves are untouched.')) store.removeGroup(delGroupId);
    return;
  }

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
    // hand off to the search bar instead of a blank form — searching gets the
    // address, coordinates and category for free; typing them by hand is the
    // fallback, offered from the search box itself when nothing turns up.
    setFocusDay(addTo);
    searchInput.focus();
    searchInput.select();
    searchInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
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
  setFocusDay(state.focusDay === bucket ? null : bucket);
}

function setFocusDay(bucket) {
  if (state.focusDay === bucket) return;
  state.focusDay = bucket;
  $('.tab[data-view="all"]').classList.toggle('active', !state.focusDay);
  redraw({ fit: true });
}

const stayToggle = $('#btnStayRoute');
stayToggle.classList.toggle('active', state.includeStays);
stayToggle.addEventListener('click', () => {
  store.setIncludeStays(!state.includeStays);
  stayToggle.classList.toggle('active', state.includeStays);
});

$('#btnAddGroup').addEventListener('click', () => openGroupEditor({ start: dayTarget() || state.trip.startDate }));

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


/* ---------------- account & cloud sync ---------------- */
const GOOGLE_MARK = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24.5c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.8-1.5 4.6-4.4 6.4l-.1.3 6.4 4.9.4.1C42.4 35.6 45 30.5 45 24.5z"/><path fill="#34A853" d="M24 46c5.8 0 10.7-1.9 14.3-5.2l-6.8-5.3c-1.8 1.3-4.3 2.2-7.5 2.2-5.7 0-10.6-3.8-12.3-9l-.3.1-6.6 5.1-.1.3C8.3 41.1 15.6 46 24 46z"/><path fill="#FBBC05" d="M11.7 28.7c-.5-1.4-.7-2.8-.7-4.2s.3-2.9.7-4.2v-.4l-6.7-5.2-.2.1A22 22 0 0 0 2 24.5c0 3.5.9 6.9 2.8 9.7l6.9-5.5z"/><path fill="#EA4335" d="M24 11.1c4 0 6.8 1.7 8.3 3.2l6.1-5.9C34.7 4.9 29.8 3 24 3 15.6 3 8.3 7.9 4.8 14.8l6.9 5.5c1.7-5.2 6.6-9.2 12.3-9.2z"/></svg>`;

const accountBtn = $('#btnAccount');
const accountPanel = $('#accountPanel');

const fmtBytes = n => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`);
const STATE_TEXT = {
  idle: 'Everything is saved to your account',
  syncing: 'Saving…',
  error: 'Could not sync',
  conflict: 'Waiting for you to choose a copy',
  'signed-out': 'Not signed in',
};

function paintAccount() {
  const s = cloud.sync;
  accountBtn.hidden = !s.available || state.readonly;
  if (accountBtn.hidden) { accountPanel.hidden = true; return paintConflict(); }

  const signedIn = !!s.user;
  $('#accountLabel').textContent = signedIn ? (s.user.name || 'Account').split(' ')[0] : 'Sign in';
  $('#accountDot').className = `dot ${signedIn ? s.status : ''}`;
  accountBtn.title = signedIn ? (s.message || STATE_TEXT[s.status] || '') : 'Sign in to save your trip';

  if (!accountPanel.hidden) accountPanel.innerHTML = panelHTML(s);
  paintConflict();
}

function panelHTML(s) {
  if (!s.user) {
    return `<p>Your trip is saved in this browser. Sign in to keep it in your account and pick it
      up on another computer — photos included.</p>
      ${s.providers.map(p => `<button class="btn btn-provider" data-signin="${p.id}">
        ${p.id === 'google' ? GOOGLE_MARK : ''}<span>Continue with ${esc(p.label)}</span></button>`).join('')
        || '<p class="state">No sign-in provider is configured on this server.</p>'}`;
  }
  const q = s.quota;
  return `
    <div class="who">
      ${s.user.avatar ? `<img src="${esc(s.user.avatar)}" alt="">` : ''}
      <div><b>${esc(s.user.name || 'Signed in')}</b><span>${esc(s.user.email || '')}</span></div>
    </div>
    <div class="state ${s.status === 'error' ? 'error' : ''}">
      <span class="dot ${s.status}"></span>${esc(s.message || STATE_TEXT[s.status] || '')}
    </div>
    ${q ? `<div class="meter"><i style="width:${Math.min(100, (q.used / q.total) * 100).toFixed(1)}%"></i></div>
      <p style="margin:0 0 10px">${fmtBytes(q.used)} of ${fmtBytes(q.total)} used for photos</p>` : ''}
    <hr>
    <div class="row">
      <button class="btn btn-sm" data-act="syncnow">Sync now</button>
      <button class="btn btn-sm danger" data-act="signout">Sign out</button>
    </div>`;
}

accountBtn.addEventListener('click', e => {
  e.stopPropagation();
  accountPanel.hidden = !accountPanel.hidden;
  if (!accountPanel.hidden) accountPanel.innerHTML = panelHTML(cloud.sync);
});
accountPanel.addEventListener('click', async e => {
  const provider = e.target.closest('[data-signin]')?.dataset.signin;
  if (provider) return cloud.signIn(provider);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'signout') { accountPanel.hidden = true; await cloud.signOut(); toast('Signed out — this trip stays in this browser'); }
  if (act === 'syncnow') await cloud.syncNow();
  paintAccount();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#accountPanel, #btnAccount')) accountPanel.hidden = true;
});

/* the fork: this browser and the account disagree about the same trip */
const conflictBanner = $('#conflictBanner');
function paintConflict() {
  const c = cloud.sync.conflict;
  conflictBanner.hidden = !c;
  if (c) {
    $('#conflictTitle').textContent = c.other
      ? 'This account already has a saved trip.'
      : 'This trip was also changed on another device.';
    $('#conflictSub').textContent = c.other
      ? `Saved ${fmtDate(new Date(c.updatedAt).toISOString().slice(0, 10))} · ${c.remote.title || 'Untitled trip'}`
      : 'Choose which copy to keep — the other is not deleted from your account.';
    $('#btnKeepRemote').textContent = c.other ? 'Open the saved trip' : 'Use the saved copy';
  }
  document.body.classList.toggle('has-banner', !conflictBanner.hidden || !$('#readonlyBanner').hidden);
  map.invalidate();
}
$('#btnKeepRemote').addEventListener('click', () => cloud.resolveConflict('remote'));
$('#btnKeepLocal').addEventListener('click', () => cloud.resolveConflict('local'));

/* the OAuth round trip comes back to /#signed-in or /#sign-in-error=… */
function reportSignIn() {
  const hash = location.hash;
  if (!/^#(signed-in|sign-in-error)/.test(hash)) return;
  history.replaceState(null, '', location.pathname + location.search);
  const err = /#sign-in-error=(.*)$/.exec(hash);
  toast(err ? `Sign-in failed: ${decodeURIComponent(err[1])}` : 'Signed in — your trip is saved to your account');
}

boot();
