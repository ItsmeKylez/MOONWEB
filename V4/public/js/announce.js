'use strict';
/* MOONWEB announcements (Stage 5): embed editor + live preview, templates, scheduling, history. Talks to /api/guilds/:id/announcements. */

const AN = { tab: 'compose', meta: null, draft: null, mode: null, backup: null, hist: { page: 1, status: '' }, body: null, saveTimer: null, limits: null };
const anUrl = (p = '') => `/guilds/${state.guildId}/announcements${p}`;

const blankEmbed = () => ({ title: '', description: '', url: '', color: '#8B5CF6', timestamp: false, author: { name: '', icon_url: '', url: '' }, footer: { text: '', icon_url: '' }, thumbnail: '', image: '', fields: [] });
const blankDraft = () => ({ content: '', embeds: [], buttons: [], mentions: { everyone: false, roles: true, users: true }, channelIds: [], scheduleOn: false, scheduledLocal: '' });
const hex = (n) => `#${Number(n).toString(16).padStart(6, '0')}`;

/** Server payload -> editor model */
function fromPayload(p, extra = {}) {
  const d = blankDraft();
  d.content = p.content || ''; d.buttons = (p.buttons || []).map((b) => ({ label: b.label, url: b.url }));
  d.mentions = { everyone: !!p.mentions?.everyone, roles: p.mentions?.roles !== false, users: p.mentions?.users !== false };
  d.embeds = (p.embeds || []).map((e) => ({ ...blankEmbed(), ...e, color: e.color === undefined ? '#8B5CF6' : hex(e.color), author: { ...blankEmbed().author, ...e.author }, footer: { ...blankEmbed().footer, ...e.footer }, fields: (e.fields || []).map((f) => ({ ...f })), thumbnail: e.thumbnail || '', image: e.image || '' }));
  return Object.assign(d, extra);
}
/** Editor model -> payload for the API (blank strings dropped) */
function toPayload(d) {
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));
  return {
    content: d.content, mentions: d.mentions, buttons: d.buttons.filter((b) => b.label || b.url),
    embeds: d.embeds.map((e) => {
      const o = clean({ title: e.title, description: e.description, url: e.url, color: e.color, thumbnail: e.thumbnail, image: e.image });
      if (e.timestamp) o.timestamp = true;
      const a = clean(e.author); if (Object.keys(a).length) o.author = a;
      const f = clean(e.footer); if (Object.keys(f).length) o.footer = f;
      const fl = e.fields.filter((x) => x.name || x.value); if (fl.length) o.fields = fl;
      return o;
    }),
  };
}
const draftHasContent = (d) => !!(d.content || d.embeds.length || d.buttons.length);

