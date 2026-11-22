'use strict';
/* MOONWEB UI kit: reusable components used by every page. */

// ---------- toasts ----------
function toast(message, kind = 'info') {
  const ic = { success: 'checkCircle', error: 'alertCircle', info: 'info' }[kind] || 'info';
  let timer;
  const dismiss = () => { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(ic, 18), h('span', { class: 'toast-msg', text: message }),
    h('button', { class: 'toast-x', 'aria-label': 'Dismiss', onclick: dismiss }, icon('x', 14)));
  const box = document.getElementById('toasts');
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  timer = setTimeout(dismiss, kind === 'error' ? 6500 : 4000);
}

// ---------- modal ----------
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function modal({ title, subtitle, body, footer, size = '', top = false, onClose } = {}) {
  const prev = document.activeElement;
  let closed = false;
  const closeBtn = h('button', { class: 'btn ghost small icon-only', 'aria-label': 'Close', onclick: () => close() }, icon('x', 16));
  const dlg = h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog', tabindex: '-1' },
    title && h('div', { class: 'modal-head' }, h('div', {}, h('h2', { text: title }), subtitle && h('p', { text: subtitle })), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer && h('div', { class: 'modal-foot' }, footer));
  const overlay = h('div', { class: `overlay${top ? ' top' : ''}` }, dlg);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const f = [...dlg.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 200);
    try { prev?.focus?.(); } catch { /* ignore */ }
    onClose?.(result);
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  (dlg.querySelector('input:not([type=hidden]),select,textarea') || dlg).focus();
  return { close, el: dlg };
}

/** Promise<boolean>. tone: 'danger' makes the confirm button red. */
function confirmDialog({ title, body, confirmText = 'Confirm', tone = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ok = h('button', { class: `btn ${tone === 'danger' ? 'danger solid' : 'primary'}`, text: confirmText });
    const m = modal({
      title, size: '', body: typeof body === 'string' ? h('p', { class: 'muted', text: body }) : body,
      footer: [h('button', { class: 'btn', text: 'Cancel', onclick: () => { finish(false); m.close(); } }), ok],
      onClose: () => finish(false),
    });
    ok.addEventListener('click', () => { finish(true); m.close(); });
  });
}

