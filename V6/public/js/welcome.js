'use strict';
/* MOONWEB Welcome & Goodbye (Stage 6). Settings live in the existing settings object (s()) and are saved with the shared save bar;
   tests, image preview, background upload and activity use /api/guilds/:id/welcome. */

const WL = { tab: 'welcome', meta: null, body: null, seg: null, act: { page: 1, type: '', apage: 1 } };
const wlUrl = (p = '') => `/guilds/${state.guildId}/welcome${p}`;

const sampleCtx = () => {
  const g = state.data.guild; const now = Date.now();
  return { id: '000000000000000000', username: state.me.user.username || 'NewMember', createdAt: now - 400 * 86400000, joinedAt: now, guildName: g.name, memberCount: g.memberCount + 1 };
};
const wlFmtDate = (ts) => { const d = new Date(ts); return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
function wlRender(t, { plain = false } = {}) { // mirrors the server's render() for the preview only
  const c = sampleCtx();
  const map = { user: plain ? c.username : '@' + c.username, username: c.username, userid: c.id, server: c.guildName, membercount: String(c.memberCount), count: String(c.memberCount), createdate: wlFmtDate(c.createdAt), joineddate: wlFmtDate(c.joinedAt) };
  return String(t ?? '').replace(/\{(user|username|userid|server|membercount|count|createdate|joineddate)\}/g, (m, k) => map[k]);
}
function wlMd(text) { // **bold** and mentions only, same as the old preview
  const out = []; const re = /\*\*(.+?)\*\*|@\S+/g; let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[0].startsWith('**') ? h('b', { text: m[1] }) : h('span', { class: 'dc-mention', text: m[0] }));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last)); return out;
}

function wlPreview(cfg, kind, imgUrlRef) {
  const sub = h('div', { class: 'dc-body' });
  const paint = () => {
    const kids = [h('div', { class: 'dc-head' }, h('b', { text: 'MOONWEB' }), h('span', { class: 'dc-bot', text: 'BOT' }), h('small', { text: 'Today' }))];
    const text = kind === 'welcome' && cfg.random && cfg.randomMessages.length ? cfg.randomMessages[0] : cfg.message;
    if ((cfg.type === 'text' || cfg.type === 'both') && text) kids.push(h('div', { class: 'dc-content' }, ...wlMd(wlRender(text))));
    if (cfg.type === 'embed' || cfg.type === 'both') {
      const e = cfg.embed;
      kids.push(h('div', { class: 'wl-embed', style: `border-left:4px solid ${e.color}` },
        e.avatarThumbnail && h('div', { class: 'wl-thumb', text: (state.me.user.username || '?')[0].toUpperCase() }),
        e.title && h('div', { class: 'wl-etitle', text: wlRender(e.title, { plain: true }) }),
        e.description && h('div', { class: 'dc-desc' }, ...wlMd(wlRender(e.description))),
        kind === 'welcome' && e.useImage && cfg.image.enabled && imgUrlRef.url && h('img', { class: 'wl-img', src: imgUrlRef.url, alt: 'Welcome image' }),
        (e.footer || e.timestamp) && h('div', { class: 'wl-foot', text: [e.footer && wlRender(e.footer, { plain: true }), e.timestamp && 'Today'].filter(Boolean).join(' • ') })));
    }
    if (kind === 'welcome' && cfg.image.enabled && imgUrlRef.url && !(cfg.embed.useImage && cfg.type !== 'text')) kids.push(h('img', { class: 'wl-img', src: imgUrlRef.url, alt: 'Welcome image' }));
    sub.replaceChildren(...kids);
  };
  paint();
  return { node: h('div', { class: 'dc' }, h('div', { class: 'dc-msg' }, h('div', { class: 'dc-avatar' }, icon('moon', 20)), sub)), paint };
}

