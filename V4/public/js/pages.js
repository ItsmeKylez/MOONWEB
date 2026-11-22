'use strict';
/* MOONWEB pages. Every page is a function returning a DOM node.
   All data comes from the existing API; nothing here is hardcoded or fabricated. */

const notice = (text, tone = 'info', ic = 'info') => h('div', { class: `notice tone-${tone}` }, icon(ic, 18), h('div', { text }));

// ---------- shared moderation helpers ----------
function caseSource(c) {
  const t = c.moderator_tag || '';
  if (t.endsWith('(dashboard)')) return 'Dashboard';
  if (t.endsWith('(AutoMod)')) return 'AutoMod';
  if (c.reason === 'Temporary ban expired') return 'Scheduled unban';
  return 'Bot command';
}
const modName = (c) => (c.moderator_tag || c.moderator_id || 'Unknown').replace(/ \((dashboard|AutoMod)\)$/, '');

function activityItem(c, onClick) {
  const m = metaOf(c.type);
  return h('button', { class: 'act', onclick: () => { onClick?.(); openCaseModal(c); } },
    actionBubble(c.type),
    h('div', { class: 'txt' },
      h('div', {}, h('b', { text: modName(c) }), ` ${m.verb} `, h('b', { text: c.user_tag || c.user_id })),
      h('small', { text: c.reason || 'No reason provided' })),
    h('time', { text: timeAgo(c.created_at), title: fmtDate(c.created_at) }));
}

function openCaseModal(c) {
  const m = metaOf(c.type);
  const row = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
  const reversal = { ban: ['unban', 'Unban user', 'Unban'], timeout: ['untimeout', 'Remove timeout', 'Remove timeout'] }[c.type];
  const dlg = modal({
    title: `Case #${c.case_number}`, subtitle: fmtDate(c.created_at), size: 'wide',
    body: h('div', {},
      reversal && notice(c.type === 'ban' ? 'Unbanning only works while the user is still banned.' : 'Removing a timeout only works while it is still active.', 'info'),
      h('dl', { class: 'detail' },
        row('Action', actionBadge(c.type)),
        row('User', h('div', {}, h('div', { text: c.user_tag || 'Unknown' }), h('span', { class: 'mono faint', text: c.user_id }))),
        row('Moderator', h('div', {}, h('div', { text: modName(c) }), h('span', { class: 'mono faint', text: c.moderator_id }))),
        row('Reason', c.reason || 'No reason provided'),
        c.duration_ms ? row('Duration', fmtDuration(c.duration_ms)) : null,
        row('Source', caseSource(c)),
        row('When', `${fmtDate(c.created_at)} (${timeAgo(c.created_at)})`))),
    footer: [
      h('button', { class: 'btn', text: 'Close', onclick: () => dlg.close() }),
      reversal && h('button', { class: 'btn primary', onclick: async () => {
        const ok = await confirmDialog({ title: `${reversal[1]}?`, body: `This applies "${reversal[2]}" to ${c.user_tag || c.user_id}.`, confirmText: reversal[2] });
        if (!ok) return;
        try {
          const { case: n } = await api(`/guilds/${state.guildId}/actions`, { method: 'POST', json: { action: reversal[0], userId: c.user_id, reason: `Reversal of case #${c.case_number} (dashboard)` } });
          toast(`Case #${n.case_number} recorded`, 'success');
          state.recent = null; refreshStats(); dlg.close(); mountPage();
        } catch (e) { toast(e.message, 'error'); }
      } }, icon('undo', 16), reversal[1]),
    ],
  });
}

