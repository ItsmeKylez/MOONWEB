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

function activityItem(c, onClick) {
  const m = metaOf(c.type);
  return h('button', { class: 'act', onclick: () => { onClick?.(); openCaseModal(c); } },
    actionBubble(c.type),
    h('div', { class: 'txt' },
      h('div', {}, h('b', { text: modName(c) }), ` ${m.verb} `, h('b', { text: c.user_tag || c.user_id })),
      h('small', { text: c.reason || 'No reason provided' })),
    h('time', { text: timeAgo(c.created_at), title: fmtDate(c.created_at) }));
}

function modName(c) {
  return (c.moderator_tag || c.moderator_id || 'Unknown').replace(/ \((dashboard|AutoMod)\)$/, '');
}

function openCaseModal(c) {
  const m = metaOf(c.type);
  const row = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
  const reversal = { ban: ['unban', 'Unban user', 'Unban'], timeout: ['untimeout', 'Remove timeout', 'Remove timeout'] }[c.type];
  const footerBtns = [
    h('button', { class: 'btn', text: 'Close', onclick: () => dlg.close() }),
  ];
  if (reversal) {
    footerBtns.push(h('button', { class: 'btn primary', onclick: async () => {
      const ok = await confirmDialog({ title: `${reversal[1]}?`, body: `This applies "${reversal[2]}" to ${c.user_tag || c.user_id}.`, confirmText: reversal[2] });
      if (!ok) return;
      try {
        const { case: n } = await api(`/guilds/${state.guildId}/actions`, { method: 'POST', json: { action: reversal[0], userId: c.user_id, reason: `Reversal of case #${c.case_number} (dashboard)` } });
        toast(`Case #${n.case_number} recorded`, 'success');
        state.recent = null; refreshStats(); dlg.close(); mountPage();
      } catch (e) { toast(e.message, 'error'); }
    }}, icon('undo', 16), reversal[1]));
  }
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
        row('When', `${fmtDate(c.created_at)} (${timeAgo(c.created_at)})`)),
    footer: footerBtns,
  });
}

function caseSource(c) {
  const t = c.moderator_tag || '';
  if (t.endsWith('(dashboard)')) return 'Dashboard';
  if (t.endsWith('(AutoMod)')) return 'AutoMod';
  if (c.reason === 'Temporary ban expired') return 'Scheduled unban';
  return 'Bot command';
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
          [['0', "Don't delete any"], ['1', 'Last 24 hours'], ['3', 'Last 3 days'], ['7', 'Last 7 days']].map(([v, l]) => h('option', { value: v, text: l, selected: form.deleteDays === v })))));
  };
  // Use member selector if available, fallback to manual input
  let userSelector = null;
  let userInput = null;
  if (typeof memberSelectorField === 'function' && state.guildId) {
    const sel = memberSelectorField('Discord user', {
      guildId: state.guildId,
      onSelect: (m) => { form.userId = m?.id || ''; userInput?.dispatchEvent?.(new Event('input')); },
      placeholder: 'Search members…',
      allowManual: true,
    });
    userSelector = sel.wrapper;
    userInput = sel.input;
    // Pre-fill if userId already set
    if (form.userId) {
      fetchMemberForInput(form.userId, userInput, sel.selector);
    }
  } else {
    userInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: '123456789012345678', autocomplete: 'off', value: form.userId || '', oninput: (e) => { form.userId = e.target.value.trim(); } });
  }
  const node = h('div', {},
    userSelector || field('Discord user ID', userInput, 'Enable Developer Mode in Discord, then right-click a user → Copy User ID.'),
    extra,
    field('Reason', h('input', { type: 'text', maxlength: 500, placeholder: 'Shown to the user and saved in the case log', value: form.reason || '', oninput: (e) => { form.reason = e.target.value; } })));
  draw();
  return { node, setAction(a) { form.action = a; form.durationMinutes = a === 'timeout' ? '60' : ''; form.deleteDays = 0; draw(); }, userInput };
}
const newForm = (action, userId = '') => ({ action, userId, reason: '', durationMinutes: action === 'timeout' ? '60' : '', deleteDays: 0 });

