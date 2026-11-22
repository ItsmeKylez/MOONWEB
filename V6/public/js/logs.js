'use strict';
/* MOONWEB Moderation Logs (Stage 3).
   One feed of bot cases + Discord audit-log entries, with filters, details and live updates.
   All data comes from /api/guilds/:id/activity*; nothing here is hardcoded or fabricated. */

const LOG_PAGE_SIZE = 25;
const LOG_CAT_ICON = { moderation: 'shield', members: 'users', channels: 'hash', roles: 'tag', messages: 'message', server: 'server' };
const LOG_SRC = { discord: 'Discord', bot: 'Bot command', dashboard: 'Dashboard', automod: 'AutoMod', scheduled: 'Scheduled' };
const logStrip = (t) => String(t || '').replace(/ \((dashboard|AutoMod)\)$/, '');
const logToneOf = (type) => (/_(create|add)$/.test(type) ? 'success' : /_(delete|remove)$/.test(type) ? 'danger' : 'info');

function logBadge(row, meta) {
  if (ACTION_META[row.type]) return actionBadge(row.type);
  const label = meta?.types.find((t) => t.key === row.type)?.label || row.type.replace(/_/g, ' ');
  return h('span', { class: `badge tone-${logToneOf(row.type)}` }, icon(LOG_CAT_ICON[row.category] || 'file', 12), label);
}

function logModerator(row) {
  const name = logStrip(row.moderator_tag) || row.moderator_id || 'Unknown';
  const url = row.avatar && row.moderator_id ? `https://cdn.discordapp.com/avatars/${row.moderator_id}/${row.avatar}.png?size=64` : null;
  return h('div', { class: 'cell-user' }, avatarEl(name, url), h('div', {}, h('div', { text: name }), h('small', { class: 'src', text: LOG_SRC[row.source] || row.source })));
}

function logTarget(row) {
  const name = row.target_name || (row.target_id ? `${row.target_type || 'item'} ${row.target_id}` : '—');
  if (row.target_type === 'user') {
    return h('div', { class: 'cell-user' }, avatarEl(row.target_name), h('div', {}, h('div', { text: row.target_name || 'Unknown' }), h('small', { class: 'mono', text: row.target_id })));
  }
  return h('div', { class: 'cell-user' },
    h('span', { class: 'ibubble sm tone-neutral' }, icon(LOG_CAT_ICON[row.category] || 'file', 15)),
    h('div', {}, h('div', { text: name }), row.target_type && h('small', { text: row.target_type })));
}

// ---------- change / detail formatting ----------
function logVal(v, key) {
  if (v === null || v === undefined) return '—';
  if (key === 'communication_disabled_until' && Date.parse(v)) return fmtDate(Date.parse(v));
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.name || x.id || JSON.stringify(x) : String(x))).join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function logChanges(changes) {
  if (!changes.length) return h('span', { class: 'faint', text: 'No field changes recorded.' });
  return h('div', { class: 'diff' }, changes.map((c) => {
    if (c.key === '$add' || c.key === '$remove') {
      return h('div', { class: 'd' }, h('span', { class: 'k', text: c.key === '$add' ? 'Roles added' : 'Roles removed' }), h('span', { class: c.key === '$add' ? 'new' : 'old', text: logVal(c.new, c.key) }));
    }
    return h('div', { class: 'd' }, h('span', { class: 'k', text: c.key.replace(/_/g, ' ') }),
      c.old !== null && c.old !== undefined ? h('span', { class: 'old', text: logVal(c.old, c.key) }) : null,
      c.old !== null && c.old !== undefined && c.new !== null && c.new !== undefined ? h('span', { class: 'arrow', text: '→' }) : null,
      c.new !== null && c.new !== undefined ? h('span', { class: 'new', text: logVal(c.new, c.key) }) : (c.old === null || c.old === undefined ? h('span', { class: 'faint', text: '—' }) : null));
  }));
}
function logExtra(extra) {
  const bits = [];
  if (extra.count != null) bits.push(`${fmtNum(extra.count)} message${extra.count === 1 ? '' : 's'}`);
  if (extra.channel_id) { const c = state.data.channels.find((x) => x.id === extra.channel_id); bits.push(c ? `in #${c.name}` : `in channel ${extra.channel_id}`); }
  if (extra.removed != null) bits.push(`${fmtNum(extra.removed)} member${extra.removed === 1 ? '' : 's'} removed`);
  if (extra.days != null) bits.push(`inactive for ${extra.days} day${extra.days === 1 ? '' : 's'}`);
  if (extra.duration_ms) bits.push(`duration ${fmtDuration(extra.duration_ms)}`);
  if (extra.until) bits.push(`until ${fmtDate(extra.until)}`);
  return bits.length ? bits.join(' · ') : null;
}

