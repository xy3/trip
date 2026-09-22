/* Node smoke test for the data model + share encoding (no DOM needed). */
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};

const store = await import('../js/store.js');
const { state, UNSCHEDULED } = store;
const { dateRange, dayCount } = await import('../js/util.js');

/* --- date range drives the day buckets --- */
store.replaceTrip({ ...store.blankTrip(), startDate: '2026-09-01', endDate: '2026-09-04' });
assert.deepEqual(store.days(), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
assert.equal(dayCount('2026-09-01', '2026-09-04'), 4);

/* --- adding, moving, reordering --- */
const a = store.addItem({ name: 'Louvre', lat: 48.86, lng: 2.34, category: 'sightseeing', cost: 22 });
const b = store.addItem({ name: 'Café de Flore', lat: 48.854, lng: 2.333, category: 'food', cost: 15 });
assert.deepEqual(store.itemsIn(UNSCHEDULED).map(i => i.name), ['Louvre', 'Café de Flore']);

store.moveItem(a.id, '2026-09-01', 0);
store.moveItem(b.id, '2026-09-01', 0);
assert.deepEqual(store.itemsIn('2026-09-01').map(i => i.name), ['Café de Flore', 'Louvre']);
assert.equal(store.bucketOf(a.id), '2026-09-01');

// reorder within the same day must not drop or duplicate
store.moveItem(b.id, '2026-09-01', 2);
assert.deepEqual(store.itemsIn('2026-09-01').map(i => i.name), ['Louvre', 'Café de Flore']);
assert.equal(store.itemsIn('2026-09-01').length, 2);

/* --- shrinking the range returns orphaned stops to the scratchpad --- */
store.addItem({ name: 'Sacré-Cœur' }, '2026-09-04');
store.setTripField('endDate', '2026-09-02');
assert.deepEqual(store.days(), ['2026-09-01', '2026-09-02']);
assert.deepEqual(store.itemsIn(UNSCHEDULED).map(i => i.name), ['Sacré-Cœur']);

/* --- an end date before the start date is clamped, never inverted --- */
store.setTripField('startDate', '2026-09-10');
assert.equal(state.trip.endDate, '2026-09-10');
store.setTripField('startDate', '2026-09-01');
store.setTripField('endDate', '2026-09-03');
// the range moved away and back, so everything is unscheduled again
assert.equal(store.itemsIn(UNSCHEDULED).length, 3);
store.moveItem(a.id, '2026-09-01', 0);
store.moveItem(b.id, '2026-09-01', 1);

/* --- stays span days and roll up on check-in --- */
const stay = store.addStay({ name: 'Hôtel du Nord', checkIn: '2026-09-01', checkOut: '2026-09-03', cost: 300 });
assert.deepEqual(store.staysOn('2026-09-02').map(s => s.id), [stay.id]);
assert.equal(store.staysOn('2026-09-09').length, 0);
assert.equal(store.dayCost('2026-09-01'), 22 + 15 + 300);
assert.equal(store.dayCost('2026-09-02'), 0);
assert.equal(store.tripCost(), 337);

/* --- map view selection --- */
state.focusDay = '2026-09-01';
assert.equal(store.mapPlaces().route.length, 2);
state.focusDay = null;
assert.equal(store.mapPlaces().route.length, 2, 'whole trip shows every scheduled stop with coords');
assert.equal(store.mapPlaces().loose.length, 0, 'Sacré-Cœur has no coordinates');

/* --- hotels: search result -> accommodation --- */
const { dropPlace } = await import('../js/dnd.js');
store.setTripField('endDate', '2026-09-05');

const hotel = dropPlace(
  { name: 'Hôtel Voltaire', display: '10 Rue…', lat: 48.85, lng: 2.36, category: 'lodging' },
  '2026-09-02');
assert.ok(store.isStay(hotel.id), 'a lodging result dropped on a day becomes a stay');
assert.deepEqual([hotel.checkIn, hotel.checkOut], ['2026-09-02', '2026-09-03']);
assert.deepEqual(store.staysOn('2026-09-03').map(s => s.id).includes(hotel.id), true);

// the same result dropped on the scratchpad is just an idea
const idea = dropPlace({ name: 'Hôtel Voltaire', lat: 48.85, lng: 2.36, category: 'lodging' }, UNSCHEDULED);
assert.equal(store.isStay(idea.id), false);

// …and can be promoted later
const promoted = store.convertToStay(idea.id, '2026-09-04');
assert.ok(store.isStay(promoted.id));
assert.equal(store.getAny(idea.id), null, 'the activity is gone once promoted');
assert.equal(store.itemsIn(UNSCHEDULED).some(i => i.id === idea.id), false);

// nights and moves keep the stay inside the trip
store.addStayNights(hotel.id, 2);
assert.equal(hotel.checkOut, '2026-09-05');
store.addStayNights(hotel.id, -1);
assert.equal(hotel.checkOut, '2026-09-04');
store.moveStay(hotel.id, '2026-09-03');
assert.deepEqual([hotel.checkIn, hotel.checkOut], ['2026-09-03', '2026-09-05'], 'length is preserved');
store.moveStay(hotel.id, '2026-09-05');
assert.equal(hotel.checkOut, '2026-09-05', 'check-out never runs past the end of the trip');
store.addStayNights(hotel.id, -5);
assert.equal(hotel.checkOut, '2026-09-05', 'a one-night minimum still clamps to the last day');

// a non-lodging result is an ordinary stop
const stop = dropPlace({ name: 'Panthéon', lat: 48.846, lng: 2.346, category: 'sightseeing' }, '2026-09-02', 0);
assert.equal(store.isStay(stop.id), false);
assert.equal(store.itemsIn('2026-09-02')[0].id, stop.id);

/* --- routes run through where you are staying --- */
store.replaceTrip({ ...store.blankTrip(), startDate: '2026-10-01', endDate: '2026-10-04' });
const h1 = store.addStay({ name: 'Hotel One', lat: 1, lng: 1, checkIn: '2026-10-01', checkOut: '2026-10-02' });
const h2 = store.addStay({ name: 'Hotel Two', lat: 2, lng: 2, checkIn: '2026-10-02', checkOut: '2026-10-04' });
store.addItem({ name: 'Museum', lat: 1.5, lng: 1.5 }, '2026-10-01');

const roles = key => store.dayRoute(key).map(r => `${r.role}:${r.name}`);
// check-in day: stops first, then into the bed you sleep in
assert.deepEqual(roles('2026-10-01'), ['stop:Museum', 'to-stay:Hotel One']);
// transition day: one hotel to the next
assert.deepEqual(roles('2026-10-02'), ['from-stay:Hotel One', 'to-stay:Hotel Two']);
// same bed, nothing planned — not a journey
assert.deepEqual(roles('2026-10-03'), []);
// check-out day: out of the hotel, nothing after it
assert.deepEqual(roles('2026-10-04'), ['from-stay:Hotel Two']);

store.setIncludeStays(false);
assert.deepEqual(roles('2026-10-02'), [], 'lodging can be left out of the routes');
assert.deepEqual(roles('2026-10-01'), ['stop:Museum']);
store.setIncludeStays(true);

assert.deepEqual(store.staySpine().map(s => s.name), ['Hotel One', 'Hotel Two']);
assert.equal(store.staySpine().every(s => Number.isFinite(s.lat)), true);
void h1; void h2;

/* --- automatic place photos (Wikipedia lookup, with fetch stubbed) --- */
const { findPhoto } = await import('../js/photos.js');

const page = (pageid, title, extra = {}) => ({
  pageid, title, thumbnail: { source: `https://upload.example/${pageid}.jpg` }, ...extra,
});
const at = (lat, lon) => ({ coordinates: [{ lat, lon }] });

let geoPages = {}, namePages = {};
globalThis.fetch = async url => {
  const u = String(url);
  if (u.includes('generator=geosearch')) return Response.json({ query: { pages: geoPages } });
  if (u.includes('generator=search')) return Response.json({ query: { pages: namePages } });
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
};

// a page named after the place wins, even when something else is closer
geoPages = { a: page(1, 'Regent Diamond', at(48.8606, 2.3376)), b: page(2, 'Louvre', at(48.8615, 2.3380)) };
namePages = {};
let got = await findPhoto({ name: 'Musée du Louvre', lat: 48.8606, lng: 2.3376 });
assert.equal(got.caption, 'Louvre · Wikipedia');
assert.equal(got.nearby, false);
assert.equal(got.source, 'https://en.wikipedia.org/?curid=2');

// no name match, but something is right on the spot: usable, and labelled
geoPages = { a: page(1, 'Regent Diamond', at(48.8606, 2.3376)) };
got = await findPhoto({ name: "Bob's Imaginary Bistro", lat: 48.8606, lng: 2.3376 });
assert.equal(got.caption, 'Regent Diamond · nearby · Wikipedia');
assert.equal(got.nearby, true);

// unrelated page 3 km away: not scenery, and the name search finds nothing
geoPages = { a: page(1, 'Some Church', at(48.89, 2.37)) };
got = await findPhoto({ name: "Bob's Imaginary Bistro", lat: 48.8606, lng: 2.3376 });
assert.equal(got, null, 'an unrelated distant page is never used');

// a name search hit outranks a merely nearby page
geoPages = { a: page(1, 'Regent Diamond', at(48.8606, 2.3376)) };
namePages = { b: page(9, 'Colosseum') };
got = await findPhoto({ name: 'Colosseum', lat: 48.8606, lng: 2.3376 });
assert.equal(got.caption, 'Colosseum · Wikipedia');

// non-image responses are rejected rather than stored
globalThis.fetch = async url => String(url).includes('api.php')
  ? Response.json({ query: { pages: { a: page(1, 'Colosseum') } } })
  : new Response(new Blob(['<html>'], { type: 'text/html' }));
assert.equal(await findPhoto({ name: 'Colosseum' }), null, 'an HTML error page is not a photo');

/* --- persistence round-trip --- */
const before = JSON.stringify(state.trip);
store.load();
assert.equal(JSON.stringify(state.trip), before);

/* --- share link round-trip --- */
const share = await import('../js/share.js');
globalThis.location = { href: 'https://example.com/trip/', hash: '' };
const { url, photosIncluded } = await share.buildShareLink();
assert.match(url, /^https:\/\/example\.com\/trip\/#t=z/);
assert.equal(photosIncluded, false, 'no account in this test, so the link falls back to the fragment form');
const decoded = await share.tripFromHash(new URL(url).hash);
assert.equal(decoded.title, state.trip.title);
assert.equal(Object.keys(decoded.items).length, Object.keys(state.trip.items).length);
assert.ok(state.trip.order['2026-10-01'].length, 'sanity: the day we compare is populated');
assert.deepEqual(decoded.order['2026-10-01'], state.trip.order['2026-10-01']);
assert.equal(Object.keys(decoded.stays).length, 2, 'stays travel in the share link');
assert.deepEqual(decoded.photos, {}, 'no photos were added in this test, so none travel');
assert.equal(await share.tripFromHash('#nope'), null);

// "hide prices" strips cost from the link, but never from the trip you're editing
const priceTest = store.addItem({ name: 'Ferry', cost: 40 }, '2026-10-01');
store.setTripField('hidePrices', true);
const { url: url2 } = await share.buildShareLink();
const decoded2 = await share.tripFromHash(new URL(url2).hash);
assert.equal(decoded2.items[priceTest.id].cost, null, 'cost is stripped from the shared copy');
assert.equal(decoded2.hidePrices, undefined, 'the preference itself does not travel in the link');
assert.equal(state.trip.items[priceTest.id].cost, 40, 'your own trip keeps its real cost');
store.setTripField('hidePrices', false);

/* --- day groups: label, colour, and clip a run of days --- */
store.replaceTrip({ ...store.blankTrip(), startDate: '2026-11-01', endDate: '2026-11-06' });
const tokyo = store.addGroup({ title: 'Tokyo', color: '#f2b705', start: '2026-11-01', end: '2026-11-03' });
assert.equal(store.groupFor('2026-11-02').id, tokyo.id);
assert.equal(store.groupFor('2026-11-04'), null, 'a day outside the span belongs to no group');
assert.deepEqual(store.groupList().map(g => g.id), [tokyo.id]);

// a second group overlapping the first's tail end clips the first instead of stacking
const kyoto = store.addGroup({ title: 'Kyoto', color: '#6aa9ff', start: '2026-11-03', end: '2026-11-06' });
assert.equal(store.groupFor('2026-11-03').id, kyoto.id, 'the newer span wins the contested day');
assert.equal(state.trip.groups.find(g => g.id === tokyo.id)?.end, '2026-11-02');

store.updateGroup(tokyo.id, { title: 'Tōkyō' });
assert.equal(store.groupFor('2026-11-01').title, 'Tōkyō');

// shrinking the trip drops a group that falls entirely outside the new range,
// and clips one that only partly does
store.setTripField('endDate', '2026-11-04');
assert.equal(store.groupFor('2026-11-04').id, kyoto.id, 'partially-covered group survives, clipped');
assert.equal(state.trip.groups.find(g => g.id === kyoto.id)?.end, '2026-11-04');

store.removeGroup(kyoto.id);
assert.equal(store.groupList().length, 1);

/* --- booking checklist: flights, activities, stays, and inferred transport --- */
store.replaceTrip({ ...store.blankTrip(), startDate: '2026-12-01', endDate: '2026-12-05' });
const parisHotel = store.addStay({ name: 'Paris Hotel', checkIn: '2026-12-01', checkOut: '2026-12-02', cost: 100 });
const romeHotel = store.addStay({ name: 'Rome Hotel', checkIn: '2026-12-03', checkOut: '2026-12-05', cost: 150 });
const dinner = store.addItem({ name: 'Dinner', category: 'food', cost: 40 }, '2026-12-01');

let entries = store.bookingEntries();
assert.deepEqual(entries.map(e => e.name), [
  'Outbound flight',                                   // bookends the trip regardless of what's scheduled
  'Transport from the airport to Paris Hotel',          // inferred: nothing gets you there yet
  'Paris Hotel', 'Dinner',
  'Transport from Paris Hotel to Rome Hotel',           // inferred: the gap between the two stays
  'Rome Hotel',
  'Transport from Rome Hotel to the airport',
  'Return flight',
]);
assert.equal(entries.every(e => !e.confirmed && !e.paid), true, 'nothing booked yet');

// a transit activity scheduled in a gap covers only that gap — the airport
// legs at either end are a separate inference and are untouched
const train = store.addItem({ name: 'Train to Rome', category: 'transit' }, '2026-12-02');
entries = store.bookingEntries();
assert.equal(entries.some(e => e.name === 'Transport from Paris Hotel to Rome Hotel'), false, 'a scheduled transit stop covers the gap');
assert.equal(entries.some(e => e.name === 'Transport from the airport to Paris Hotel'), true, 'the arrival leg is a different gap');
assert.equal(entries.some(e => e.name === 'Transport from Rome Hotel to the airport'), true, 'the departure leg is a different gap');
await store.removeItem(train.id);
assert.equal(store.bookingEntries().some(e => e.name === 'Transport from Paris Hotel to Rome Hotel'), true, 'gap reappears once the transit stop is gone');

// a flight has no backing item either — same bookingMeta-only price as a transport gap
const outbound = () => store.bookingEntries().find(e => e.id === 'flight:outbound');
store.setBooking('flight:outbound', 'flight', { cost: 480, confirmed: true, time: 'BA345, 09:20' });
assert.equal(outbound().cost, 480);
assert.equal(outbound().confirmed, true);
assert.equal(outbound().time, 'BA345, 09:20');

// confirmed -> paid, and back down again
store.setBooking(dinner.id, 'item', { confirmed: true, time: '19:30', notes: 'Window table requested' });
let d = () => store.bookingEntries().find(e => e.id === dinner.id);
assert.equal(d().confirmed, true);
assert.equal(d().paid, false, 'not paid until marked so');
assert.equal(d().time, '19:30');

store.setBooking(dinner.id, 'item', { paid: true });
assert.equal(d().paid, true);

store.setBooking(dinner.id, 'item', { confirmed: false });
assert.equal(d().paid, false, 'un-confirming also clears paid — nothing can be paid without being confirmed');

// a checklist price edit for an activity/stay IS its `cost` field — the same
// one the day/trip totals already use, not a second number to keep in sync
store.setBooking(dinner.id, 'item', { cost: 55 });
assert.equal(state.trip.items[dinner.id].cost, 55);
assert.equal(d().cost, 55);

// a transport gap has no backing item, so its price lives in bookingMeta
const gap = () => store.bookingEntries().find(e => e.kind === 'transport');
store.setBooking(gap().id, 'transport', { cost: 120, confirmed: true });
assert.equal(gap().cost, 120);
assert.equal(gap().confirmed, true);

// deleting a booked activity forgets its booking status too
store.setBooking(romeHotel.id, 'stay', { confirmed: true });
await store.removeItem(dinner.id);
store.setTripField('endDate', state.trip.endDate);   // re-normalize without changing anything
assert.equal(state.trip.bookingMeta[dinner.id], undefined, 'booking status for a deleted item is pruned');
assert.equal(state.trip.bookingMeta[romeHotel.id]?.confirmed, true, 'a still-existing stay keeps its status');
assert.equal(state.trip.bookingMeta['flight:outbound']?.confirmed, true, 'a flight always keeps its status — it has no backing record to be pruned for');

console.log('all core checks passed');