async function fetchMemberForInput(userId, input, selector) {
  try {
    const r = await api(`/guilds/${state.guildId}/members/${userId}`);
    if (r.member && selector) selector.setMember(r.member);
  } catch { /* ignore */ }
}

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
      h('div', {}, h('span', { text: 'Reason' }), h('span', { class: 'val', text: form.reason || 'No reason provided' })),
    );
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
    title: `${m.label} a member`, subtitle: 'Follows the same permission and role-hierarchy checks as the bot\'s slash commands.',
    body: fields.node,
    footer: [h('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), go],
  });
  go.addEventListener('click', async () => {
    const err = validateAction(form);
    if (err) return toast(err, 'error');
    btnSpinner(go, true, `${m.label}...`);
    try { await submitAction(form); dlg.close(); if (parseRoute().page === 'dashboard') mountPage(); }
    catch (e) { toast(e.message, 'error'); btnSpinner(go, false, `${m.label} member`); }
  });
  // If member selector was used, focus it
  if (fields.userInput && typeof fields.userInput.focus === 'function') {
    setTimeout(() => fields.userInput.focus(), 100);
  }
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

  // Load dashboard stats from API
  let apiStats = null;
  loadDashboardStats().then(d => { apiStats = d; mountPage(); }).catch(() => {/* non-fatal */});

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
        apiStats && card({ title: 'Analytics', subtitle: 'Server analytics dashboard' },
          h('div', { class: 'row' },
            statCard({ label: 'Total cases', value: fmtNum(apiStats.totalCases), ic: 'file', tone: 'info' }),
            statCard({ label: 'Active warns', value: fmtNum(apiStats.activeWarns), ic: 'alert', tone: 'warning' }),
            statCard({ label: 'Avg cases/24h', value: apiStats.avg24h > 0 ? fmtNum(apiStats.avg24h.toFixed(1)) : '--', ic: 'clock', tone: 'info' }))),
        casesChartCard(),
        card({ title: 'Member growth', subtitle: 'Joins and leaves over time' },
          emptyState({ ic: 'trend', title: 'Not enough history yet', text: 'MOONWEB doesn\'t have join/leave history to chart. This will appear once member tracking is enabled.', compact: true })),
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
            qa('userPlus', 'Configure welcome messages', 'accent', () => navigate('welcome'))))));

  // Load dashboard stats from API
  async function loadDashboardStats() {
    try {
      const [st, actStats] = await Promise.all([
        api(`/guilds/${state.guildId}/activity/status`),
        api(`/guilds/${state.guildId}/cases/timeline?days=30`),
      ]);
      const cases30 = actStats.timeline || [];
      const totalCases = cases30.reduce((sum, d) => sum + d.total, 0);
      const activeWarns = (st && st.total) || 0;
      const days = cases30.length;
      const avg24h = days > 0 ? totalCases / days : 0;
      const recentTotal = (st && st.entries) || 0;
      return {
        totalCases: recentTotal,
        activeWarns: activeWarns || 0,
        avg24h: avg24h || 0,
      };
    } catch {
      return null;
    }
  }
}

// ---------- Moderation ----------
function moderationPage(params) {
  const userParam = params.get('user');
  const form = newForm('warn', SNOWFLAKE.test(userParam || '') ? userParam : '');
  const fields = actionFields(form);
  const actionSel = h('select', { 'aria-label': 'Action', onchange: (e) => fields.setAction(e.target.value) },
    Object.entries(ACTION_META).map(([k, v]) => h('option', { value: k, text: v.label, selected: k === form.action })));
  const go = h('button', { class: 'btn primary', text: 'Apply action' });
  go.addEventListener('click', async () => {
    btnSpinner(go, true, 'Working...');
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
          [['alert', 'Alert in log channel only'], ['timeout', 'Alert and time out new joiners (10 min)'], ['kick', 'Alert and kick new joiners']].map(([v, t]) => h('option', { value: v, text: t, selected: a.raid.action === v }))))),
    ),
    card({ title: 'Escalation', subtitle: 'What happens as a member collects warnings' },
      rowOf(field('Every N active warnings', num(a.strikes, 'warnings', 1, 20)),
        field('Do this', h('select', { onchange: (e) => { a.strikes.action = e.target.value; markDirty(); } },
          ['timeout', 'kick', 'ban'].map((x) => h('option', { value: x, text: x[0].toUpperCase() + x.slice(1), selected: a.strikes.action === x })))),
        field('Timeout length (minutes)', num(a.strikes, 'durationMin', 1, 40320)))),
    card({ title: 'Exemptions' },
      field('Exempt roles', multi(a, 'exemptRoleIds', state.data.roles), 'Ctrl/Cmd-click to select several.'),
      field('Exempt channels', multi(a, 'exemptChannelIds', state.data.channels, '# ')),
    saveBar());
}