const wlSeg = (obj, key, options, onChange) => segmented(options, obj[key], (v) => { obj[key] = v; markDirty(); onChange?.(); });
function wlText(obj, key, { max = 256, multiline = false, rows = 3 } = {}, onInput) {
  const ev = { maxlength: max, oninput: (e) => { obj[key] = e.target.value; markDirty(); onInput?.(); } };
  return multiline ? h('textarea', { ...ev, rows }, obj[key]) : h('input', { ...ev, type: 'text', value: obj[key] });
}
function wlVarChips(target) {
  return h('div', { class: 'row' }, WL.meta.variables.map(([v, d]) => h('button', { class: 'btn small', type: 'button', title: d, text: v,
    onclick: () => { target.value += v; target.dispatchEvent(new Event('input')); target.focus(); } })));
}
const wlColor = (obj, key, onInput) => h('input', { type: 'color', value: obj[key], oninput: (e) => { obj[key] = e.target.value.toUpperCase(); markDirty(); onInput?.(); } });

function variablesCard() {
  return card({ title: 'Variable reference', subtitle: 'Use these in any message, embed or image text' },
    h('div', { class: 'wl-vars' }, WL.meta.variables.map(([v, d]) => h('div', {}, h('code', { text: v }), h('span', { text: ` — ${d}` })))),
    h('p', { class: 'hint', text: 'Titles, footers and image text show the plain username instead of a mention. {count} still works as an old alias.' }));
}

async function wlTest(kind, label) {
  if (state.dirty) { toast('Save your changes first — tests use the saved settings.', 'warning'); return; }
  const cfg = s()[kind];
  if (!cfg.channelId) { toast('Select a channel first.', 'error'); return; }
  const ch = state.data.channels.find((c) => c.id === cfg.channelId);
  if (!(await confirmDialog({ title: `Send a test ${label} message?`, body: `A real ${label} message for you (${state.me.user.username}) will be posted in #${ch?.name ?? 'the selected channel'}.`, confirmText: 'Send test' }))) return;
  try { await api(wlUrl('/test'), { method: 'POST', json: { kind } }); toast('Test message sent', 'success'); loadWarnings(); } catch (e) { toast(e.message, 'error'); }
}

function wlEmbedEditor(cfg, repaint) {
  const e = cfg.embed;
  return h('div', { class: 'stack' },
    field('Embed title', wlText(e, 'title', { max: 256 }, repaint)),
    field('Embed description', wlText(e, 'description', { max: 2000, multiline: true, rows: 4 }, repaint)),
    h('div', { class: 'row' }, field('Color', wlColor(e, 'color', repaint)), field('Footer', wlText(e, 'footer', { max: 200 }, repaint))),
    check('Show timestamp', e, 'timestamp', repaint), check('Show member avatar as thumbnail', e, 'avatarThumbnail', repaint));
}

