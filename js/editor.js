import { $, esc, uid } from './util.js';
import { CATEGORIES } from './categories.js';
import { getAny, updateItem, removeItem, isStay, addPhoto, state } from './store.js';
import { findPhoto } from './photos.js';
import * as db from './db.js';

const dlg = $('#editor');
const form = $('#editorForm');
let currentId = null;
let links = [];
let files = [];

$('#editorCategory').innerHTML = Object.entries(CATEGORIES)
  .map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`).join('');

export function openEditor(id) {
  const it = getAny(id);
  if (!it || state.readonly) return;
  currentId = id;
  const stay = isStay(id);

  $('#editorTitle').textContent = stay ? 'Accommodation' : 'Activity';
  $('#stayDates').hidden = !stay;

  form.name.value = it.name || '';
  form.address.value = it.address || '';
  form.category.value = it.category || (stay ? 'lodging' : 'other');
  form.cost.value = it.cost ?? '';
  form.lat.value = Number.isFinite(it.lat) ? it.lat : '';
  form.lng.value = Number.isFinite(it.lng) ? it.lng : '';
  form.notes.value = it.notes || '';
  if (stay) {
    form.checkIn.value = it.checkIn || '';
    form.checkOut.value = it.checkOut || '';
  }

  links = (it.links || []).map(l => ({ ...l }));
  files = (it.files || []).map(f => ({ ...f }));
  renderChips();
  dlg.showModal();
  setTimeout(() => form.name.select(), 30);
}

function renderChips() {
  $('#linkList').innerHTML = [
    ...links.map((l, i) =>
      `<span class="chip"><a href="${esc(l.url)}" target="_blank" rel="noopener">🔗 ${esc(l.label || l.url)}</a>
       <button type="button" data-rm-link="${i}" title="Remove">✕</button></span>`),
    ...files.map((f, i) =>
      `<span class="chip"><a href="#" data-open-file="${f.id}">📎 ${esc(f.name)}</a>
       <button type="button" data-rm-file="${i}" title="Remove">✕</button></span>`),
  ].join('') || '<span class="hint">No links or attachments yet.</span>';
}

$('#linkList').addEventListener('click', async e => {
  const rmL = e.target.closest('[data-rm-link]');
  const rmF = e.target.closest('[data-rm-file]');
  const open = e.target.closest('[data-open-file]');
  if (rmL) { links.splice(Number(rmL.dataset.rmLink), 1); renderChips(); }
  if (rmF) { files.splice(Number(rmF.dataset.rmFile), 1); renderChips(); }
  if (open) {
    e.preventDefault();
    const url = await db.blobURL(open.dataset.openFile);
    if (url) window.open(url, '_blank');
  }
});

$('#btnAddLink').addEventListener('click', () => {
  const url = $('#linkUrl').value.trim();
  if (!url) return;
  links.push({ label: $('#linkLabel').value.trim(), url: /^https?:/i.test(url) ? url : `https://${url}` });
  $('#linkLabel').value = $('#linkUrl').value = '';
  renderChips();
});

$('#attachInput').addEventListener('change', async e => {
  for (const f of e.target.files) {
    const id = uid();
    await db.putBlob(id, f);
    files.push({ id, name: f.name, type: f.type, size: f.size });
  }
  e.target.value = '';
  renderChips();
});

$('#btnFindPhoto').addEventListener('click', async e => {
  const btn = e.target;
  const num = v => (v === '' ? null : Number(v));
  const place = {
    name: form.name.value.trim(),
    lat: num(form.lat.value),
    lng: num(form.lng.value),
  };
  if (!place.name) return;
  btn.disabled = true;
  btn.textContent = 'Searching…';
  const found = await findPhoto(place);
  btn.disabled = false;
  btn.textContent = '✨ Find a photo';
  if (!found) { btn.textContent = 'Nothing found'; setTimeout(() => (btn.textContent = '✨ Find a photo'), 2000); return; }
  const id = uid();
  await db.putBlob(id, found.blob);
  addPhoto(currentId, id, found.caption, found.source);
  btn.textContent = `Added ${found.caption.split(' · ')[0]}`;
  setTimeout(() => (btn.textContent = '✨ Find a photo'), 2500);
});

$('#btnDeleteItem').addEventListener('click', async () => {
  const it = getAny(currentId);
  if (!it || !confirm(`Delete “${it.name}”?`)) return;
  await removeItem(currentId);
  dlg.close('deleted');
});

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save' || !currentId) {
    // a place added straight from "+ Add place" and then cancelled leaves nothing behind
    const it = getAny(currentId);
    if (it && !it.name) removeItem(currentId);
    currentId = null;
    return;
  }
  const num = v => (v === '' || v == null ? null : Number(v));
  const patch = {
    name: form.name.value.trim() || 'Untitled',
    address: form.address.value.trim(),
    category: form.category.value,
    cost: num(form.cost.value),
    lat: num(form.lat.value),
    lng: num(form.lng.value),
    notes: form.notes.value,
    links, files,
  };
  if (isStay(currentId)) {
    patch.checkIn = form.checkIn.value || null;
    patch.checkOut = form.checkOut.value || patch.checkIn;
    if (patch.checkOut && patch.checkIn && patch.checkOut < patch.checkIn) patch.checkOut = patch.checkIn;
  }
  updateItem(currentId, patch);
  currentId = null;
});