// ---------- Discord-style rendering for the preview ----------
function dcText(text) {
  const out = []; let last = 0; let m;
  const re = /<@&(\d+)>|<#(\d+)>|<@!?(\d+)>|@everyone|@here|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('span', { class: 'dc-mention', text: `@${state.data.roles.find((r) => r.id === m[1])?.name || 'unknown-role'}` }));
    else if (m[2]) out.push(h('span', { class: 'dc-mention', text: `#${state.data.channels.find((c) => c.id === m[2])?.name || 'unknown-channel'}` }));
    else if (m[3]) out.push(h('span', { class: 'dc-mention', text: '@user' }));
    else if (m[0] === '@everyone' || m[0] === '@here') out.push(h('span', { class: 'dc-mention', text: m[0] }));
    else if (m[4]) out.push(h('b', { text: m[4] }));
    else if (m[5]) out.push(h('u', { text: m[5] }));
    else if (m[6]) out.push(h('i', { text: m[6] }));
    else if (m[7]) out.push(h('code', { text: m[7] }));
    else out.push(h('a', { href: m[9], target: '_blank', rel: 'noopener noreferrer', text: m[8] }));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
function previewEmbed(e) {
  const box = h('div', { class: 'dc-embed' });
  box.style.borderLeftColor = e.color || '#8B5CF6';
  const main = h('div', { class: 'dc-embed-main' });
  if (e.author.name) main.append(h('div', { class: 'dc-author' }, e.author.icon_url && h('img', { src: e.author.icon_url, alt: '' }), e.author.name));
  if (e.title) main.append(h('div', { class: 'dc-title' }, e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer', text: e.title }) : e.title));
  if (e.description) main.append(h('div', { class: 'dc-desc' }, ...dcText(e.description)));
  const fields = e.fields.filter((f) => f.name || f.value);
  if (fields.length) main.append(h('div', { class: 'dc-fields' }, fields.map((f) => h('div', { class: `dc-field${f.inline ? ' inline' : ''}` }, h('b', { text: f.name }), h('div', {}, ...dcText(f.value))))));
  if (e.image) main.append(h('img', { class: 'dc-image', src: e.image, alt: '' }));
  if (e.footer.text || e.timestamp) main.append(h('div', { class: 'dc-footer' }, e.footer.icon_url && h('img', { src: e.footer.icon_url, alt: '' }), [e.footer.text, e.timestamp && `Today at ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}`].filter(Boolean).join(' • ')));
  box.append(h('div', { class: 'dc-embed-row' }, main, e.thumbnail && h('img', { class: 'dc-thumb', src: e.thumbnail, alt: '' })));
  return box;
}
function previewMessage(d) {
  const msg = h('div', { class: 'dc-msg' }, h('span', { class: 'dc-avatar' }, logo('', 16)),
    h('div', { class: 'dc-body' },
      h('div', { class: 'dc-head' }, h('b', { text: 'MOONWEB' }), h('span', { class: 'dc-bot', text: 'APP' }), h('small', { text: `Today at ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}` })),
      d.content && h('div', { class: 'dc-content' }, ...dcText(d.content)),
      d.embeds.map(previewEmbed),
      d.buttons.length && h('div', { class: 'dc-buttons' }, d.buttons.map((b) => h('span', { class: 'dc-btn' }, b.label || 'Button', icon('externalLink', 12))))));
  return !draftHasContent(d) ? h('p', { class: 'muted', text: 'Your announcement will appear here as you type.' }) : msg;
}

// ---------- small form helpers ----------
const ctr = (len, max) => h('span', { class: `ctr${len > max ? ' over' : ''}`, text: `${len}/${max}` });
function txt(obj, key, { label, max, area, ph, onInput } = {}) {
  const c = ctr(obj[key].length, max);
  const el = h(area ? 'textarea' : 'input', { type: area ? undefined : 'text', placeholder: ph, maxlength: max, value: area ? undefined : obj[key], oninput: (e) => { obj[key] = e.target.value; c.textContent = `${obj[key].length}/${max}`; changed(); onInput?.(); } }, area ? obj[key] : undefined);
  return h('div', { class: 'field' }, h('label', {}, label, ' ', c), el);
}
function plain(obj, key, label, ph) {
  return h('div', { class: 'field' }, h('label', { text: label }), h('input', { type: 'text', placeholder: ph, value: obj[key], oninput: (e) => { obj[key] = e.target.value.trim(); changed(); } }));
}
function insertAt(ta, text) {
  const i = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, i) + text + ta.value.slice(ta.selectionEnd ?? i);
  ta.dispatchEvent(new Event('input')); ta.focus();
}
// like check() from ui.js but without marking the Settings page dirty
const chk = (label, obj, key, desc) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; changed(); } }), h('span', {}, label, desc && h('small', { text: desc })));
const localInput = (ms) => { const d = new Date(ms - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const tzName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------- compose ----------
let ui = {}; // live element refs for the compose view
function changed() {
  ui.preview?.replaceChildren(previewMessage(AN.draft));
  const total = AN.draft.embeds.reduce((n, e) => n + e.title.length + e.description.length + e.author.name.length + e.footer.text.length + e.fields.reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
  if (ui.total) { ui.total.textContent = `Embed characters: ${total}/${AN.limits.embedTotal}`; ui.total.classList.toggle('over', total > AN.limits.embedTotal); }
  if (!AN.mode) { clearTimeout(AN.saveTimer); AN.saveTimer = setTimeout(autosave, 1200); }
}
async function autosave() {
  if (AN.mode || !state.guildId) return;
  try { await api(anUrl('/draft'), { method: 'PUT', json: { draft: AN.draft } }); if (ui.saved) ui.saved.textContent = `Draft saved ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}`; } catch { if (ui.saved) ui.saved.textContent = 'Draft not saved'; }
}
function rerender() { renderTab(); }

function embedEditor(e, i) {
  const L = AN.limits;
  const fieldRows = e.fields.map((f, j) => h('div', { class: 'an-sub' },
    txt(f, 'name', { label: `Field ${j + 1} name`, max: L.fieldName }), txt(f, 'value', { label: 'Value', max: L.fieldValue, area: true }),
    h('div', { class: 'an-row' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.inline, onchange: (ev) => { f.inline = ev.target.checked; changed(); } }), h('span', { text: 'Inline' })),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { e.fields.splice(j, 1); rerender(); }, text: 'Remove field' }))));
  return h('details', { class: 'an-embed', open: true },
    h('summary', {}, `Embed ${i + 1}`, h('span', { class: 'muted', text: e.title ? ` — ${e.title.slice(0, 40)}` : '' })),
    h('div', { class: 'an-embed-body' },
      txt(e, 'title', { label: 'Title', max: L.title }), txt(e, 'description', { label: 'Description', max: L.description, area: true }),
      h('div', { class: 'row' }, plain(e, 'url', 'Title link (optional)', 'https://…'),
        h('div', { class: 'field' }, h('label', { text: 'Color' }), h('input', { type: 'color', value: e.color, oninput: (ev) => { e.color = ev.target.value; changed(); } }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: e.timestamp, onchange: (ev) => { e.timestamp = ev.target.checked; changed(); } }), h('span', {}, 'Show timestamp', h('small', { text: 'Uses the moment the message is posted.' }))),
      h('div', { class: 'row' }, txt(e.author, 'name', { label: 'Author name', max: L.authorName }), plain(e.author, 'icon_url', 'Author icon URL', 'https://…')),
      h('div', { class: 'row' }, txt(e.footer, 'text', { label: 'Footer text', max: L.footerText }), plain(e.footer, 'icon_url', 'Footer icon URL', 'https://…')),
      h('div', { class: 'row' }, plain(e, 'thumbnail', 'Thumbnail URL', 'https://…'), plain(e, 'image', 'Large image URL', 'https://…')),
      h('h4', { text: `Fields (${e.fields.length}/${L.fields})` }), fieldRows,
      h('div', { class: 'an-row' },
        h('button', { class: 'btn small', type: 'button', disabled: e.fields.length >= L.fields, onclick: () => { e.fields.push({ name: '', value: '', inline: false }); rerender(); }, text: 'Add field' }),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => { AN.draft.embeds.splice(i, 1); rerender(); }, text: 'Remove embed' }))));
}

