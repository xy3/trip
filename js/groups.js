/* Small dialog for labelling a run of days ("Tokyo") with a title and colour.
   Mirrors editor.js's pattern: one dialog, opened for either a new group or
   an existing one, closed by the <form method="dialog"> return value. */
import { $, $$ } from './util.js';
import { GROUP_COLORS } from './categories.js';
import { state, groupList, addGroup, updateGroup, removeGroup } from './store.js';

const dlg = $('#groupEditor');
const form = $('#groupForm');
let currentId = null;
let color = GROUP_COLORS[0];

$('#groupColors').innerHTML = GROUP_COLORS
  .map(c => `<button type="button" class="swatch" data-color="${c}" style="--sw:${c}" title="${c}"></button>`)
  .join('');

$('#groupColors').addEventListener('click', e => {
  const sw = e.target.closest('[data-color]');
  if (sw) setColor(sw.dataset.color);
});

function setColor(c) {
  color = c;
  form.color.value = c;
  $$('#groupColors .swatch').forEach(el => el.classList.toggle('active', el.dataset.color === c));
}

/* Opened either blank (new group, defaulting to a single day) or with an id
   (edit an existing one). */
export function openGroupEditor({ id = null, start, end } = {}) {
  if (state.readonly) return;
  const g = id ? groupList().find(x => x.id === id) : null;
  currentId = g ? id : null;

  $('#groupEditorTitle').textContent = g ? 'Edit group' : 'Group days';
  $('#btnDeleteGroup').hidden = !g;

  const day = start || state.trip.startDate;
  form.title.value = g?.title || '';
  form.start.value = g?.start || day;
  form.end.value = g?.end || end || day;
  form.start.min = form.end.min = state.trip.startDate;
  form.start.max = form.end.max = state.trip.endDate;
  setColor(g?.color || GROUP_COLORS[groupList().length % GROUP_COLORS.length]);

  dlg.showModal();
  setTimeout(() => form.title.select(), 30);
}

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') { currentId = null; return; }
  const patch = {
    title: form.title.value.trim(),
    start: form.start.value || state.trip.startDate,
    end: form.end.value || form.start.value || state.trip.startDate,
    color,
  };
  if (currentId) updateGroup(currentId, patch); else addGroup(patch);
  currentId = null;
});

$('#btnDeleteGroup').addEventListener('click', () => {
  if (currentId) removeGroup(currentId);
  dlg.close('deleted');
});