// ---------- action form (used by quick-action modal and Moderation page) ----------
function actionFields(form) {
  const extra = h('div');
  const draw = () => {
    extra.replaceChildren();
    if (form.action === 'timeout') extra.append(field('Duration', durationControl(form, 'durationMinutes')));
    if (form.action === 'ban') {
      extra.append(
        field('Duration', durationControl(form, 'durationMinutes', { permanent: true }), 'Temporary bans are lifted automatically.'),
        field('Delete message history', h('select', { onchange: (e) => { form.deleteDays = Number(e.target.value); } },
          [[0, 'Don’t delete any'], [1, 'Last 24 hours'], [3, 'Last 3 days'], [7, 'Last 7 days']].map(([v, l]) => h('option', { value: v, text: l, selected: form.deleteDays === v })))));
    }
  };
  const userInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: '123456789012345678', autocomplete: 'off', value: form.userId || '', oninput: (e) => { form.userId = e.target.value.trim(); } });
  const node = h('div', {},
    field('Discord user ID', userInput, 'Enable Developer Mode in Discord, then right-click a user → Copy User ID.'),
    extra,
    field('Reason', h('input', { type: 'text', maxlength: 500, placeholder: 'Shown to the user and saved in the case log', value: form.reason || '', oninput: (e) => { form.reason = e.target.value; } })));
  draw();
  return { node, setAction(a) { form.action = a; form.durationMinutes = a === 'timeout' ? '60' : ''; form.deleteDays = 0; draw(); }, userInput };
}
const newForm = (action, userId = '') => ({ action, userId, reason: '', durationMinutes: action === 'timeout' ? '60' : '', deleteDays: 0 });

function validateAction(f) {
  if (!SNOWFLAKE.test(f.userId || '')) return 'Enter a valid Discord user ID (17–20 digits).';
  if (['timeout'].includes(f.action) && !(Number(f.durationMinutes) > 0)) return 'Choose a timeout duration.';
  if (f.action === 'timeout' && Number(f.durationMinutes) > 40320) return 'Timeouts can be at most 28 days.';
  return null;
}
async function submitAction(form) {
  const { case: c } = await api(`/guilds/${state.guildId}/actions`, { method: 'POST', json: form });
  toast(`Case #${c.case_number} · ${metaOf(c.type).label} recorded`, 'success');
  state.recent = null; refreshStats();
  return c;
}
async function confirmAndRun(form) {
  const err = validateAction(form);
  if (err) { toast(err, 'error'); return null; }
  const m = metaOf(form.action);
  const dur = form.durationMinutes ? fmtDuration(Number(form.durationMinutes) * 60000) : null;
  const ok = await confirmDialog({
    title: `${m.label} user ${form.userId}?`,
    confirmText: m.label, tone: ['ban', 'kick', 'timeout'].includes(form.action) ? 'danger' : '',
    body: h('div', { class: 'kv' },
      h('div', {}, h('span', { text: 'Action' }), h('span', { class: 'val' }, actionBadge(form.action))),
      h('div', {}, h('span', { text: 'User ID' }), h('span', { class: 'val mono', text: form.userId })),
      dur && h('div', {}, h('span', { text: 'Duration' }), h('span', { class: 'val', text: dur })),
      h('div', {}, h('span', { text: 'Reason' }), h('span', { class: 'val', text: form.reason || 'No reason provided' }))),
  });
  if (!ok) return null;
  try { return await submitAction(form); } catch (e) { toast(e.message, 'error'); return null; }
}

