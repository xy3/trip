/* The booking checklist: one row per activity, stay, and inferred transport
   gap, with editable price/time/notes and a confirmed → paid status ladder.
   Kept out of the printed itinerary entirely (see print.css) since it's
   working notes for the planner, not something a guest reading the PDF needs. */
import { state, bookingEntries, setBooking, photosOf } from './store.js';
import { catOf } from './categories.js';
import { $, esc, fmtDateShort, money } from './util.js';
import * as db from './db.js';

const cur = () => state.trip.currency || 'EUR';

/* Price and the time/notes details are hidden behind "+ add" prompts until
   there's something to show, or the prompt's been clicked — purely a
   this-page-load UI state, never persisted, so it resets on reload. */
const openPrice = new Set();
const openDetails = new Set();

export function renderBooking() {
  const panel = $('#bookingPanel');
  if (!panel) return;
  const entries = bookingEntries();
  const scrollTop = panel.scrollTop;
  panel.innerHTML = entries.length ? [summary(entries), ...entries.map(row)].join('') : empty();
  panel.scrollTop = scrollTop;
  hydrateThumbs(panel);
}

/* One small thumbnail per row — whatever photo already hangs off that
   activity or stay, if any. A transport gap has no bucket of its own, so
   photosOf() is simply empty for it and no thumbnail is drawn. */
function thumb(bucket) {
  const p = photosOf(bucket)[0];
  if (!p) return '';
  return `<img class="booking-thumb" data-blob="${p.id}"${p.url ? ` src="${esc(p.url)}"` : ''} alt="">`;
}

function hydrateThumbs(root) {
  for (const img of root.querySelectorAll('.booking-thumb[data-blob]')) {
    if (img.getAttribute('src')) continue;   // a shared trip: already a real URL
    db.blobURL(img.dataset.blob).then(url => { if (url) img.src = url; });
  }
}

function empty() {
  return `<div class="booking-empty">Nothing to book yet — add some stays and activities to your trip and they'll show up here.</div>`;
}

function summary(entries) {
  const n = entries.length;
  const confirmed = entries.filter(e => e.confirmed).length;
  const paid = entries.filter(e => e.paid).length;
  const total = entries.reduce((s, e) => s + (Number(e.cost) || 0), 0);
  const stat = (v, label) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`;
  return `<div class="booking-summary">
    ${stat(n, n === 1 ? 'to book' : 'to book')}
    ${stat(`${confirmed}/${n}`, 'confirmed')}
    ${stat(`${paid}/${n}`, 'paid')}
    ${total ? stat(money(total, cur()), 'total') : ''}
  </div>`;
}

const FLIGHT_TAG = { icon: '✈️', label: 'Flight', color: '#7ab8ff' };

function row(e) {
  const c = e.kind === 'flight' ? FLIGHT_TAG : catOf(e.category);
  const status = e.paid ? 'paid' : e.confirmed ? 'confirmed' : 'open';
  const priceShown = openPrice.has(e.id) || e.cost != null;
  const detailsShown = openDetails.has(e.id) || !!(e.time || e.notes);

  const priceField = priceShown
    ? `<label class="bf">Price<input type="number" step="0.01" min="0" class="b-cost" placeholder="0.00" value="${e.cost ?? ''}"></label>`
    : `<button type="button" class="btn-link" data-add-price="${e.id}">+ Add price</button>`;

  const detailsPrompt = `<button type="button" class="btn-link" data-add-details="${e.id}">+ Add details</button>`;
  const detailsFields = `<div class="booking-details">
      <label class="bf">Booked for
        <input type="text" class="b-time" placeholder="Time, flight no., confirmation code…" value="${esc(e.time)}">
      </label>
      <textarea class="b-notes" placeholder="Any other details…">${esc(e.notes)}</textarea>
    </div>`;

  return `
  <div class="booking-row status-${status}" data-booking="${e.id}" data-kind="${e.kind}">
    ${thumb(e.id)}
    <div class="booking-body">
      <div class="booking-top">
        <span class="cat-tag" style="--cat:${c.color}">${c.icon} ${c.label}</span>
        <span class="booking-name">${esc(e.name)}</span>
        <span class="booking-date">${esc(fmtDateShort(e.date))}</span>
      </div>
      <div class="booking-fields">
        ${priceField}
        <label class="bf-check"><input type="checkbox" class="b-confirmed" ${e.confirmed ? 'checked' : ''}> Confirmed</label>
        <label class="bf-check"><input type="checkbox" class="b-paid" ${e.paid ? 'checked' : ''} ${e.confirmed ? '' : 'disabled'}> Paid</label>
        ${detailsShown ? '' : detailsPrompt}
      </div>
      ${detailsShown ? detailsFields : ''}
    </div>
  </div>`;
}

export function initBooking() {
  const panel = $('#bookingPanel');
  if (!panel) return;

  panel.addEventListener('click', e => {
    const addPrice = e.target.closest('[data-add-price]');
    if (addPrice) {
      openPrice.add(addPrice.dataset.addPrice);
      renderBooking();
      panel.querySelector(`[data-booking="${addPrice.dataset.addPrice}"] .b-cost`)?.focus();
      return;
    }
    const addDetails = e.target.closest('[data-add-details]');
    if (addDetails) {
      openDetails.add(addDetails.dataset.addDetails);
      renderBooking();
      panel.querySelector(`[data-booking="${addDetails.dataset.addDetails}"] .b-time`)?.focus();
    }
  });

  panel.addEventListener('change', e => {
    if (state.readonly) return;
    const line = e.target.closest('.booking-row');
    if (!line) return;
    const { booking: id, kind } = line.dataset;

    if (e.target.matches('.b-cost')) {
      const v = e.target.value.trim();
      setBooking(id, kind, { cost: v === '' ? null : Number(v) });
    } else if (e.target.matches('.b-time')) {
      setBooking(id, kind, { time: e.target.value });
    } else if (e.target.matches('.b-notes')) {
      setBooking(id, kind, { notes: e.target.value });
    } else if (e.target.matches('.b-confirmed')) {
      setBooking(id, kind, { confirmed: e.target.checked });
    } else if (e.target.matches('.b-paid')) {
      setBooking(id, kind, { paid: e.target.checked });
    }
  });
}
