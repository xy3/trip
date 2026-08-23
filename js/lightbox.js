import { $ } from './util.js';
import { photosOf, setPhotoCaption, state } from './store.js';
import * as db from './db.js';

let bucket = null, index = 0;

export async function openLightbox(b, i) {
  bucket = b; index = i;
  $('#lightbox').hidden = false;
  await show();
}

function close() {
  $('#lightbox').hidden = true;
  bucket = null;
}

async function show() {
  const list = photosOf(bucket);
  if (!list.length) return close();
  index = (index + list.length) % list.length;
  const p = list[index];
  const img = $('#lbImage');
  img.src = (await db.blobURL(p.id)) || '';
  img.alt = p.caption || '';
  const cap = $('#lbCaption');
  cap.value = p.caption || '';
  cap.disabled = state.readonly;
  const src = $('#lbSource');
  src.hidden = !p.source;
  if (p.source) src.href = p.source;
  $('#lbCount').textContent = `${index + 1} / ${list.length}`;
  const many = list.length > 1;
  $('#lbPrev').hidden = $('#lbNext').hidden = !many;
}

const step = n => { index += n; show(); };

$('#lbPrev').addEventListener('click', () => step(-1));
$('#lbNext').addEventListener('click', () => step(1));
$('#lbClose').addEventListener('click', close);
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') close(); });
$('#lbCaption').addEventListener('change', e => {
  const p = photosOf(bucket)[index];
  if (p) setPhotoCaption(bucket, p.id, e.target.value);
});

document.addEventListener('keydown', e => {
  if ($('#lightbox').hidden) return;
  if (e.key === 'Escape') close();
  if (document.activeElement === $('#lbCaption')) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