/** Quick-action modal (dashboard). The modal's own button is the confirmation step. */
function quickAction(action) {
  const m = metaOf(action);
  const form = newForm(action);
  const fields = actionFields(form);
  const go = h('button', { class: `btn ${action === 'timeout' ? 'primary' : 'danger solid'}`, text: `${m.label} member` });
  const dlg = modal({
    title: `${m.label} a member`, subtitle: 'Follows the same permission and role-hierarchy checks as the bot’s slash commands.',
    body: fields.node,
    footer: [h('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), go],
  });
  go.addEventListener('click', async () => {
    const err = validateAction(form);
    if (err) return toast(err, 'error');
    btnSpinner(go, true, `${m.label}…`);
    try { await submitAction(form); dlg.close(); if (parseRoute().page === 'dashboard') mountPage(); }
    catch (e) { toast(e.message, 'error'); btnSpinner(go, false, `${m.label} member`); }
  });
}

// ---------- Cases-over-time chart (real data from /cases/timeline) ----------
const CHART_TYPES = ['ban', 'kick', 'timeout', 'warn', 'unban', 'untimeout'];
function svgEl(name, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
function niceMax(n) {
  if (n <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / mag) * mag;
}
function casesChart(timeline) {
  const total = timeline.reduce((a, d) => a + d.total, 0);
  if (!total) return emptyState({ ic: 'trend', title: 'No cases in this period', text: 'The chart fills in as moderation cases are recorded.', compact: true });
  const W = 640, H = 220, L = 34, R = 8, T = 10, B = 26;
  const max = niceMax(Math.max(...timeline.map((d) => d.total)));
  const plotW = W - L - R, plotH = H - T - B;
  const slot = plotW / timeline.length, bw = Math.max(4, Math.min(28, slot * 0.62));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `Moderation cases per day, ${total} in total` });
  for (let i = 0; i <= 4; i++) {
    const y = T + plotH - (plotH * i) / 4;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'grid' }));
    const lab = svgEl('text', { x: L - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }); lab.textContent = String(Math.round((max * i) / 4));
    svg.append(lab);
  }
  const every = Math.ceil(timeline.length / 7);
  timeline.forEach((d, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    const date = new Date(d.day).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const g = svgEl('g', { class: 'bar-col' });
    const parts = CHART_TYPES.filter((k) => d.counts[k]).map((k) => `${metaOf(k).label}: ${d.counts[k]}`);
    const tip = svgEl('title'); tip.textContent = d.total ? `${date} — ${d.total} case${d.total === 1 ? '' : 's'}\n${parts.join('\n')}` : `${date} — no cases`;
    g.append(tip, svgEl('rect', { x: L + slot * i, y: T, width: slot, height: plotH, class: 'hit' }));
    let y = T + plotH;
    for (const k of CHART_TYPES) {
      const n = d.counts[k] || 0;
      if (!n) continue;
      const hgt = (n / max) * plotH;
      y -= hgt;
      g.append(svgEl('rect', { x, y, width: bw, height: Math.max(1, hgt), rx: 2, class: `bar tone-${metaOf(k).tone}` }));
    }
    svg.append(g);
    if (i % every === 0 || i === timeline.length - 1) {
      const lab = svgEl('text', { x: x + bw / 2, y: H - 7, class: 'axis', 'text-anchor': 'middle' }); lab.textContent = date;
      svg.append(lab);
    }
  });
  const present = CHART_TYPES.filter((k) => timeline.some((d) => d.counts[k]));
  const legend = h('div', { class: 'legend' }, present.map((k) => h('span', { class: `lg tone-${metaOf(k).tone}` }, h('i'), metaOf(k).label)));
  return h('div', { class: 'chart-wrap' }, svg, legend);
}
function casesChartCard() {
  let days = Number(lsGet('chartDays')) || 14;
  const body = h('div', {});
  const load = async () => {
    body.replaceChildren(skeleton('100%', 200));
    try {
      const r = await api(`/guilds/${state.guildId}/cases/timeline?days=${days}&tz=${-new Date().getTimezoneOffset()}`);
      body.replaceChildren(casesChart(r.timeline));
    } catch (e) {
      body.replaceChildren(emptyState({ ic: 'alertCircle', tone: 'danger', title: 'Could not load chart', text: e.message, compact: true }));
    }
  };
  load();
  const range = segmented([[7, '7d'], [14, '14d'], [30, '30d']], days, (v) => { days = Number(v); lsSet('chartDays', String(days)); load(); });
  range.classList.add('seg-inline');
  return card({ title: 'Cases over time', subtitle: 'Moderation cases recorded per day', actions: range }, body);
}