function openAuditModal(row, meta) {
  const kv = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
  const label = meta?.types.find((t) => t.key === row.type)?.label || row.type.replace(/_/g, ' ');
  const extraBox = h('span', { class: 'faint', text: '—' });
  const changesBox = h('div', {}, skeleton('100%', 36));
  const idBox = h('span', { class: 'mono faint', text: '…' });
  const name = logStrip(row.moderator_tag) || row.moderator_id || 'Unknown';
  const isUser = row.target_type === 'user' && SNOWFLAKE.test(row.target_id || '');
  const dlg = modal({
    title: label, subtitle: fmtDate(row.created_at), size: 'wide',
    body: h('dl', { class: 'detail' },
      kv('Event', logBadge(row, meta)),
      kv('Target', h('div', {}, h('div', { text: row.target_name || (row.target_id ? `${row.target_type || 'item'}` : '—') }), row.target_id && h('span', { class: 'mono faint', text: row.target_id }))),
      kv('Moderator', h('div', {}, h('div', { text: name }), row.moderator_id && h('span', { class: 'mono faint', text: row.moderator_id }))),
      kv('Source', LOG_SRC[row.source] || row.source),
      kv('Reason', row.reason || 'No reason provided'),
      kv('Details', extraBox),
      kv('Changes', changesBox),
      kv('When', `${fmtDate(row.created_at)} (${timeAgo(row.created_at)})`),
      kv('Discord entry', idBox)),
    footer: [
      h('button', { class: 'btn', text: 'Close', onclick: () => dlg.close() }),
      isUser && h('button', { class: 'btn', onclick: () => { dlg.close(); navigate('logs', { user: row.target_id }); } }, icon('file', 16), 'This user’s logs'),
      isUser && h('button', { class: 'btn primary', onclick: () => { dlg.close(); navigate('moderation', { user: row.target_id }); } }, icon('shield', 16), 'Take action'),
    ],
  });
  api(`/guilds/${state.guildId}/activity/audit/${row.id}`).then(({ entry }) => {
    changesBox.replaceChildren(logChanges(entry.changes));
    const x = logExtra(entry.extra);
    if (x) extraBox.replaceChildren(x);
    idBox.textContent = entry.entry_id + (entry.imported ? ' · imported from Discord history' : '');
  }).catch((e) => { changesBox.replaceChildren(h('span', { class: 'err', text: e.message })); idBox.textContent = '—'; });
}