function composeView() {
  const d = AN.draft; const L = AN.limits;
  ui = { preview: h('div', { class: 'dc' }), total: h('small', { class: 'ctr' }), saved: h('small', { class: 'muted' }) };
  const ta = h('textarea', { maxlength: L.content, placeholder: 'Write your message. Use the tools below to insert mentions.', oninput: (e) => { d.content = e.target.value; cc.textContent = `${d.content.length}/${L.content}`; changed(); } }, d.content);
  const cc = ctr(d.content.length, L.content);
  const roleSel = h('select', { onchange: (e) => { if (e.target.value) insertAt(ta, `<@&${e.target.value}>`); e.target.value = ''; } }, h('option', { value: '', text: 'Insert role…' }), state.data.roles.map((r) => h('option', { value: r.id, text: `@${r.name}` })));
  const chSel = h('select', { onchange: (e) => { if (e.target.value) insertAt(ta, `<#${e.target.value}>`); e.target.value = ''; } }, h('option', { value: '', text: 'Insert channel…' }), state.data.channels.map((c) => h('option', { value: c.id, text: `# ${c.name}` })));
  const uid = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'User ID', 'aria-label': 'User ID to mention' });
  const addUser = h('button', { class: 'btn small', type: 'button', text: 'Insert user', onclick: () => { if (!SNOWFLAKE.test(uid.value.trim())) return toast('Enter a valid user ID', 'error'); insertAt(ta, `<@${uid.value.trim()}>`); uid.value = ''; } });

  const editing = AN.mode?.type === 'announcement';
  const channelBox = editing
    ? h('p', { class: 'muted', text: `Posted in: ${AN.mode.channels.map((c) => `#${c}`).join(', ') || '—'}. Edits update the existing messages.` })
    : h('div', { class: 'an-channels' }, state.data.channels.map((c) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: d.channelIds.includes(c.id), onchange: (e) => { d.channelIds = e.target.checked ? [...d.channelIds, c.id] : d.channelIds.filter((x) => x !== c.id); changed(); } }), h('span', { text: `# ${c.name}` }))));
  const when = h('input', { type: 'datetime-local', value: d.scheduledLocal, min: localInput(Date.now() + 60000), disabled: !d.scheduleOn && !(editing && AN.mode.status === 'scheduled'), onchange: (e) => { d.scheduledLocal = e.target.value; changed(); } });

  const actions = AN.mode?.type === 'template'
    ? [h('button', { class: 'btn primary', text: 'Save template changes', onclick: saveTemplateChanges }), h('button', { class: 'btn', text: 'Cancel', onclick: exitMode })]
    : editing
      ? [h('button', { class: 'btn primary', text: AN.mode.status === 'scheduled' ? 'Save changes' : 'Update posted messages', onclick: saveEdit }), h('button', { class: 'btn', text: 'Cancel', onclick: exitMode })]
      : [h('button', { class: 'btn primary', text: d.scheduleOn ? 'Review & schedule' : 'Review & send', onclick: reviewAndSend }),
        h('button', { class: 'btn', text: 'Send test to my DMs', onclick: sendTest }),
        h('button', { class: 'btn', text: 'Save as template', onclick: saveAsTemplate }),
        h('button', { class: 'btn ghost', text: 'Clear', onclick: clearDraftUI })];

  const left = h('div', { class: 'stack' },
    AN.mode && h('div', { class: 'notice tone-info' }, icon('info', 18), h('div', { text: AN.mode.type === 'template' ? `Editing template “${AN.mode.name}”.` : `Editing announcement #${AN.mode.id}${AN.mode.status === 'scheduled' ? ' (scheduled — not sent yet)' : ' — saving updates the messages already posted'}.` })),
    card({ title: 'Message' }, h('div', { class: 'field' }, h('label', {}, 'Text ', cc), ta),
      h('div', { class: 'an-tools' }, roleSel, chSel, h('div', { class: 'an-inline' }, uid, addUser))),
    card({ title: 'Embeds', subtitle: `${d.embeds.length}/${L.embeds} embeds`, actions: h('button', { class: 'btn small', disabled: d.embeds.length >= L.embeds, text: 'Add embed', onclick: () => { d.embeds.push(blankEmbed()); rerender(); } }) },
      d.embeds.length ? d.embeds.map(embedEditor) : h('p', { class: 'muted', text: 'No embeds. Add one for a rich message with a title, color, fields and images.' }), ui.total),
    card({ title: 'Link buttons', subtitle: `${d.buttons.length}/${L.buttons} — each opens a web address`, actions: h('button', { class: 'btn small', disabled: d.buttons.length >= L.buttons, text: 'Add button', onclick: () => { d.buttons.push({ label: '', url: '' }); rerender(); } }) },
      d.buttons.length ? d.buttons.map((b, i) => h('div', { class: 'an-row' }, h('input', { type: 'text', maxlength: L.buttonLabel, placeholder: 'Label', value: b.label, oninput: (e) => { b.label = e.target.value; changed(); } }),
        h('input', { type: 'text', placeholder: 'https://…', value: b.url, oninput: (e) => { b.url = e.target.value.trim(); changed(); } }),
        h('button', { class: 'btn small danger icon-only', 'aria-label': 'Remove button', onclick: () => { d.buttons.splice(i, 1); rerender(); } }, icon('x', 14)))) : h('p', { class: 'muted', text: 'No buttons.' })),
    card({ title: 'Who gets pinged' },
      chk('Ping roles mentioned in the text', d.mentions, 'roles'),
      chk('Ping users mentioned in the text', d.mentions, 'users'),
      chk('Allow @everyone and @here', d.mentions, 'everyone', 'You need the Mention Everyone permission. Off by default.')),
    !AN.mode && card({ title: 'Send to' }, channelBox,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.scheduleOn, onchange: (e) => { d.scheduleOn = e.target.checked; if (e.target.checked && !d.scheduledLocal) d.scheduledLocal = localInput(Date.now() + 3600000); rerender(); } }), h('span', {}, 'Schedule for later', h('small', { text: `Times use your timezone (${tzName()}).` }))),
      d.scheduleOn && h('div', { class: 'field' }, when)),
    editing && AN.mode.status === 'scheduled' && card({ title: 'Send time' }, h('div', { class: 'field' }, when), h('small', { class: 'muted', text: `Your timezone: ${tzName()}` })),
    h('div', { class: 'an-actions' }, actions, ui.saved));

  const right = h('div', { class: 'an-sticky' }, card({ title: 'Live preview', subtitle: 'Approximate — Discord has the final say' }, ui.preview));
  changed();
  if (!AN.mode) clearTimeout(AN.saveTimer);
  return h('div', { class: 'grid-main' }, left, right);
}