// ---------- welcome tab ----------
function welcomeTab() {
  const w = s().welcome; const img = w.image; const ref = { url: null };
  const pv = wlPreview(w, 'welcome', ref);
  const repaint = () => pv.paint();
  const msg = wlText(w, 'message', { max: 1000, multiline: true, rows: 3 }, repaint);
  const embedBox = h('div'); const imgBox = h('div');
  const drawEmbedBox = () => embedBox.replaceChildren(w.type === 'text' ? '' : card({ title: 'Embed' }, wlEmbedEditor(w, repaint),
    w.type !== 'text' && h('div', {}, check('Show the welcome image inside the embed', w.embed, 'useImage', repaint, 'Needs the welcome image below to be enabled.'))));
  const typeSeg = wlSeg(w, 'type', [['text', 'Plain text'], ['embed', 'Embed'], ['both', 'Text + embed']], () => { drawEmbedBox(); repaint(); });
  drawEmbedBox();

  const prevImg = h('img', { class: 'wl-img', alt: '', hidden: true }); const prevNote = h('p', { class: 'hint' });
  const prevBtn = h('button', { class: 'btn', type: 'button', text: 'Preview image' });
  prevBtn.onclick = async () => {
    btnSpinner(prevBtn, true, 'Rendering…');
    try { const r = await api(wlUrl('/image-preview'), { method: 'POST', json: { image: img } }); ref.url = `data:image/png;base64,${r.png}`; prevImg.src = ref.url; prevImg.hidden = false; prevNote.textContent = 'Preview uses your own avatar and name.'; repaint(); }
    catch (er) { toast(er.message, 'error'); } finally { btnSpinner(prevBtn, false, 'Preview image'); }
  };
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  file.onchange = async () => {
    if (!file.files[0]) return; const fd = new FormData(); fd.append('file', file.files[0]);
    try { const r = await api(wlUrl('/background'), { method: 'POST', form: fd }); s().welcome.image.hasBackground = r.settings.welcome.image.hasBackground; toast('Background uploaded', 'success'); wlShow(); } catch (er) { toast(er.message, 'error'); }
  };
  const tplSel = h('select', { onchange: (e) => { img.template = e.target.value; markDirty(); } }, Object.entries(WL.meta.imageTemplates).map(([k, v]) => h('option', { value: k, text: v.label, selected: img.template === k })));
  const alignSel = h('select', { onchange: (e) => { img.align = e.target.value; markDirty(); } }, ['center', 'left'].map((x) => h('option', { value: x, text: x === 'center' ? 'Centered' : 'Left', selected: img.align === x })));
  const range = h('input', { type: 'range', min: -30, max: 30, value: img.offsetY, oninput: (e) => { img.offsetY = Number(e.target.value); markDirty(); } });
  imgBox.append(card({ title: 'Welcome image', subtitle: 'A generated picture with the member’s avatar and name' },
    !WL.meta.imageAvailable && notice(WL.meta.imageNote, 'warning', 'alertCircle'),
    check('Attach a welcome image', img, 'enabled', repaint, 'Posted with the welcome message. The bot needs Attach Files in the channel.'),
    h('div', { class: 'row' }, field('Template', tplSel), field('Text alignment', alignSel), field('Vertical position', range)),
    field('Title text', wlText(img, 'title', { max: 80 })), field('Subtitle text', wlText(img, 'subtitle', { max: 80 })),
    h('div', { class: 'row' }, field('Background', wlColor(img, 'bgColor')), field('Gradient to', wlColor(img, 'bgColor2')), field('Text', wlColor(img, 'textColor')), field('Accent', wlColor(img, 'accentColor'))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', text: img.hasBackground ? 'Replace background image' : 'Upload background image', onclick: () => file.click() }), file,
      img.hasBackground && h('button', { class: 'btn danger', type: 'button', text: 'Remove background', onclick: async () => {
        if (!(await confirmDialog({ title: 'Remove background image?', body: 'The gradient colors will be used instead.', confirmText: 'Remove', tone: 'danger' }))) return;
        try { await api(wlUrl('/background'), { method: 'DELETE' }); s().welcome.image.hasBackground = false; wlShow(); } catch (er) { toast(er.message, 'error'); } } }),
      prevBtn),
    h('p', { class: 'hint', text: 'Backgrounds: PNG or JPEG, up to 2 MB, 1000×360 works best. Unsaved color/text edits are used in the preview.' }), prevImg, prevNote));

  const randArea = listArea(w, 'randomMessages', 'One welcome message per line (up to 10)');
  return h('div', { class: 'grid-main' },
    h('div', { class: 'stack' },
      card({ title: 'Welcome message' },
        check('Send a welcome message when someone joins', w, 'enabled'),
        field('Channel', chanSelect(w, 'channelId', 'Select a channel…')),
        field('Format', typeSeg),
        field('Message', msg, 'Supports **bold**. Plain text and the embed description both accept variables.'), wlVarChips(msg),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: 'Send test welcome', onclick: () => wlTest('welcome', 'welcome') }))),
      embedBox,
      card({ title: 'Random welcome templates', subtitle: 'Optional' },
        check('Pick a random message from the list below', w, 'random', repaint, 'Replaces the single message above for the text part. Empty list = single message.'), randArea),
      imgBox,
      card({ title: 'Direct message', subtitle: 'Optional' },
        check('Also DM new members', w.dm, 'enabled', null, 'Members with DMs closed are skipped; failures appear in the audit log.'),
        field('DM text', wlText(w.dm, 'message', { max: 1000, multiline: true }))),
      saveBar()),
    h('div', { class: 'stack' }, card({ title: 'Live preview', subtitle: 'Approximately how it will look in Discord' }, pv.node, h('p', { class: 'hint', text: 'Uses sample values. Render the image preview to see it here.' })), variablesCard()));
}