function logRow(row, meta, fresh) {
  const open = () => (row.kind === 'case' ? openCaseModal(row.case) : openAuditModal(row, meta));
  const label = (row.kind === 'case' ? `Case #${row.case_number}` : '');
  return h('tr', { class: `click${fresh ? ' fresh' : ''}`, tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
    h('td', { 'data-label': 'Event' }, logBadge(row, meta), row.duration_ms ? h('span', { class: 'faint', text: ` ${fmtDuration(row.duration_ms)}` }) : null,
      label && h('div', {}, h('small', { class: 'mono faint', text: label }))),
    h('td', { 'data-label': 'Target' }, logTarget(row)),
    h('td', { 'data-label': 'Moderator' }, logModerator(row)),
    h('td', { 'data-label': 'Reason' }, h('div', { class: 'clip', title: row.reason || '', text: row.reason || '—' })),
    h('td', { 'data-label': 'When' }, h('span', { title: fmtDate(row.created_at), text: timeAgo(row.created_at) })));
}

// ---------- the page ----------
function logsPage(params) {
  const gid = state.guildId;
  const userParam = SNOWFLAKE.test(params.get('user') || '') ? params.get('user') : '';
  const f = { page: 1, category: userParam ? '' : 'moderation', type: '', source: '', moderator: '', user: userParam, from: '', to: '', q: '' };
  let meta = null, rows = [], total = 0, pending = 0, freshKey = null, seq = 0, seenTs = Date.now(), loaded = false;

  const root = h('div', {});
  const banner = h('div');
  const controls = h('div');
  const note = h('p', { class: 'log-note', hidden: true });
  const newPill = h('div', { class: 'newpill', hidden: true });
  const holder = h('div');
  const liveDot = h('span', { class: 'dot wait' });
  const liveTxt = h('span', { text: 'Connecting…' });
  const liveEl = h('span', { class: 'live', title: 'New log entries appear here as they happen' }, liveDot, liveTxt);

  const setLive = (mode) => {
    const map = { live: ['on', 'Live'], reconnecting: ['wait', 'Reconnecting…'], polling: ['wait', 'Live (checking every 8s)'] };
    const [cls, text] = map[mode] || map.reconnecting;
    liveDot.className = `dot ${cls}`; liveTxt.textContent = text;
  };

  const qs = (extra = {}) => {
    const q = new URLSearchParams();
    const put = (k, v) => { if (v !== '' && v !== null && v !== undefined) q.set(k, v); };
    put('page', f.page); put('category', f.category); put('type', f.type); put('source', f.source); put('moderator', f.moderator);
    put('user', f.user); put('from', f.from); put('to', f.to); put('q', f.q);
    for (const [k, v] of Object.entries(extra)) put(k, v);
    return q;
  };
  const hasFilters = () => !!(f.type || f.source || f.moderator || f.user || f.from || f.to || f.q);
  const matches = (r) => {
    if (f.category && r.category !== f.category) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.source && r.source !== f.source) return false;
    if (f.moderator && r.moderator_id !== f.moderator) return false;
    if (f.user && r.target_id !== f.user) return false;
    if (f.from && r.created_at < Number(f.from)) return false;
    if (f.to && r.created_at > Number(f.to)) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![r.reason, r.target_name, r.moderator_tag].some((x) => String(x || '').toLowerCase().includes(q)) && r.target_id !== f.q) return false;
    }
    return true;
  };

  const showPill = () => {
    newPill.hidden = pending === 0;
    newPill.replaceChildren(h('button', { class: 'btn small primary', onclick: () => { f.page = 1; load(); } }, `${pending} new ${pending === 1 ? 'entry' : 'entries'} — show`));
  };

  const paint = () => {
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    if (!rows.length) {
      const noPerm = meta && !meta.audit.permission;
      holder.replaceChildren(card({}, emptyState({
        ic: 'file',
        title: hasFilters() || f.category ? 'No entries match these filters' : 'No moderation activity yet',
        text: hasFilters() || f.category
          ? 'Try another category, event type or date range.'
          : `Actions taken with the bot, from this dashboard${noPerm ? '' : ' or directly in Discord'} will appear here.`,
      })));
      return;
    }
    const fk = freshKey; freshKey = null;
    holder.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', { class: 'rtable' },
        h('thead', {}, h('tr', {}, ['Event', 'Target', 'Moderator', 'Reason', 'When'].map((x) => h('th', { text: x })))),
        h('tbody', {}, rows.map((r) => logRow(r, meta, r.key === fk))))),
      h('div', { class: 'pager' },
        h('span', { text: `${fmtNum(total)} entr${total === 1 ? 'y' : 'ies'} · page ${f.page} of ${pages}` }),
        h('div', { class: 'btns' },
          h('button', { class: 'btn small', text: 'Previous', disabled: f.page <= 1, onclick: () => { f.page--; load(); } }),
          h('button', { class: 'btn small', text: 'Next', disabled: f.page >= pages, onclick: () => { f.page++; load(); } }))));
  };

  const load = async () => {
    const mine = ++seq;
    pending = 0; newPill.hidden = true;
    holder.replaceChildren(h('div', { class: 'table-wrap' }, skeletonRows(6)));
    try {
      const r = await api(`/guilds/${gid}/activity?${qs()}`);
      if (mine !== seq) return;
      rows = r.rows; total = r.total; f.page = r.page;
      seenTs = Math.max(seenTs, ...rows.map((x) => x.created_at));
      loaded = true;
      paint();
    } catch (e) {
      if (mine === seq) holder.replaceChildren(card({}, emptyState({ ic: 'alertCircle', tone: 'danger', title: 'Could not load the log', text: e.message })));
    }
  };

  // ----- live updates -----
  const onLive = (row) => {
    seenTs = Math.max(seenTs, row.created_at);
    if (rows.some((r) => r.key === row.key) || !matches(row)) return;
    state.recent = null;
    total++;
    if (f.page === 1) { rows = [row, ...rows].slice(0, LOG_PAGE_SIZE); freshKey = row.key; paint(); }
    else { pending++; showPill(); }
  };
  const catchUp = async () => {
    try {
      const q = qs({ after: Math.max(0, seenTs - 15000) });
      q.set('page', '1');
      const r = await api(`/guilds/${gid}/activity?${q}`);
      for (const row of [...r.rows].reverse()) onLive(row);
    } catch { /* next tick will retry */ }
  };

  let es = null, errs = 0, poll = null, dead = false;
  const stop = () => { dead = true; es?.close(); clearInterval(poll); clearInterval(guard); };
  const guard = setInterval(() => { if (!root.isConnected) stop(); }, 3000);
  const startPolling = () => { if (poll) return; setLive('polling'); poll = setInterval(catchUp, 8000); };
  const connect = () => {
    if (dead) return;
    if (typeof EventSource === 'undefined') return startPolling();
    es = new EventSource(`/api/guilds/${gid}/activity/stream`);
    es.addEventListener('open', () => { errs = 0; clearInterval(poll); poll = null; setLive('live'); catchUp(); });
    es.addEventListener('activity', (e) => { try { onLive(JSON.parse(e.data)); } catch { /* ignore malformed */ } });
    es.addEventListener('bye', () => { es.close(); setTimeout(connect, 300); });
    es.addEventListener('error', () => {
      if (dead) return;
      errs++;
      if (errs >= 3) { es.close(); startPolling(); setTimeout(() => { errs = 0; connect(); }, 60000); }
      else setLive('reconnecting');
    });
  };

  // ----- controls (built once the server's filter options have loaded) -----
  const typeSel = h('select', { 'aria-label': 'Event type', onchange: (e) => { f.type = e.target.value; f.page = 1; load(); } });
  const modSel = h('select', { 'aria-label': 'Moderator', onchange: (e) => { f.moderator = e.target.value; f.page = 1; load(); } });
  const refreshTypes = () => typeSel.replaceChildren(
    h('option', { value: '', text: 'All event types' }),
    ...meta.types.filter((t) => !f.category || t.category === f.category).map((t) => h('option', { value: t.key, text: t.label, selected: f.type === t.key })));
  const dayStart = (v) => (v ? String(new Date(`${v}T00:00:00`).getTime()) : '');
  const dayEnd = (v) => (v ? String(new Date(`${v}T23:59:59.999`).getTime()) : '');

  const buildControls = () => {
    const cats = segmented([['', 'All'], ...meta.categories.map((c) => [c.id, c.label])], f.category, (v) => { f.category = v; f.type = ''; f.page = 1; refreshTypes(); load(); });
    let debounce;
    const search = h('input', { type: 'search', placeholder: 'Search logs or paste a user ID', 'aria-label': 'Search the log', value: f.user, oninput: (e) => {
      clearTimeout(debounce);
      const v = e.target.value.trim();
      debounce = setTimeout(() => {
        if (SNOWFLAKE.test(v)) { f.user = v; f.q = ''; } else { f.user = ''; f.q = v; }
        f.page = 1; load();
      }, 350);
    } });
    const srcSel = h('select', { 'aria-label': 'Source', onchange: (e) => { f.source = e.target.value; f.page = 1; load(); } },
      h('option', { value: '', text: 'Any source' }), meta.sources.map((s2) => h('option', { value: s2.id, text: s2.label })));
    const date = (label, key, conv) => h('label', { class: 'lbl-inline' }, label,
      h('input', { type: 'date', 'aria-label': `${label} date`, onchange: (e) => { f[key] = conv(e.target.value); f.page = 1; load(); } }));
    refreshTypes();
    controls.replaceChildren(cats,
      h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, icon('search', 16), search), typeSel, modSel, srcSel),
      h('div', { class: 'toolbar' }, date('From', 'from', dayStart), date('To', 'to', dayEnd),
        h('button', { class: 'btn ghost small', onclick: () => navigate('logs') }, icon('x', 14), 'Reset filters')));
  };

  const init = async () => {
    const [st, mods] = await Promise.all([
      api(`/guilds/${gid}/activity/status`),
      api(`/guilds/${gid}/activity/moderators`).catch(() => ({ moderators: [] })),
    ]);
    meta = st;
    modSel.replaceChildren(h('option', { value: '', text: 'All moderators' }),
      ...mods.moderators.map((m) => h('option', { value: m.id, text: logStrip(m.tag) || m.id, selected: f.moderator === m.id })));
    buildControls();
    const a = st.audit;
    if (!a.permission) {
      banner.replaceChildren(notice('MOONWEB can’t read this server’s audit log, so actions taken directly in Discord (bans, kicks, timeouts, role and channel changes) are not being recorded. Give the bot the View Audit Log permission — re-inviting it from Settings does this. Bot, dashboard and AutoMod actions are still logged.', 'warning', 'alertCircle'));
    } else if (a.error) {
      banner.replaceChildren(notice(`The last sync with Discord’s audit log failed (${a.error}). New actions are still recorded live; MOONWEB retries every 15 minutes.`, 'warning', 'alertCircle'));
    } else if (a.entries) {
      note.hidden = false;
      note.textContent = `${fmtNum(a.entries)} Discord audit-log entr${a.entries === 1 ? 'y' : 'ies'} stored, going back to ${fmtDate(a.firstAt)}. Discord itself only keeps 45 days; MOONWEB keeps them.`;
    }
    if (loaded) paint(); // re-label rows now that type names are known
  };

  load();
  init().catch((e) => toast(e.message, 'error'));
  connect();

  root.append(
    pageHeader('Moderation Logs', 'Moderation actions and Discord audit-log events in one place', [
      liveEl,
      h('button', { class: 'btn', onclick: () => { load(); toast('Log refreshed', 'info'); } }, icon('undo', 15), 'Refresh'),
    ]),
    banner, controls, note, newPill, holder);
  return root;
}