// ---------- Dashboard ----------
function dashboardPage() {
  const { guild, stats } = state.data;
  const st = s();
  const t = stats.byType;
  const chan = state.data.channels.find((c) => c.id === st.logChannelId);

  const feed = h('div', { class: 'activity' }, skeletonRows(5));
  loadRecent(true).then((rows) => {
    feed.replaceChildren(...(rows.length ? rows.slice(0, 8).map((c) => activityItem(c)) : [emptyState({ ic: 'file', title: 'No moderation activity yet', text: 'Actions taken with the bot or from this dashboard will show up here.', compact: true })]));
  }).catch((e) => feed.replaceChildren(emptyState({ ic: 'alertCircle', tone: 'danger', title: 'Could not load activity', text: e.message, compact: true })));

  const qa = (ic, label, tone, fn) => h('button', { class: 'qa', onclick: fn }, h('span', { class: `ibubble sm tone-${tone}` }, icon(ic, 16)), label, icon('chevRight', 16));

  return h('div', {},
    pageHeader('Dashboard', `Overview of ${guild.name}`, [
      h('button', { class: 'btn', onclick: async () => { await refreshStats(); mountPage(); toast('Dashboard refreshed', 'info'); } }, icon('undo', 15), 'Refresh'),
    ]),
    h('div', { class: 'grid-stats' },
      statCard({ label: 'Members', value: fmtNum(guild.memberCount), ic: 'users', tone: 'accent' }),
      statCard({ label: 'Bans issued', value: fmtNum(t.ban || 0), ic: 'ban', tone: 'danger' }),
      statCard({ label: 'Cases in last 24h', value: fmtNum(stats.last24h), ic: 'clock', tone: 'info', hint: `${fmtNum(stats.total)} total` }),
      statCard({ label: 'Warnings issued', value: fmtNum(t.warn || 0), ic: 'alert', tone: 'warning' })),
    h('div', { class: 'grid-main' },
      h('div', { class: 'stack' },
        card({ title: 'Recent moderation activity', actions: h('button', { class: 'btn small ghost', onclick: () => navigate('logs') }, 'View all', icon('chevRight', 14)) }, feed),
        casesChartCard(),
        card({ title: 'Member growth', subtitle: 'Joins and leaves over time' },
          emptyState({ ic: 'trend', title: 'Not enough history yet', text: 'MOONWEB doesn’t have join/leave history to chart. This will appear once member tracking is enabled.', compact: true }))),
      h('div', { class: 'stack' },
        card({ title: 'Server' },
          h('div', { class: 'cell-user' }, guildIconEl(guild, 'lg'), h('div', {}, h('b', { text: guild.name }), h('small', { text: `${fmtNum(guild.memberCount)} members` }))),
          h('div', { class: 'kv' },
            h('div', {}, h('span', { text: 'Bot status' }), h('span', { class: 'val' }, h('span', { class: 'dot wait', 'data-bot-dot': '' }), h('span', { 'data-bot-text': '', text: botStatusText() }))),
            h('div', {}, h('span', { text: 'Auto-moderation' }), h('span', { class: `badge tone-${st.automod.enabled ? 'success' : 'neutral'}`, text: st.automod.enabled ? 'Enabled' : 'Disabled' })),
            h('div', {}, h('span', { text: 'Log channel' }), chan ? h('span', { class: 'val', text: `# ${chan.name}` }) : h('button', { class: 'btn small', text: 'Set up', onclick: () => navigate('settings') })))),
        card({ title: 'Quick actions' },
          h('div', { class: 'qa-grid' },
            qa('ban', 'Ban member', 'danger', () => quickAction('ban')),
            qa('userX', 'Kick member', 'warning', () => quickAction('kick')),
            qa('clock', 'Timeout member', 'info', () => quickAction('timeout')),
            qa('megaphone', 'Create announcement', 'accent', () => navigate('announcements')),
            qa('userPlus', 'Configure welcome messages', 'accent', () => navigate('welcome')))))));
}

// ---------- Moderation ----------
function moderationPage(params) {
  const holder = h('div');
  const show = (tab) => holder.replaceChildren(tab === 'automod' ? automodTab() : actionsTab(params));
  const seg = segmented([['actions', 'Actions'], ['automod', 'Auto-moderation']], params.get('tab') === 'automod' ? 'automod' : 'actions', show);
  show(params.get('tab') === 'automod' ? 'automod' : 'actions');
  return h('div', {}, pageHeader('Moderation', 'Take action on members and configure automatic rules'), seg, holder);
}