// ---------- popover / dropdown ----------
let openPop = null;
function closePopover() { openPop?.(); }
function popover(trigger, build, { minWidth } = {}) {
  let pop = null;
  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null; openPop = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
    window.removeEventListener('resize', close);
    trigger.setAttribute('aria-expanded', 'false');
  };
  const outside = (e) => { if (pop && !pop.contains(e.target) && !trigger.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); trigger.focus(); } };
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', () => {
    if (pop) return close();
    closePopover();
    pop = h('div', { class: 'popover', role: 'menu' }, build(close));
    if (minWidth) pop.style.minWidth = `${minWidth}px`;
    document.body.append(pop);
    const r = trigger.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.min(Math.max(12, r.right - w), window.innerWidth - w - 12);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 80)}px`;
    openPop = close;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', close);
  });
  return close;
}
const popItem = (ic, label, onclick, extra = {}) => h('button', { class: `pop-item ${extra.danger ? 'danger' : ''}`, role: 'menuitem', onclick }, icon(ic, 16), h('span', { text: label }), extra.hint && h('small', { text: extra.hint }));

// ---------- layout pieces ----------
const pageHeader = (title, subtitle, actions) => h('div', { class: 'page-head' },
  h('div', {}, h('h1', { text: title }), subtitle && h('p', { text: subtitle })),
  actions && h('div', { class: 'actions-row' }, actions));

const card = ({ title, subtitle, actions, class: cls = '' } = {}, ...children) => h('section', { class: `card ${cls}` },
  (title || actions) && h('div', { class: 'card-head' }, h('div', {}, title && h('h2', { text: title }), subtitle && h('p', { text: subtitle })), actions),
  ...children);

const statCard = ({ label, value, ic, tone = 'neutral', hint }) => h('div', { class: `card stat tone-${tone}` },
  h('span', { class: 'ibubble' }, icon(ic, 19)),
  h('div', {}, h('b', { text: String(value) }), h('span', { class: 'lbl', text: label }), hint && h('small', { text: hint })));

function emptyState({ ic = 'info', title, text, action, tone = 'neutral', compact = false }) {
  return h('div', { class: `empty tone-${tone}${compact ? ' compact' : ''}` },
    h('span', { class: 'ibubble' }, icon(ic, 22)),
    h('h3', { text: title }), text && h('p', { text }), action);
}

function skeleton(w = '100%', ht = 14) {
  const el = h('span', { class: 'skeleton' });
  el.style.width = typeof w === 'number' ? `${w}px` : w;
  el.style.height = `${ht}px`;
  return el;
}
const skeletonRows = (n = 4) => h('div', { class: 'activity' }, Array.from({ length: n }, () =>
  h('div', { class: 'act' }, skeleton(38, 38), h('div', { class: 'txt' }, skeleton('70%', 13), h('div', {}, skeleton('40%', 10))))));

function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'tablist' });
  const btns = options.map(([id, label]) => {
    const b = h('button', { role: 'tab', class: id === value ? 'on' : '', text: label, 'aria-selected': String(id === value), onclick: () => { btns.forEach((x, i) => x.classList.toggle('on', options[i][0] === id)); onChange(id); } });
    return b;
  });
  wrap.append(...btns);
  return wrap;
}

const actionBadge = (type) => { const m = metaOf(type); return h('span', { class: `badge tone-${m.tone}` }, icon(m.icon, 12), m.label); };
const actionBubble = (type, small) => { const m = metaOf(type); return h('span', { class: `ibubble tone-${m.tone}${small ? ' sm' : ''}` }, icon(m.icon, small ? 16 : 18)); };
const avatarEl = (name, url) => h('span', { class: 'avatar' }, url ? h('img', { src: url, alt: '' }) : initials(name));
const guildIconEl = (g, cls = '') => h('span', { class: `gicon ${cls}` }, g.icon ? h('img', { src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`, alt: '' }) : initials(g.name));
const btnSpinner = (btn, on, label) => { btn.disabled = on; btn.replaceChildren(...(on ? [h('span', { class: 'spin' }), label] : [label])); };

// ---------- form helpers (mutate `obj[key]` and flag unsaved changes) ----------
const s = () => state.data.settings;
function markDirty() {
  state.dirty = true;
  document.querySelectorAll('.savebar').forEach((b) => { b.classList.add('dirty'); b.querySelector('.state').textContent = 'You have unsaved changes'; });
}
function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint && h('div', { class: 'hint', text: hint }));
}
function check(label, obj, key, onChange, desc) {
  const input = h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; markDirty(); onChange?.(e.target.checked); } });
  return h('label', { class: 'check' }, input, h('span', {}, label, desc && h('small', { text: desc })));
}
const num = (obj, key, min, max) => h('input', { type: 'number', value: obj[key], min, max, onchange: (e) => { obj[key] = Number(e.target.value); markDirty(); } });
function chanSelect(obj, key, none = '— None —') {
  return h('select', { onchange: (e) => { obj[key] = e.target.value || null; markDirty(); } },
    h('option', { value: '', text: none, selected: !obj[key] }),
    state.data.channels.map((c) => h('option', { value: c.id, text: `# ${c.name}`, selected: obj[key] === c.id })));
}
function roleSelect(obj, key, none = '— None —') {
  return h('select', { onchange: (e) => { obj[key] = e.target.value || null; markDirty(); } },
    h('option', { value: '', text: none, selected: !obj[key] }),
    state.data.roles.map((r) => h('option', { value: r.id, text: r.name, selected: obj[key] === r.id })));
}
const multi = (obj, key, options, prefix = '') => h('select', { multiple: true, onchange: (e) => { obj[key] = [...e.target.selectedOptions].map((o) => o.value); markDirty(); } },
  options.map((o) => h('option', { value: o.id, text: prefix + o.name, selected: obj[key].includes(o.id) })));