// ---------- goodbye tab ----------
function goodbyeTab() {
  const g = s().goodbye; const pv = wlPreview(g, 'goodbye', { url: null }); const repaint = () => pv.paint();
  const msg = wlText(g, 'message', { max: 1000, multiline: true }, repaint); const embedBox = h('div');
  const draw = () => embedBox.replaceChildren(g.type === 'text' ? '' : card({ title: 'Embed' }, wlEmbedEditor(g, repaint)));
  draw();
  return h('div', { class: 'grid-main' },
    h('div', { class: 'stack' },
      card({ title: 'Goodbye message' },
        check('Send a goodbye message when someone leaves', g, 'enabled'),
        field('Channel', chanSelect(g, 'channelId', 'Select a channel…')),
        field('Format', wlSeg(g, 'type', [['text', 'Plain text'], ['embed', 'Embed'], ['both', 'Text + embed']], () => { draw(); repaint(); })),
        field('Message', msg), wlVarChips(msg),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: 'Send test goodbye', onclick: () => wlTest('goodbye', 'goodbye') }))),
      embedBox, saveBar()),
    h('div', { class: 'stack' }, card({ title: 'Live preview' }, pv.node), variablesCard()));
}

// ---------- automation tab ----------
function automationTab() {
  const st = s(); const ja = st.joinAutomation; const raid = st.automod.raid;
  return h('div', { class: 'stack' },
    card({ title: 'Roles for new members' },
      field('Auto role', roleSelect(st, 'autoRoleId'), 'Given to every new member. The bot needs Manage Roles and its highest role must be above this role.'),
      field('Verification role', roleSelect(ja, 'verificationRoleId'), 'Optional. Given INSTEAD of the auto role to accounts flagged as new (below), e.g. a restricted “Unverified” role.')),
    card({ title: 'New-account detection' },
      check('Flag accounts younger than the limit', ja.newAccount, 'enabled', null, 'Posts a warning in the log channel and records it in the audit log.'),
      h('div', { class: 'row' }, field('Account age limit (days)', num(ja.newAccount, 'days', 1, 365)),
        field('When flagged', h('select', { onchange: (e) => { ja.newAccount.action = e.target.value; markDirty(); } },
          h('option', { value: 'warn', text: 'Warn only', selected: ja.newAccount.action === 'warn' }),
          h('option', { value: 'kick', text: 'Warn and kick (needs Kick Members)', selected: ja.newAccount.action === 'kick' }))))),
    card({ title: 'Join-rate alerts & anti-raid' },
      notice('Anti-raid runs only while AutoMod is enabled (Moderation → AutoMod). The bot never acts on members above its own role.', 'info', 'info'),
      check('Detect raids', raid, 'enabled'),
      h('div', { class: 'row' }, field('Joins', num(raid, 'joins', 3, 100)), field('Within (seconds)', num(raid, 'seconds', 3, 120)),
        field('Action', h('select', { onchange: (e) => { raid.action = e.target.value; markDirty(); } },
          [['alert', 'Alert in log channel only'], ['timeout', 'Alert and time out joiners for 10 min'], ['kick', 'Alert and kick joiners']].map(([v, t]) => h('option', { value: v, text: t, selected: raid.action === v })))))),
    card({ title: 'Activity logging' }, check('Record joins and leaves', ja, 'logJoinLeave', null, 'Stored in the dashboard for history and later analytics. Turning it off stops new records; old ones are kept.')),
    saveBar());
}