function actionsTab(params) {
  const form = newForm('warn', SNOWFLAKE.test(params.get('user') || '') ? params.get('user') : '');
  const fields = actionFields(form);
  const actionSel = h('select', { 'aria-label': 'Action', onchange: (e) => fields.setAction(e.target.value) },
    Object.entries(ACTION_META).map(([k, v]) => h('option', { value: k, text: v.label, selected: k === form.action })));
  const go = h('button', { class: 'btn primary', text: 'Apply action' });
  go.addEventListener('click', async () => {
    btnSpinner(go, true, 'Working…');
    const c = await confirmAndRun(form);
    btnSpinner(go, false, 'Apply action');
    if (c) { form.reason = ''; mountPage(); }
  });
  const recent = h('div', { class: 'activity' }, skeletonRows(4));
  loadRecent().then((rows) => recent.replaceChildren(...(rows.length ? rows.slice(0, 5).map((c) => activityItem(c)) : [emptyState({ ic: 'file', title: 'No actions yet', compact: true })]))).catch(() => recent.replaceChildren());
  return h('div', { class: 'grid-main' },
    card({ title: 'Take action', subtitle: 'Every action is saved as a case and posted to your log channel' },
      field('Action', actionSel), fields.node, h('div', { class: 'row' }, go)),
    h('div', { class: 'stack' },
      card({ title: 'Before you act' }, h('div', { class: 'kv' },
        h('div', {}, h('span', { text: 'Permissions' }), h('span', { class: 'val', text: 'Your Discord permissions apply' })),
        h('div', {}, h('span', { text: 'Role hierarchy' }), h('span', { class: 'val', text: 'Checked for you and the bot' })),
        h('div', {}, h('span', { text: 'DMs' }), h('span', { class: 'val', text: 'User is notified when possible' })))),
      card({ title: 'Recent actions' }, recent)));
}

function automodTab() {
  const a = s().automod;
  const rowOf = (...f) => h('div', { class: 'row' }, ...f);
  return h('div', { class: 'stack' },
    card({}, check('Enable auto-moderation', a, 'enabled', null, 'Broken rules delete the message, warn the member, and repeated warnings trigger the escalation below. Members with Manage Messages are exempt.')),
    card({ title: 'Rules' },
      ruleBlock('Spam', a.spam, rowOf(field('Max messages', num(a.spam, 'maxMessages', 2, 30)), field('Within (seconds)', num(a.spam, 'seconds', 2, 60))), 'Too many messages too fast'),
      ruleBlock('Discord invite links', a.invites, null, 'Delete messages containing server invites'),
      ruleBlock('Links', a.links, field('Allowed domains (one per line)', listArea(a.links, 'allowlist', 'youtube.com\ntwitter.com'), 'Subdomains are allowed automatically.'), 'Block all links except allowed domains'),
      ruleBlock('Word filter', a.badWords, field('Blocked words (one per line)', listArea(a.badWords, 'words', 'word1\nword2'), 'Matches whole words, case-insensitive.')),
      ruleBlock('Mass mentions', a.mentions, field('Max mentions per message', num(a.mentions, 'max', 2, 50))),
      ruleBlock('Excessive caps', a.caps, rowOf(field('Min. letters', num(a.caps, 'minLength', 8, 200)), field('Caps percentage', num(a.caps, 'percent', 40, 100)))),
      ruleBlock('Raid protection', a.raid, rowOf(
        field('Joins', num(a.raid, 'joins', 3, 100)), field('Within (seconds)', num(a.raid, 'seconds', 3, 120)),
        field('Action', h('select', { onchange: (e) => { a.raid.action = e.target.value; markDirty(); } },
          h('option', { value: 'alert', text: 'Alert in log channel', selected: a.raid.action === 'alert' }),
          h('option', { value: 'kick', text: 'Alert and kick new joiners', selected: a.raid.action === 'kick' }))))),
    ),
    card({ title: 'Escalation', subtitle: 'What happens as a member collects warnings' },
      rowOf(field('Every N active warnings', num(a.strikes, 'warnings', 1, 20)),
        field('Do this', h('select', { onchange: (e) => { a.strikes.action = e.target.value; markDirty(); } },
          ['timeout', 'kick', 'ban'].map((x) => h('option', { value: x, text: x[0].toUpperCase() + x.slice(1), selected: a.strikes.action === x })))),
        field('Timeout length (minutes)', num(a.strikes, 'durationMin', 1, 40320)))),
    card({ title: 'Exemptions' },
      field('Exempt roles', multi(a, 'exemptRoleIds', state.data.roles), 'Ctrl/Cmd-click to select several.'),
      field('Exempt channels', multi(a, 'exemptChannelIds', state.data.channels, '# '))),
    saveBar());
}

// ---------- Members (not built yet: honest placeholder) ----------
function membersPage() {
  return h('div', {}, pageHeader('Members', 'Search and manage the people in your server'),
    card({}, emptyState({ ic: 'users', title: 'Member management is coming soon', text: 'Until then, you can already look up any user by Discord ID to review their cases or take action.',
      action: h('button', { class: 'btn primary', onclick: openPalette }, icon('search', 16), 'Look up a user') })));
}
// announcementsPage() lives in announce.js

