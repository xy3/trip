export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ---------- dates (all trip dates are plain YYYY-MM-DD, no timezones) ---------- */
export const todayKey = () => toKey(new Date());
export const toKey = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fromKey = k => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (key, n) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
};
export const dayCount = (a, b) =>
  Math.round((fromKey(b) - fromKey(a)) / 86400000) + 1;

export const dateRange = (start, end) => {
  if (!start || !end || fromKey(end) < fromKey(start)) return [];
  const out = [];
  for (let k = start; ; k = addDays(k, 1)) {
    out.push(k);
    if (k === end || out.length > 400) break;
  }
  return out;
};

const FMT_LONG = new Intl.DateTimeFormat(undefined,
  { weekday: 'long', month: 'short', day: 'numeric' });
const FMT_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export const fmtDate = k => (k ? FMT_LONG.format(fromKey(k)) : '');
export const fmtDateShort = k => (k ? FMT_SHORT.format(fromKey(k)) : '');

/* ---------- money ---------- */
export const money = (n, cur = 'USD') => {
  if (!n) return '';
  try {
    return new Intl.NumberFormat(undefined,
      { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch { return `${cur} ${n.toFixed(2)}`; }
};

/* ---------- geo ---------- */
export const haversine = (a, b) => {
  const R = 6371, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
export const fmtKm = km => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`);
export const fmtDur = min => {
  if (min < 1) return '<1 min';
  min = Math.round(min);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
};

/* ---------- misc ---------- */
export const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

let toastTimer;
export function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.innerHTML = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fileToDataURL = file => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(file);
});
