/* Drag & drop inside the timeline. Three kinds of payload:
     - a card being rescheduled or reordered      (text/plain = item id)
     - a stay being shifted to another day        (x-trip-stay)
     - a search result being dropped onto a day   (x-trip-place)
   A lodging result becomes that day's accommodation rather than a stop. */
import { moveItem, moveStay, addItem, addStay, state } from './store.js';
import { addDays } from './util.js';

export const PLACE = 'application/x-trip-place';
export const STAY = 'application/x-trip-stay';

let draggingId = null;

const kindOf = dt => {
  const types = [...(dt?.types || [])];
  if (types.includes(PLACE)) return 'place';
  if (types.includes(STAY)) return 'stay';
  if (types.includes('Files')) return null;          // handled as photo drops
  return draggingId ? 'card' : null;
};

export function initDnD(root, { onCreate = () => {} } = {}) {
  root.addEventListener('dragstart', e => {
    if (state.readonly) return e.preventDefault();
    const stay = e.target.closest('.stay');
    if (stay) {
      e.dataTransfer.setData(STAY, stay.dataset.stay);
      e.dataTransfer.effectAllowed = 'move';
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return e.preventDefault();
    draggingId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggingId);
  });

  root.addEventListener('dragend', () => {
    draggingId = null;
    clear(root);
  });

  root.addEventListener('dragover', e => {
    const kind = kindOf(e.dataTransfer);
    if (!kind || state.readonly) return;
    const zone = kind === 'card' ? e.target.closest('[data-drop]') : e.target.closest('.block');
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = kind === 'place' ? 'copy' : 'move';
    clear(root, zone);
    zone.classList.add('dragover');
  });

  root.addEventListener('dragleave', e => {
    const zone = e.target.closest('[data-drop], .block');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('dragover');
  });

  root.addEventListener('drop', e => {
    const kind = kindOf(e.dataTransfer);
    if (!kind || state.readonly) return;
    const bucket = e.target.closest('.block')?.dataset.bucket;
    if (!bucket) return;
    e.preventDefault();
    clear(root);

    if (kind === 'stay') {
      return moveStay(e.dataTransfer.getData(STAY), bucket);
    }

    if (kind === 'place') {
      let place;
      try { place = JSON.parse(e.dataTransfer.getData(PLACE)); } catch { return; }
      return onCreate(dropPlace(place, bucket, insertionIndex(e.target.closest('[data-drop]'), e.clientY)));
    }

    const zone = e.target.closest('[data-drop]');
    const id = draggingId || e.dataTransfer.getData('text/plain');
    if (zone && id) moveItem(id, zone.dataset.drop, insertionIndex(zone, e.clientY, id));
  });
}

/* A hotel dropped on a day becomes that day's accommodation; anything else
   becomes an ordinary stop. Returns what was created so callers can report it. */
export function dropPlace(place, bucket, index = -1) {
  const data = {
    name: place.name, address: place.display || place.address || '',
    lat: place.lat, lng: place.lng, category: place.category,
  };
  if (place.category === 'lodging' && bucket !== 'unscheduled') {
    return addStay({ ...data, checkIn: bucket, checkOut: addDays(bucket, 1) });
  }
  return addItem(data, bucket, index);
}

function clear(root, keep) {
  root.querySelectorAll('.dragover').forEach(el => el !== keep && el.classList.remove('dragover'));
  root.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
}

/* Where in the list the pointer sits, ignoring the card being dragged. */
function insertionIndex(zone, y, draggedId) {
  if (!zone) return -1;
  const cards = [...zone.querySelectorAll('.card')].filter(c => c.dataset.id !== draggedId);
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return cards.length;
}