// ---------- Welcome & Goodbye ----------
function welcomePage() {
  const w = s().welcome;
  const g = state.data.guild;
  const dcRender = (text) => {
    const t = text.replaceAll('{server}', g.name).replaceAll('{count}', String(g.memberCount + 1));
    const out = []; const re = /\{user\}|\*\*(.+?)\*\*/g; let last = 0; let m;
    while ((m = re.exec(t))) {
      if (m.index > last) out.push(t.slice(last, m.index));
      out.push(m[0] === '{user}' ? h('span', { class: 'mention', text: '@NewMember' }) : h('b', { text: m[1] }));
      last = m.index + m[0].length;
    }
    out.push(t.slice(last));
    return out;
  };
  const tx = h('div', { class: 'tx' }, ...dcRender(w.message));
  const ta = h('textarea', { maxlength: 500, oninput: (e) => { w.message = e.target.value; tx.replaceChildren(...dcRender(w.message)); markDirty(); } }, w.message);
  const chip = (v) => h('button', { class: 'btn small', type: 'button', text: v, onclick: () => { ta.value += v; ta.dispatchEvent(new Event('input')); ta.focus(); } });
  return h('div', {},
    pageHeader('Welcome & Goodbye', 'Greet new members when they join'),
    h('div', { class: 'grid-main' },
      h('div', { class: 'stack' },
        card({ title: 'Welcome message' },
          check('Send a welcome message', w, 'enabled', null, 'Posts in the channel below whenever someone joins.'),
          h('div', { class: 'field' }),
          field('Channel', chanSelect(w, 'channelId', 'Select a channel…')),
          field('Message', ta, 'Variables: {user} mentions the member, {server} is the server name, {count} is the member count. **bold** works.'),
          h('div', { class: 'row' }, ['{user}', '{server}', '{count}'].map(chip))),
        card({ title: 'Goodbye message', actions: h('span', { class: 'badge tone-neutral', text: 'Coming soon' }) },
          emptyState({ ic: 'userX', title: 'Goodbye messages aren’t available yet', text: 'Leave messages, embeds and test messages are planned for a later update.', compact: true })),
        saveBar()),
      card({ title: 'Live preview', subtitle: 'Approximately how it will look in Discord' },
        h('div', { class: 'dc' }, h('div', { class: 'av' }, icon('moon', 20)), h('div', {}, h('span', { class: 'nm', text: 'Bot' }), h('span', { class: 'bot', text: 'BOT' }), tx)),
        h('p', { class: 'hint', text: 'Preview uses sample values. It updates as you type.' }))));
}

// ---------- Settings ----------
function settingsPage() {
  const st = s();
  return h('div', {}, pageHeader('Settings', 'Server-wide configuration'),
    h('div', { class: 'stack' },
      card({ title: 'General' },
        field('Log channel', chanSelect(st, 'logChannelId'), 'Moderation actions, edits, deletes, joins and leaves are posted here. The bot needs Send Messages and Embed Links there.'),
        field('Auto role for new members', roleSelect(st, 'autoRoleId'), 'The bot’s highest role must be above this role.')),
      card({ title: 'Bot access', subtitle: 'Re-invite the bot to refresh its permissions' },
        notice('Drag the bot’s role above any role it should moderate. Discord won’t let a bot act on members whose role is higher than its own.', 'warning', 'alertCircle'),
        h('a', { class: 'btn', href: state.me.inviteUrl, target: '_blank', rel: 'noopener' }, icon('externalLink', 16), 'Open invite link')),
      saveBar()));
}

