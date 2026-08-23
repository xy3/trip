export const CATEGORIES = {
  food:        { label: 'Food',        color: '#ff8a5c', icon: '🍽' },
  sightseeing: { label: 'Sightseeing', color: '#6aa9ff', icon: '📸' },
  outdoors:    { label: 'Outdoors',    color: '#57c98a', icon: '⛰' },
  transit:     { label: 'Transit',     color: '#b18bff', icon: '🚆' },
  lodging:     { label: 'Lodging',     color: '#ff7fb0', icon: '🛏' },
  shopping:    { label: 'Shopping',    color: '#e8c14a', icon: '🛍' },
  nightlife:   { label: 'Nightlife',   color: '#8f9bff', icon: '🍸' },
  other:       { label: 'Other',       color: '#9aa4b2', icon: '📍' },
};
export const catOf = key => CATEGORIES[key] || CATEGORIES.other;
export const catColor = key => catOf(key).color;

/* Best-effort mapping from OSM/Nominatim classes to our categories. */
export function guessCategory({ class: cls = '', type = '' } = {}) {
  const t = `${cls}:${type}`;
  if (/restaurant|cafe|bar|pub|fast_food|bakery|food|ice_cream|biergarten/.test(t)) return 'food';
  if (/hotel|hostel|guest_house|motel|apartment|chalet|camp_site|tourism:.*(hotel)/.test(t)) return 'lodging';
  if (/museum|attraction|artwork|monument|memorial|castle|viewpoint|gallery|historic|place_of_worship|theatre/.test(t)) return 'sightseeing';
  if (/park|garden|beach|peak|nature|forest|water|trail|natural|leisure:park|zoo/.test(t)) return 'outdoors';
  if (/station|airport|aerodrome|bus_stop|railway|ferry|terminal|platform|aeroway|public_transport/.test(t)) return 'transit';
  if (/shop|mall|supermarket|marketplace|department_store/.test(t)) return 'shopping';
  if (/nightclub|casino|cinema/.test(t)) return 'nightlife';
  return 'other';
}