// ---------- activity tab ----------
async function activityTab() {
  const [ev, au] = await Promise.all([api(wlUrl(`/events?page=${WL.act.page}${WL.act.type ? `&type=${WL.act.type}` : ''}`)), api(wlUrl(`/audit?page=${WL.act.apage}`))]);
  const pager = (page, total, set) => h('div', { class: 'pager' }, h('span', { text: `${fmtNum(total)} total · page ${page}` }),
    h('div', { class: 'btns' }, h('button', { class: 'btn small', disabled: page <= 1, text: 'Previous', onclick: () => { set(page - 1); wlShow(); } }),
      h('button', { class: 'btn small', disabled: page * 25 >= total, text: 'Next', onclick: () => { set(page + 1); wlShow(); } })));
  const tbl = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' }, h('thead', {}, h('tr', {}, head.map((x) => h('th', { text: x })))), h('tbody', {}, rows)));
  const filter = segmented([['', 'All'], ['join', 'Joins'], ['leave', 'Leaves']], WL.act.type, (v) => { WL.act.type = v; WL.act.page = 1; wlShow(); });
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, statCard({ label: 'Joins (7 days)', value: fmtNum(ev.week.joins), ic: 'userPlus', tone: 'success' }), statCard({ label: 'Leaves (7 days)', value: fmtNum(ev.week.leaves), ic: 'userX', tone: 'neutral' })),
    card({ title: 'Join & leave log', actions: filter },
      ev.rows.length ? tbl(['Event', 'Member', 'Account created', 'When'], ev.rows.map((r) => h('tr', {},
        h('td', { 'data-label': 'Event' }, h('span', { class: `badge tone-${r.type === 'join' ? 'success' : 'neutral'}`, text: r.type === 'join' ? 'Joined' : 'Left' })),
        h('td', { 'data-label': 'Member' }, h('b', { text: r.user_tag || 'Unknown' }), h('div', {}, h('small', { class: 'mono faint', text: r.user_id }))),
        h('td', { 'data-label': 'Account created', text: r.account_created ? fmtDate(r.account_created) : '—' }),
        h('td', { 'data-label': 'When' }, h('span', { title: fmtDate(r.created_at), text: timeAgo(r.created_at) }))))) : emptyState({ ic: 'users', title: 'No joins or leaves recorded yet', text: 'Events are recorded from now on while logging is enabled.', compact: true }),
      ev.total > 0 && pager(WL.act.page, ev.total, (p) => { WL.act.page = p; })),
    card({ title: 'Automation audit log', subtitle: 'Welcome messages, roles, DMs, new-account and anti-raid actions, and configuration changes' },
      au.rows.length ? tbl(['Event', 'Details', 'Actor', 'When'], au.rows.map((r) => h('tr', {},
        h('td', { 'data-label': 'Event' }, h('span', { class: `badge tone-${r.ok ? 'success' : 'danger'}`, text: `${r.kind}${r.ok ? '' : ' · failed'}` })),
        h('td', { 'data-label': 'Details' }, h('div', { class: 'clip', title: r.detail, text: r.detail || '—' })),
        h('td', { 'data-label': 'Actor', text: r.actor || 'system' }),
        h('td', { 'data-label': 'When' }, h('span', { title: fmtDate(r.created_at), text: timeAgo(r.created_at) }))))) : emptyState({ ic: 'file', title: 'Nothing audited yet', compact: true }),
      au.total > 0 && pager(WL.act.apage, au.total, (p) => { WL.act.apage = p; })));
}

async function loadWarnings() {
  try { const r = await api(wlUrl('/meta')); WL.meta = r; WL.warn?.replaceChildren(...r.warnings.map((x) => notice(x, 'warning', 'alertCircle'))); } catch { /* shown by wlShow */ }
}
async function wlShow() {
  const body = h('div', {}); WL.body = body;
  if (WL.seg) WL.seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['welcome', 'goodbye', 'automation', 'activity'][i] === WL.tab));
  try {
    if (!WL.meta) { body.replaceChildren(skeletonRows(4)); WL.host.replaceChildren(WL.warn, body); await loadWarnings(); }
    const view = WL.tab === 'welcome' ? welcomeTab() : WL.tab === 'goodbye' ? goodbyeTab() : WL.tab === 'automation' ? automationTab() : await activityTab();
    if (WL.body === body) { body.replaceChildren(view); WL.host.replaceChildren(WL.warn, body); }
  } catch (e) { body.replaceChildren(card({}, emptyState({ ic: 'alertCircle', tone: 'danger', title: 'Couldn’t load this section', text: e.message }))); WL.host.replaceChildren(WL.warn, body); }
}
function welcomePage() {
  WL.meta = null; WL.warn = h('div', { class: 'stack' }); WL.host = h('div', {});
  WL.seg = segmented([['welcome', 'Welcome'], ['goodbye', 'Goodbye'], ['automation', 'Automation'], ['activity', 'Activity']], WL.tab, (id) => { WL.tab = id; wlShow(); });
  wlShow();
  return h('div', {}, pageHeader('Welcome & Goodbye', 'Greet new members, say goodbye, and automate joins', WL.seg), WL.host);
}