// ---------- Members (not built yet: honest placeholder) ----------
function membersPage() {
  return h('div', {}, pageHeader('Members', 'Search and manage the people in your server'),
    card({}, emptyState({ ic: 'users', title: 'Member management is coming soon', text: 'Until then, you can already look up any user by Discord ID to review their cases or take action.',
      action: h('button', { class: 'btn primary', onclick: openPalette }, icon('search', 16), 'Look up a user') })));
}
// announcementsPage() lives in announce.js

// welcomePage() lives in welcome.js (Stage 6)

// ---------- Settings ----------
function settingsPage() {
  const st = s();
  return h('div', {}, pageHeader('Settings', 'Server-wide configuration'),
    h('div', { class: 'stack' },
      card({ title: 'General' },
        field('Log channel', chanSelect(st, 'logChannelId'), 'Moderation actions, edits, deletes, joins and leaves are posted here. The bot needs Send Messages and Embed Links there.'),
        field('Auto role for new members', roleSelect(st, 'autoRoleId'), 'The bot\'s highest role must be above this role.'),
        field('Verification role', roleSelect(st, 'joinAutomation.verificationRoleId'), 'Given INSTEAD of the auto role to flagged new accounts (below age limit).')),
      card({ title: 'Role Permissions', subtitle: 'Configure which roles can access MOONWEB features' },
        field('Roles with Manage Server access', multi(st, 'manageRoleIds', state.data.roles), 'Members with these roles can access dashboard and run moderation actions.'),
        field('Roles with Ban access', multi(st, 'banRoleIds', state.data.roles), 'Members with these roles can ban users via dashboard.'),
        field('Roles with Kick access', multi(st, 'kickRoleIds', state.data.roles), 'Members with these roles can kick users via dashboard.'),
        field('Roles with Timeout access', multi(st, 'timeoutRoleIds', state.data.roles), 'Members with these roles can timeout users via dashboard.')),
      card({ title: 'Bot customization', subtitle: 'Bot presence and status' },
        h('div', { class: 'row' },
          field('Bot activity type', h('select', { onchange: (e) => { st.bot.activityType = e.target.value; markDirty(); } }, ['', 'PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'COMPETING'].map((x) => h('option', { value: x, text: x || 'No activity', selected: st.bot.activityType === x })))),
          h('div', { class: 'grow' }, field('Custom activity text', wlText(st.bot, 'activityText', { max: 128 })))),
      card({ title: 'Configuration management', subtitle: 'Import/export and backups' },
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', text: 'Export configuration', onclick: async () => {
            try {
              const d = await api(`/guilds/${state.guildId}`);
              const blob = new Blob([JSON.stringify(d.settings, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = h('a', { href: url, download: `moonweb-settings-${state.guildId}.json`, rel: 'noopener' }, icon('upload', 16), ' Download');
              toast('Configuration exported', 'success');
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) { toast(e.message, 'error'); }
          } }),
          h('button', { class: 'btn ghost', text: 'Import configuration', onclick: async () => {
            const input = h('input', { type: 'file', accept: '.json' });
            const close = () => { document.body.removeChild(input); };
            input.onchange = async (e) => {
              const file = e.target.files?.[0];
              if (!file) { close(); return; }
              try {
                const text = await file.text();
                const settings = JSON.parse(text);
                // Validate structure and apply selectively
                if (settings.logChannelId !== undefined) st.logChannelId = settings.logChannelId;
                if (settings.autoRoleId !== undefined) st.autoRoleId = settings.autoRoleId;
                if (settings.welcome) st.welcome = { ...st.welcome, ...settings.welcome };
                if (settings.goodbye) st.goodbye = { ...st.goodbye, ...settings.goodbye };
                if (settings.joinAutomation) st.joinAutomation = { ...st.joinAutomation, ...settings.joinAutomation };
                markDirty();
                toast('Configuration imported (selected settings applied)', 'success');
              } catch (err) { toast(`Import failed: ${err.message}`, 'error'); }
              close();
            };
            document.body.append(input);
            input.click();
          })))),
      saveBar()));
}