function exitMode() { AN.draft = AN.backup || blankDraft(); AN.mode = null; AN.backup = null; AN.tab = 'compose'; rerender(); }
function enterMode(mode, draft) { if (!AN.mode) AN.backup = AN.draft; AN.mode = mode; AN.draft = draft; AN.tab = 'compose'; rerender(); }
async function clearDraftUI() {
  if (draftHasContent(AN.draft) && !(await confirmDialog({ title: 'Clear the editor?', body: 'The current draft will be discarded.', confirmText: 'Clear', tone: 'danger' }))) return;
  AN.draft = blankDraft(); clearTimeout(AN.saveTimer); api(anUrl('/draft'), { method: 'DELETE' }).catch(() => {}); rerender();
}
async function withBusy(btn, fn) {
  const label = btn.textContent; btnSpinner(btn, true, label);
  try { return await fn(); } finally { btnSpinner(btn, false, label); }
}
const guardPayload = () => { const p = toPayload(AN.draft); return p; };

async function sendTest(ev) {
  await withBusy(ev.currentTarget, async () => {
    try { await api(anUrl('/test'), { method: 'POST', json: { payload: guardPayload() } }); toast('Test sent to your DMs', 'success'); } catch (e) { toast(e.message, 'error'); }
  });
}
async function reviewAndSend(ev) {
  const d = AN.draft;
  await withBusy(ev.currentTarget, async () => {
    let when = null;
    if (d.scheduleOn) { when = new Date(d.scheduledLocal).getTime(); if (!Number.isFinite(when)) return toast('Pick a date and time', 'error'); }
    try {
      const v = await api(anUrl('/validate'), { method: 'POST', json: { payload: guardPayload(), channelIds: d.channelIds } });
      if (!v.channels.length) return toast('Choose at least one channel', 'error');
      const body = h('div', { class: 'an-review' }, h('div', { class: 'dc' }, previewMessage(d)),
        h('p', {}, h('b', { text: 'Channels: ' }), v.channels.map((c) => `#${c.name}`).join(', ')),
        h('p', {}, h('b', { text: 'When: ' }), when ? `${fmtDate(when)} (${tzName()})` : 'Immediately'),
        d.mentions.everyone && h('div', { class: 'notice tone-warning' }, icon('alert', 18), h('div', { text: 'This message can ping @everyone / @here.' })));
      if (!(await confirmDialog({ title: when ? 'Schedule this announcement?' : 'Send this announcement?', body, confirmText: when ? 'Schedule' : 'Send now' }))) return;
      const r = await api(anUrl(), { method: 'POST', json: { payload: guardPayload(), channelIds: d.channelIds, scheduledAt: when ?? undefined } });
      const a = r.announcement;
      if (a.status === 'failed') toast(`Not delivered: ${a.deliveries.find((x) => x.error)?.error || 'unknown error'}`, 'error');
      else if (a.status === 'partial') toast('Sent to some channels — see History to retry the rest', 'error');
      else toast(a.status === 'scheduled' ? 'Announcement scheduled' : 'Announcement sent', 'success');
      AN.draft = blankDraft(); api(anUrl('/draft'), { method: 'DELETE' }).catch(() => {});
      AN.tab = 'history'; AN.hist.page = 1; rerender();
    } catch (e) { toast(e.message, 'error'); }
  });
}
async function saveEdit(ev) {
  await withBusy(ev.currentTarget, async () => {
    try {
      const json = { payload: guardPayload() };
      if (AN.mode.status === 'scheduled') { const t = new Date(AN.draft.scheduledLocal).getTime(); if (Number.isFinite(t)) json.scheduledAt = t; }
      const r = await api(anUrl(`/${AN.mode.id}`), { method: 'PUT', json });
      toast(r.failed ? `Updated ${r.edited} message(s); ${r.failed} could not be edited` : 'Announcement updated', r.failed ? 'error' : 'success');
      exitMode(); AN.tab = 'history'; rerender();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- templates ----------
function saveAsTemplate() {
  const name = h('input', { type: 'text', maxlength: AN.limits.templateName, placeholder: 'Template name' });
  const cat = h('select', {}, AN.meta.categories.map((c) => h('option', { value: c, text: c, selected: c === 'Custom' })));
  const save = h('button', { class: 'btn primary', text: 'Save template' });
  const m = modal({ title: 'Save as template', body: h('div', {}, field('Name', name), field('Category', cat)), footer: [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), save] });
  save.addEventListener('click', async () => {
    try { await api(anUrl('/templates'), { method: 'POST', json: { name: name.value, category: cat.value, payload: guardPayload() } }); m.close(); toast('Template saved', 'success'); await loadMeta(); } catch (e) { toast(e.message, 'error'); }
  });
}
async function saveTemplateChanges(ev) {
  await withBusy(ev.currentTarget, async () => {
    try { await api(anUrl(`/templates/${AN.mode.id}`), { method: 'PUT', json: { payload: guardPayload() } }); toast('Template updated', 'success'); await loadMeta(); exitMode(); AN.tab = 'templates'; rerender(); } catch (e) { toast(e.message, 'error'); }
  });
}
async function useTemplate(t) {
  if (draftHasContent(AN.draft) && !AN.mode && !(await confirmDialog({ title: 'Replace your draft?', body: `Loading “${t.name}” will replace what’s in the editor now.`, confirmText: 'Load template' }))) return;
  AN.mode = null; AN.draft = fromPayload(t.payload, { channelIds: AN.draft.channelIds }); AN.tab = 'compose'; rerender(); changed();
}
function templatesView() {
  const cats = ['All', ...AN.meta.categories];
  const cur = AN.catFilter || 'All';
  const list = AN.meta.templates.filter((t) => cur === 'All' || t.category === cur);
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', {}, segmented(cats.map((c) => [c, c]), cur, (c) => { AN.catFilter = c; renderTab(); }))),
    list.length ? h('div', { class: 'an-grid' }, list.map((t) => card({ title: t.name, actions: h('span', { class: `badge tone-${t.builtin ? 'info' : 'neutral'}`, text: t.builtin ? 'Built-in' : t.category }) },
      h('p', { class: 'muted', text: (t.payload.embeds[0]?.title || t.payload.content || '').slice(0, 90) || '(no text)' }),
      h('div', { class: 'an-row' },
        h('button', { class: 'btn small primary', text: 'Use', onclick: () => useTemplate(t) }),
        h('button', { class: 'btn small', text: 'Duplicate', onclick: async () => { try { await api(anUrl(`/templates/${t.id}/duplicate`), { method: 'POST' }); toast('Template duplicated', 'success'); await loadMeta(); renderTab(); } catch (e) { toast(e.message, 'error'); } } }),
        !t.builtin && h('button', { class: 'btn small', text: 'Edit', onclick: () => enterMode({ type: 'template', id: t.id, name: t.name }, fromPayload(t.payload)) }),
        !t.builtin && h('button', { class: 'btn small danger', text: 'Delete', onclick: async () => { if (!(await confirmDialog({ title: 'Delete template?', body: `“${t.name}” will be permanently deleted.`, confirmText: 'Delete', tone: 'danger' }))) return; try { await api(anUrl(`/templates/${t.id}`), { method: 'DELETE' }); toast('Template deleted', 'success'); await loadMeta(); renderTab(); } catch (e) { toast(e.message, 'error'); } } })))))
      : card({}, emptyState({ ic: 'tag', title: 'No templates in this category', text: 'Save one from the editor with “Save as template”.' })));
}

// ---------- history ----------
const ST_TONE = { sent: 'success', partial: 'warning', failed: 'danger', scheduled: 'info', sending: 'info', cancelled: 'neutral', deleted: 'neutral' };
async function historyView() {
  const q = new URLSearchParams({ page: AN.hist.page, ...(AN.hist.status && { status: AN.hist.status }) });
  const r = await api(anUrl(`?${q}`));
  const s = r.stats;
  const act = (label, fn, cls = '') => h('button', { class: `btn small ${cls}`, text: label, onclick: async (e) => { await withBusy(e.currentTarget, async () => { try { await fn(); } catch (err) { toast(err.message, 'error'); } }); } });
  const rows = r.rows.map((a) => card({ title: `#${a.id} · ${a.summary}`, subtitle: `${a.authorTag || 'Unknown'} · ${a.status === 'scheduled' ? `scheduled for ${fmtDate(a.scheduledAt)}` : fmtDate(a.sentAt || a.createdAt)}${a.editedAt ? ' · edited' : ''}`, actions: h('span', { class: `badge tone-${ST_TONE[a.status] || 'neutral'}`, text: a.status }) },
    h('div', { class: 'an-dels' }, a.deliveries.map((d) => h('div', { class: 'an-del' },
      h('span', { class: `badge tone-${d.status === 'sent' ? 'success' : d.status === 'failed' ? 'danger' : 'neutral'}`, text: d.status }), ` #${d.channelName || d.channelId}`,
      d.link && h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer', class: 'an-link' }, ' open ', icon('externalLink', 12)),
      d.error && h('div', { class: 'err', text: d.error })))),
    h('div', { class: 'an-row' },
      ['scheduled', 'sent', 'partial'].includes(a.status) && act('Edit', async () => enterMode({ type: 'announcement', id: a.id, status: a.status, channels: a.deliveries.map((d) => d.channelName || d.channelId) }, fromPayload(a.payload, { scheduledLocal: a.status === 'scheduled' ? localInput(a.scheduledAt) : '' }))),
      ['failed', 'partial'].includes(a.status) && act('Retry failed', async () => { const x = await api(anUrl(`/${a.id}/retry`), { method: 'POST' }); toast(x.announcement.status === 'sent' ? 'Delivered' : 'Some channels still failed', x.announcement.status === 'sent' ? 'success' : 'error'); renderTab(); }),
      a.status === 'scheduled' && act('Cancel', async () => { if (!(await confirmDialog({ title: 'Cancel this scheduled announcement?', body: 'It will not be sent.', confirmText: 'Cancel announcement', tone: 'danger' }))) return; await api(anUrl(`/${a.id}/cancel`), { method: 'POST' }); toast('Cancelled', 'success'); renderTab(); }, 'danger'),
      ['sent', 'partial'].includes(a.status) && act('Delete messages', async () => { if (!(await confirmDialog({ title: 'Delete posted messages?', body: 'The messages will be removed from every channel they were posted in. This can’t be undone.', confirmText: 'Delete', tone: 'danger' }))) return; const x = await api(anUrl(`/${a.id}/delete-messages`), { method: 'POST' }); toast(`Deleted ${x.deleted} message(s)${x.failed ? `, ${x.failed} failed` : ''}`, x.failed ? 'error' : 'success'); renderTab(); }, 'danger'),
      a.payload && act('Use as new draft', async () => { AN.mode = null; AN.draft = fromPayload(a.payload); AN.tab = 'compose'; rerender(); changed(); }))));
  return h('div', { class: 'stack' },
    h('div', { class: 'grid-stats' }, statCard({ label: 'Announcements', value: fmtNum(s.total), ic: 'megaphone' }), statCard({ label: 'Delivered', value: fmtNum(s.deliveries.sent), ic: 'checkCircle', tone: 'success' }),
      statCard({ label: 'Failed', value: fmtNum(s.deliveries.failed), ic: 'alertCircle', tone: s.deliveries.failed ? 'danger' : 'neutral' }), statCard({ label: 'Success rate', value: s.successRate === null ? '—' : `${s.successRate}%`, ic: 'trend', tone: 'info' })),
    h('div', { class: 'an-row' }, h('select', { 'aria-label': 'Filter by status', onchange: (e) => { AN.hist.status = e.target.value; AN.hist.page = 1; renderTab(); } },
      h('option', { value: '', text: 'All statuses' }), Object.keys(ST_TONE).map((x) => h('option', { value: x, text: x, selected: AN.hist.status === x }))),
    h('button', { class: 'btn', text: 'Refresh', onclick: () => renderTab() })),
    rows.length ? rows : card({}, emptyState({ ic: 'megaphone', title: 'No announcements yet', text: 'Announcements you send or schedule will be listed here with their delivery status.', action: h('button', { class: 'btn primary', text: 'Create one', onclick: () => { AN.tab = 'compose'; renderTab(); } }) })),
    r.pages > 1 && h('div', { class: 'an-row' }, h('button', { class: 'btn small', disabled: r.page <= 1, text: 'Previous', onclick: () => { AN.hist.page--; renderTab(); } }), h('span', { class: 'muted', text: `Page ${r.page} of ${r.pages}` }), h('button', { class: 'btn small', disabled: r.page >= r.pages, text: 'Next', onclick: () => { AN.hist.page++; renderTab(); } })));
}

// ---------- page ----------
async function loadMeta() { AN.meta = await api(anUrl('/meta')); AN.limits = AN.meta.limits; }
async function renderTab() {
  if (!AN.body) return;
  const body = AN.body;
  if (AN.tab !== 'compose') clearTimeout(AN.saveTimer);
  try {
    if (!AN.meta) { body.replaceChildren(skeletonRows(4)); await loadMeta(); if (!AN.draftLoaded) { const { draft } = await api(anUrl('/draft')); AN.draft = draft ? Object.assign(blankDraft(), draft) : blankDraft(); AN.draftLoaded = true; } }
    if (AN.body !== body) return;
    if (AN.seg) AN.seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['compose', 'templates', 'history'][i] === AN.tab));
    const view = AN.tab === 'compose' ? composeView() : AN.tab === 'templates' ? templatesView() : await historyView();
    if (AN.body === body) body.replaceChildren(view);
  } catch (e) { body.replaceChildren(card({}, emptyState({ ic: 'alertCircle', tone: 'danger', title: 'Couldn’t load announcements', text: e.message }))); }
}
function announcementsPage() {
  AN.meta = null; AN.draftLoaded = false; AN.mode = null; AN.backup = null;
  AN.body = h('div', {});
  AN.seg = segmented([['compose', 'Compose'], ['templates', 'Templates'], ['history', 'History']], AN.tab, (id) => { AN.tab = id; renderTab(); });
  renderTab();
  return h('div', {}, pageHeader('Announcements', 'Design, schedule and send messages to your channels', AN.seg), AN.body);
}
