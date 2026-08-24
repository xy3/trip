# Trip Planner

A split-screen trip planner: a scrollable itinerary on the left, a live map on the right.
It is a **static site** — no build step, no dependencies to install, no accounts, no server.
Your trip lives in your own browser.

```bash
python3 -m http.server 8123     # then open http://localhost:8123
```

Any static file server works. `file://` does **not**, because the app is built from ES modules.

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
  - [Data model](#data-model)
  - [Where your data lives](#where-your-data-lives)
  - [Day buckets and the date range](#day-buckets-and-the-date-range)
  - [Routing: how a day is drawn](#routing-how-a-day-is-drawn)
  - [Photos](#photos)
  - [Share links](#share-links)
  - [External services](#external-services)
- [Keyboard, mouse and drag targets](#keyboard-mouse-and-drag-targets)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Limits and trade-offs](#limits-and-trade-offs)

---

## What it does

**Workspace**
- Fixed split layout with a draggable divider; the width is remembered.
- Start/end date pickers generate one block per day.
- An **Ideas scratchpad** holds places before they are scheduled.

**Itinerary**
- Drag cards between the scratchpad and any day, or reorder within a day.
- **Accommodation** blocks span check-in → check-out and are pinned to the top of every day
  they cover. Drag a stay to another day to shift the whole booking, use −/+ for nights, or
  press 🛏 on a lodging card to promote it into that day's stay.
- Categories — Food, Sightseeing, Outdoors, Transit, Lodging, Shopping, Nightlife, Other —
  drive the card accent, the tag, and the map marker colour.
- Inline notes on every activity for reservations, confirmation codes and opening hours.
- A cost field per activity and stay, rolled up per day and across the trip.
- Links and file attachments (tickets, PDFs) on any activity.

**Search and map**
- Place search through OpenStreetMap Nominatim. Click a result to add it, or **drag it onto
  a day**. Results recognised as hotels are added as *accommodation* rather than as a stop.
- Click a day header to focus the map on that day; click again, or press **Whole trip**, to
  zoom back out.
- Pins are numbered 1, 2, 3… in itinerary order, with the path drawn between consecutive stops.
- The focused day is routed on real roads with per-leg times and distances printed into the
  timeline. The whole-trip view uses straight lines and `≈` estimates.

**Media**
- Justified photo grids on days, on the scratchpad, on individual activities and on stays.
- Add photos by button, by dragging image files onto a target, or by **pasting** from the clipboard.
- Places added from search get a representative high-resolution Wikipedia photo automatically.
- Click any photo for a full-screen lightbox with ←/→ and a per-image caption.

**Output**
- **Print** produces a clean, map-free itinerary for paper or PDF.
- **Share** copies a read-only URL that carries the whole itinerary inside the link itself.
- ⋯ → export/import a `.trip.json` bundle, which *does* include photos and attachments.

---

## How it works

### Data model

Everything is one plain JSON document, `state.trip`, defined in `js/store.js`:

```js
{
  id, title, currency, startDate, endDate,      // 'YYYY-MM-DD', no timezones anywhere
  items:  { [id]: Activity },                   // every activity, scheduled or not
  stays:  { [id]: Stay },                       // accommodation, keyed separately
  order:  { unscheduled: [id…], '2026-09-01': [id…], … },   // the itinerary itself
  photos: { [bucket]: [{ id, caption, source }] },
  collapsed: { [bucket]: true },
}
```

The important idea is that **`order` is the itinerary** and `items` is just storage. A day is
an array of ids; scheduling something is moving its id between arrays; reordering is moving it
within one. Nothing is duplicated, so an activity cannot be in two days at once, and
`normalize()` enforces exactly that after every structural change.

A **bucket** is any key that can own things: `'unscheduled'`, a date like `'2026-09-01'`, or —
for photos only — an activity or stay id. That one idea is why photos can hang off a day, a
place, or a hotel without any special cases.

**Stays are not activities.** They live in their own map because they span a *range* of days
rather than sitting in one day's order, and are rendered into every day between check-in and
check-out.

Dates are handled as plain `YYYY-MM-DD` strings throughout (`js/util.js`), never as `Date`
objects with a time — so no trip has ever shifted by a day because of a timezone.

### Where your data lives

| What | Where | Why |
|---|---|---|
| The trip document | `localStorage` | Small, synchronous, survives reloads |
| Photos and file attachments | IndexedDB, as blobs keyed by id | Binaries would blow the localStorage quota |
| Split position, toggles | `localStorage` | UI preference, not trip data |

`js/db.js` is the blob store. The trip document only ever holds blob **ids**, so the two stay
decoupled: `referencedBlobs()` collects every id the document still points at, and `db.gc()`
deletes the rest on startup. Object URLs are cached per id and revoked when a photo is removed.

Nothing is uploaded anywhere.

### Day buckets and the date range

Changing the start or end date calls `normalize()`, which:

1. creates an empty bucket for every date in the new range,
2. moves activities from days that no longer exist back into the **scratchpad** rather than
   deleting them,
3. drops ids whose item is gone, de-duplicates, and re-homes orphans.

So shrinking a trip never loses work. An end date earlier than the start is clamped rather
than inverted.

### Routing: how a day is drawn

`dayRoute(dayKey)` in `store.js` builds the day *as travelled* — out of the bed you woke in,
through the stops, into the bed you sleep in:

| Day | Route |
|---|---|
| Check-in day | stops → hotel |
| Middle day | hotel → stops → same hotel |
| Transition day | hotel A → stops → hotel B |
| Check-out day | hotel → stops |
| Same bed, nothing planned | nothing — not a journey |

The morning hotel is the stay with `checkIn < day` (you slept there); the evening hotel is the
stay with `checkOut > day` (you sleep there tonight). The **🛏 Stays in route** toggle turns
this off and falls back to stop-only routing.

That single sequence feeds three things, which is why the map and the timeline can never
disagree:

- **The map** (`js/map.js`) draws the polyline through it.
- **The router** (`js/geo.js`) sends it to OSRM for real road geometry and per-leg times.
- **The timeline** (`js/render.js`) prints each leg above the stop it *arrives at*, anchored by
  id rather than by position — so legs stay correct when a stop has no coordinates.

Only the **focused day** is sent to OSRM. The whole-trip view uses straight lines and
haversine estimates, marked `≈`, both to keep the public routing service happy and to keep
panning fast. The whole-trip view also draws a violet hotel-to-hotel **spine** so the shape of
the journey reads at a glance.

Routing and geocoding results are cached per session; searches are debounced.

### Photos

`js/photos.js` finds one representative image for a place through the Wikipedia API:

1. **Geosearch** around the coordinates. A page whose *title matches the place name* wins
   anywhere in the 1 km radius.
2. Otherwise a **name search**; a title match there wins next.
3. Otherwise a page within **250 m** may stand in as scenery — captioned `· nearby` so you
   know it is the surroundings, not the place.
4. Otherwise nothing. A wrong photo is worse than no photo.

It requests a 1600px rendition rather than the original file, so you get a high-resolution
image without pulling a 20 MB TIFF into IndexedDB, and it identifies itself with an
`Api-User-Agent` header as Wikimedia asks of browser clients. The caption carries the article
title and the lightbox links back to the article.

This runs in the background when a place is added from search, so adding a place never waits
on the network. Toggle it in ⋯ → *Auto-photo new places*; the editor's **✨ Find a photo**
button runs the same lookup on demand.

Photos are stored as blobs and rendered as a **justified grid**: `render.js` groups them into
rows of at most three (four photos become 2 + 2 rather than 3 + 1) and gives each row the sum
of its aspect ratios as a CSS `aspect-ratio`, and each photo a `flex-grow` share of that sum.
Every row therefore fills the full width exactly and every photo in a row is exactly as tall
as its neighbours — no ragged bottoms, no empty columns, at any nesting level.

Within a row the shares use the *square root* of each ratio, which pulls a panorama and a
portrait toward each other instead of leaving the portrait a sliver; `object-fit: cover`
absorbs the small difference. A photo alone in its row keeps its true shape. Ratios are
measured the first time a photo paints and cached on the photo record (`r`), then the row is
rebalanced in place — no re-render, so the scroll position never jumps.

### Share links

`js/share.js` serialises the trip, strips the binaries, deflate-compresses it with
`CompressionStream`, base64url-encodes it, and puts it in the URL **fragment**:

```
https://…/trip/#t=z<compressed itinerary>
```

Opening such a link loads that trip in read-only mode — editing is disabled, saving is a no-op,
and a banner offers *Make an editable copy*, which clones it into the visitor's own browser.

Because it is a fragment it is never sent to a server, which is what makes a static app able to
"share" at all. Two consequences worth knowing: photos and attachments cannot travel this way
(use export/import instead), and anyone holding the link can read the itinerary — treat it as
public.

### External services

| Service | Used for | Key required |
|---|---|---|
| OpenStreetMap tiles | The basemap (filtered dark to match the theme) | no |
| Nominatim | Place search | no |
| OSRM demo server | Road routing for the focused day | no |
| Wikipedia API | Automatic place photos | no |

Leaflet itself is vendored in `vendor/`, so the app has no CDN dependency. Offline, everything
except tiles, search, routing and photo lookup keeps working.

---

## Keyboard, mouse and drag targets

| Action | How |
|---|---|
| Schedule / reorder an activity | Drag a card between days or within one |
| Add a searched place | Click a result, or drag it onto a day |
| Add a hotel as accommodation | Drag a lodging result onto a day (or click it) |
| Move a booking | Drag the stay row onto another day — length is preserved |
| Change nights | −/+ on the stay row; check-out is clamped to the trip's last day |
| Add photos | 🖼 button, drag image files, or paste (⌘/Ctrl+V) |
| Paste target | Whatever is under the pointer → selected activity → focused day → scratchpad |
| Focus a day on the map | Click the day header; click again to zoom back out |
| Collapse a day | The ▾ chevron |
| Edit an activity | ✎, or double-click the card |
| Lightbox | Click a photo; ←/→ to move, Esc to close |

---

## Project layout

```
index.html
css/
  app.css        dark glass theme, layout, components, themed scrollbars
  print.css      restores ink-on-white and strips every effect for paper
js/
  app.js         wiring: header, search UI, timeline events, paste, resizing
  store.js       the trip document, mutations, persistence, day routes
  render.js      timeline markup and travel-leg labels
  map.js         Leaflet layers, numbered pins, routes, lodging spine
  geo.js         Nominatim + OSRM clients, with caching
  photos.js      Wikipedia photo lookup
  dnd.js         drag & drop: cards, stays, search results
  editor.js      activity/stay dialog, links, attachments
  lightbox.js    full-screen gallery
  share.js       share links, export/import bundles
  db.js          IndexedDB blob store
  categories.js  categories, colours, OSM type → category guessing
  util.js        dates, money, distance, small helpers
vendor/          Leaflet 1.9.4 (vendored, no CDN)
test/core.test.mjs
```

The modules form a one-way graph: `store` owns state and notifies subscribers, `render` and
`map` read it and draw, `app` wires input to mutations. Rendering is deliberately dumb — every
change re-renders the timeline from the document rather than patching the DOM, which is fast
enough for a trip and removes a whole class of stale-view bugs.

## Tests

```bash
node test/core.test.mjs
```

Covers the parts worth protecting, with no browser and no network: day-bucket generation,
move/reorder without loss or duplication, date clamping, stays spanning days, cost rollups,
hotel promotion and night arithmetic, all four day-route shapes, the share-link round-trip, and
the photo-lookup selection rules (with `fetch` stubbed, so it stays deterministic).

## Limits and trade-offs

- **One trip at a time** in a browser. Export/import to keep more.
- **Share links can get long.** A large itinerary makes a large URL; some chat apps truncate.
- **Photos are local.** They are in your browser's IndexedDB, not in the share link. Clearing
  site data clears them — export first.
- **The routing and search services are public demo endpoints.** Fine for planning a trip,
  not for bulk use; that is why only the focused day is routed.
- **`prefers-reduced-motion`** is honoured; the theme is dark-only by design, and print
  switches back to ink-on-white.