const listArea = (obj, key, placeholder) => h('textarea', { placeholder, onchange: (e) => { obj[key] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); markDirty(); } }, obj[key].join('\n'));

/** Copy `src` into `dst` keeping the identity of nested objects, so forms that captured them keep editing live state. */
function syncInto(dst, src) {
  for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) syncInto(dst[k], v);
    else dst[k] = v;
  }
}
async function saveSettings(btn) {
  btnSpinner(btn, true, 'Saving…');
  try {
    const { settings, warnings } = await api(`/guilds/${state.guildId}/settings`, { method: 'PUT', json: s() });
    syncInto(state.data.settings, settings);
    state.dirty = false;
    document.querySelectorAll('.savebar').forEach((b) => { b.classList.remove('dirty'); b.querySelector('.state').textContent = 'All changes saved'; });
    toast('Settings saved', 'success');
    if (warnings?.length) toast(`Saved, but: ${warnings.slice(0, 2).join(' ')}${warnings.length > 2 ? ` (+${warnings.length - 2} more)` : ''}`, 'warning');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btnSpinner(btn, false, 'Save changes');
  }
}
function saveBar() {
  const save = h('button', { class: 'btn primary', text: 'Save changes' });
  save.addEventListener('click', () => saveSettings(save));
  const discard = h('button', { class: 'btn ghost', text: 'Discard', onclick: async () => {
    try {
      const d = await api(`/guilds/${state.guildId}`);
      state.data.settings = d.settings; state.dirty = false; mountPage();
      toast('Changes discarded', 'info');
    } catch (e) { toast(e.message, 'error'); }
  } });
  return h('div', { class: `savebar${state.dirty ? ' dirty' : ''}` },
    h('span', { class: 'state', text: state.dirty ? 'You have unsaved changes' : 'All changes saved' }), discard, save);
}
const ruleBlock = (title, obj, body, desc) => h('div', { class: 'rule' }, check(title, obj, 'enabled', null, desc), body && h('div', { class: 'body' }, body));

// ---------- member selector ----------
function memberSelector(currentUserId, onSelect) {
  let selected = null;
  const input = h('input', { type: 'text', placeholder: 'Search by name or ID…', autocomplete: 'off' });
  const container = h('div', { class: 'member-sel' }, input);
  const results = h('div', { class: 'pal-list', hidden: true });
  container.append(results);

  async function fetchMember(id) {
    try {
      const m = await api(`/guilds/${state.guildId}/members/${id}`);
      selected = m;
      updateDisplay();
      onSelect(m.id);
    } catch (e) { toast(e.message, 'error'); }
  }

  function updateDisplay() {
    // Remove any existing clear button before adding a new one
    const existingClear = Array.from(container.children).find(child => child.classList?.contains('btn'));
    if (existingClear) container.removeChild(existingClear);

    if (selected) {
      input.value = `${selected.displayName} (@${selected.username})`;
      input.readOnly = true;
      const clear = h('button', { class: 'btn ghost small icon-only', onclick: (e) => {
        e.preventDefault();
        selected = null; input.value = ''; input.readOnly = false;
        updateDisplay();
        onSelect('');
      } }, icon('x', 14));
      container.append(clear);
    }
  }

  if (currentUserId) fetchMember(currentUserId);

  let searchTimer;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    results.hidden = true;
    if (input.value.length < 2) return;
    searchTimer = setTimeout(async () => {
      try {
        const { members } = await api(`/guilds/${state.guildId}/members/search?q=${encodeURIComponent(input.value)}`);
        results.replaceChildren(...members.map(m => h('button', { class: 'pop-item', onclick: () => {
          selected = m;
          results.hidden = true;
          updateDisplay();
          onSelect(m.id);
        } }, avatarEl(m.username, m.avatar), h('span', { text: `${m.displayName} (@${m.username})` }))));
        results.hidden = members.length === 0;
      } catch (e) { toast(e.message, 'error'); }
    }, 300);
  });

  return container;
}