// ---------- Bulk send (logic unchanged; restyled) ----------
function bulkPage() {
  const lim = state.me.limits;
  const files = [];
  let job = null;
  const form = { channelId: '', caption: '', delaySeconds: 1.5 };
  const list = h('ul', { class: 'files' });
  const status = h('div');
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  const send = h('button', { class: 'btn primary', text: 'Send files', disabled: true });
  const tooBig = (f) => f.size > lim.maxFileMB * 1048576;

  const refresh = () => {
    list.replaceChildren(...files.map((f, i) => h('li', {},
      h('span', { text: f.name }),
      h('span', { class: tooBig(f) ? 'size over-limit' : 'size', text: fmtSize(f.size) + (tooBig(f) ? ' — too big' : '') }),
      h('button', { class: 'btn ghost small icon-only', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); refresh(); } }, icon('x', 14)))));
    send.disabled = !!job || !files.length || files.length > lim.maxFiles || files.some(tooBig);
  };
  const add = (fl) => { for (const f of fl) files.push(f); refresh(); };
  input.addEventListener('change', () => { add(input.files); input.value = ''; });

  const drop = h('div', { class: 'drop', tabindex: '0', role: 'button' }, icon('upload', 26), 'Drop files here, or click to choose');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); });

  const showJob = (j) => {
    const done = j.sent + j.failed;
    const bar = h('div', { class: 'bar' }, h('div'));
    bar.firstChild.style.width = `${Math.round((done / j.total) * 100)}%`;
    status.replaceChildren(
      h('p', { class: j.status === 'error' ? 'err' : '', text: j.status === 'running' ? `Sending… ${j.sent}/${j.total} sent` : j.status === 'done' ? `Finished: ${j.sent}/${j.total} sent in ${j.messages} message(s).` : `Failed: ${j.error}` }),
      bar,
      j.failures?.length ? h('p', { class: 'err', text: `Not sent: ${j.failures.map((x) => `${x.name} (${x.reason})`).join('; ')}` }) : null);
  };

  send.addEventListener('click', async () => {
    if (!form.channelId) return toast('Pick a channel first', 'error');
    const ch = state.data.channels.find((c) => c.id === form.channelId);
    const ok = await confirmDialog({ title: 'Send files?', body: `${files.length} file(s) will be posted to #${ch?.name ?? 'the channel'} in batches of 10.`, confirmText: 'Send' });
    if (!ok) return;
    const fd = new FormData();
    fd.append('channelId', form.channelId);
    fd.append('caption', form.caption);
    fd.append('delaySeconds', form.delaySeconds);
    for (const f of files) fd.append('files', f, f.name);
    send.disabled = true;
    status.replaceChildren(h('p', { class: 'muted', text: 'Uploading…' }));
    try {
      const { jobId } = await api(`/guilds/${state.guildId}/bulk`, { method: 'POST', form: fd });
      job = { status: 'running', sent: 0, failed: 0, total: files.length };
      showJob(job);
      const poll = async () => {
        try {
          job = await api(`/guilds/${state.guildId}/bulk/${jobId}`);
          showJob(job);
          if (job.status === 'running') return setTimeout(poll, 1000);
          if (job.status === 'done') { files.length = 0; toast('Bulk send finished', 'success'); }
          job = null; refresh();
        } catch (e) { status.replaceChildren(h('p', { class: 'err', text: e.message })); job = null; refresh(); }
      };
      poll();
    } catch (e) { status.replaceChildren(h('p', { class: 'err', text: e.message })); toast(e.message, 'error'); refresh(); }
  });

  refresh();
  return h('div', {},
    pageHeader('Bulk Send', 'Post many images, videos or files to a channel'),
    notice(`Up to ${lim.maxFiles} files, ${lim.maxFileMB} MB each. Discord allows 10 attachments per message, so files are split into batches with a pause between them. Only use this in servers you manage.`),
    card({},
      field('Channel', h('select', { onchange: (e) => { form.channelId = e.target.value; } },
        h('option', { value: '', text: 'Choose a channel…' }),
        state.data.channels.map((c) => h('option', { value: c.id, text: `# ${c.name}` })))),
      field('Caption (optional)', h('input', { type: 'text', maxlength: 1900, placeholder: 'Posted with the first message', onchange: (e) => { form.caption = e.target.value; } })),
      field('Pause between messages (seconds)', h('input', { type: 'number', min: 0, max: 30, step: 0.5, value: form.delaySeconds, onchange: (e) => { form.delaySeconds = e.target.value; } })),
      drop, input, list,
      h('div', { class: 'row' }, h('div', {}, send)), status));
}

const PAGE_VIEWS = { dashboard: dashboardPage, members: membersPage, moderation: moderationPage, logs: logsPage, announcements: announcementsPage, welcome: welcomePage, bulk: bulkPage, settings: settingsPage };
