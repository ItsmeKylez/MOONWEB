'use strict';
/* MOONWEB dashboard overview (Feature 1): live server statistics, join/leave analytics, moderation analytics.
   Real data only. Unavailable data is shown as "—" with the reason, never as 0.
   Auto-refresh: one lightweight poller per mounted dashboard (stops when the page is left, pauses while the tab is hidden,
   never overlaps requests, backs off after failures). Nothing here uses innerHTML. */

const DASH_RANGES = [['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']];
const DASH_BUCKETS = { '24h': ['hour'], '7d': ['day'], '30d': ['day', 'week'], '90d': ['day', 'week', 'month'] };
const DASH_BUCKET_LABEL = { hour: 'Hourly', day: 'Daily', week: 'Weekly', month: 'Monthly' };
const DASH_MOD_TYPES = ['ban', 'kick', 'timeout', 'warn', 'unban', 'untimeout'];

const dashTz = () => -new Date().getTimezoneOffset();
const fmtSigned = (n) => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(-n)}` : '0');

function bucketLabel(b, kind, long) {
  const d = new Date(b.start);
  if (kind === 'hour') return long ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' }) : d.toLocaleTimeString([], { hour: 'numeric' });
  if (kind === 'month') return d.toLocaleDateString([], long ? { month: 'long', year: 'numeric' } : { month: 'short' });
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return kind === 'week' && long ? `Week of ${day}${b.partial ? ' (partial)' : ''}` : day;
}

/**
 * Generic SVG bar chart. series: [{ label, tone, get(bucket) -> number|null }]. A bucket whose `covered` is false is drawn as
 * "no data" (never as zero). mode: grouped | stacked | diverging (first series, bars above/below zero).
 */
function dashChart({ buckets, series, mode = 'grouped', kind = 'day', height = 210, unit = 'item', aria }) {
  const W = 640, H = height, L = 38, R = 8, T = 10, B = 26;
  const plotW = W - L - R, plotH = H - T - B;
  let max = 0, min = 0;
  for (const b of buckets) {
    const v = series.map((s) => s.get(b) ?? 0);
    if (mode === 'stacked') max = Math.max(max, v.reduce((a, c) => a + c, 0));
    else if (mode === 'diverging') { max = Math.max(max, v[0]); min = Math.min(min, v[0]); }
    else max = Math.max(max, ...v);
  }
  max = niceMax(max);
  if (mode === 'diverging') min = min < 0 ? -niceMax(-min) : 0;
  const span = max - min;
  const y = (v) => T + (plotH * (max - v)) / span;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': aria || 'Chart' });
  for (let i = 0; i <= 4; i++) {
    const v = min + (span * i) / 4;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 && min < 0 ? 'grid zero' : 'grid' }));
    const lab = svgEl('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }); lab.textContent = String(Math.round(v));
    svg.append(lab);
  }
  const slot = plotW / buckets.length;
  const groupW = Math.max(4, Math.min(34, slot * 0.72));
  const every = Math.ceil(buckets.length / 7);
  buckets.forEach((b, i) => {
    const x0 = L + slot * i;
    const g = svgEl('g', { class: 'bar-col' });
    const tip = svgEl('title');
    const when = bucketLabel(b, kind, true);
    if (b.covered === false) {
      tip.textContent = `${when} — no data was recorded for this period`;
      g.append(tip, svgEl('rect', { x: x0 + (slot - groupW) / 2, y: T, width: groupW, height: plotH, rx: 3, class: 'nodata' }));
    } else {
      const parts = series.map((s) => `${s.label}: ${fmtNum(s.get(b) ?? 0)}`);
      tip.textContent = `${when}${b.current ? ' (in progress)' : ''}\n${parts.join('\n')}`;
      g.append(tip, svgEl('rect', { x: x0, y: T, width: slot, height: plotH, class: 'hit' }));
      if (mode === 'stacked') {
        let top = y(0);
        series.forEach((s) => {
          const v = s.get(b) || 0; if (!v) return;
          const hgt = (v / span) * plotH; top -= hgt;
          g.append(svgEl('rect', { x: x0 + (slot - groupW) / 2, y: top, width: groupW, height: Math.max(1, hgt), rx: 2, class: `cbar tone-${s.tone}` }));
        });
      } else if (mode === 'diverging') {
        const v = series[0].get(b) || 0;
        if (v) g.append(svgEl('rect', { x: x0 + (slot - groupW) / 2, y: v > 0 ? y(v) : y(0), width: groupW, height: Math.max(1, Math.abs(y(v) - y(0))), rx: 2, class: `cbar tone-${v > 0 ? 'success' : 'danger'}` }));
      } else {
        const bw = groupW / series.length;
        series.forEach((s, k) => {
          const v = s.get(b) || 0; if (!v) return;
          g.append(svgEl('rect', { x: x0 + (slot - groupW) / 2 + bw * k, y: y(v), width: Math.max(2, bw - 1), height: Math.max(1, y(0) - y(v)), rx: 2, class: `cbar tone-${s.tone}` }));
        });
      }
    }
    svg.append(g);
    if (i % every === 0 || i === buckets.length - 1) {
      const lab = svgEl('text', { x: x0 + slot / 2, y: H - 7, class: 'axis', 'text-anchor': 'middle' }); lab.textContent = bucketLabel(b, kind, false);
      svg.append(lab);
    }
  });
  const legend = mode === 'diverging' ? null : h('div', { class: 'legend' }, series.map((s) => h('span', { class: `lg tone-${s.tone}` }, h('i'), s.label)));
  return h('div', { class: 'chart-wrap' }, svg, legend);
}

const kpi = (label, value, { tone = 'neutral', hint, delta } = {}) => h('div', { class: `kpi tone-${tone}` },
  h('span', { class: 'lbl', text: label }),
  h('b', { text: value }),
  (hint || delta) && h('small', {}, delta, hint));

function deltaBadge(pct, prev) {
  if (pct === null) return h('span', { class: 'delta flat', text: prev === 0 ? 'no earlier data to compare' : '' });
  return h('span', { class: `delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}`, text: `${pct > 0 ? '▲' : pct < 0 ? '▼' : '■'} ${Math.abs(pct)}% vs previous period` });
}

const dashError = (msg, retry) => emptyState({ ic: 'alertCircle', tone: 'danger', title: 'Could not load this section', text: msg, compact: true,
  action: retry && h('button', { class: 'btn small', onclick: retry }, icon('undo', 14), 'Try again') });

/**
 * A card with range (and bucket) filters that loads one /dashboard/<path> endpoint.
 * refresh(true) = quiet background refresh: skipped while a request is in flight, and the DOM is only touched if the data changed.
 */
function analyticsCard({ title, subtitle, path, storeKey, render }) {
  let range = lsGet(storeKey);
  if (!DASH_BUCKETS[range]) range = '7d';
  let bucket = lsGet(`${storeKey}B`);
  const fixBucket = () => { if (!DASH_BUCKETS[range].includes(bucket)) bucket = DASH_BUCKETS[range][0]; };
  fixBucket();
  const body = h('div', { class: 'an-body' }, skeleton('100%', 220));
  const bucketSlot = h('span', { class: 'seg-slot' });
  let seq = 0, busy = false, loaded = false, sig = '';

  async function load(quiet) {
    if (quiet && busy) return;
    const my = ++seq; busy = true;
    if (!quiet || !loaded) body.replaceChildren(skeleton('100%', 220));
    try {
      const data = await api(`/guilds/${state.guildId}/dashboard/${path}?range=${range}&bucket=${bucket}&tz=${dashTz()}`);
      if (my !== seq) return;
      const s = JSON.stringify({ ...data, to: 0, from: 0 });
      if (!(quiet && loaded && s === sig)) body.replaceChildren(render(data, { range, bucket, reload: () => load(false) }));
      sig = s; loaded = true; body.classList.remove('stale');
    } catch (e) {
      if (my !== seq) return;
      if (loaded) body.classList.add('stale'); // keep showing the last good data
      else body.replaceChildren(dashError(e.message, () => load(false)));
      throw e;
    } finally { if (my === seq) busy = false; }
  }

  function drawBucketPicker() {
    const opts = DASH_BUCKETS[range];
    bucketSlot.replaceChildren(...(opts.length > 1 ? [segmented(opts.map((o) => [o, DASH_BUCKET_LABEL[o]]), bucket, (v) => { bucket = v; lsSet(`${storeKey}B`, v); sig = ''; load(false).catch(() => {}); })] : []));
    bucketSlot.firstChild?.classList.add('seg-inline');
  }
  drawBucketPicker();
  const rangeSeg = segmented(DASH_RANGES, range, (v) => { range = v; lsSet(storeKey, v); fixBucket(); drawBucketPicker(); sig = ''; load(false).catch(() => {}); });
  rangeSeg.classList.add('seg-inline');
  const node = card({ title, subtitle, actions: h('div', { class: 'card-tools' }, bucketSlot, rangeSeg) }, body);
  load(false).catch(() => {});
  return { node, refresh: () => load(true) };
}

// ---------- join / leave analytics ----------
function growthBody(d, ctx) {
  const c = d.coverage;
  if (!c.hasData) {
    return emptyState({
      ic: 'trend', title: 'No join/leave history yet', compact: true,
      text: c.trackingEnabled ? 'MOONWEB records members as they join and leave. Charts appear after the first join or leave is seen — nothing is estimated for earlier dates.'
        : 'Join/leave logging is switched off, so nothing is being recorded.',
      action: !c.trackingEnabled && h('button', { class: 'btn small', onclick: () => navigate('welcome') }, 'Open Welcome settings'),
    });
  }
  const t = d.totals;
  const covered = d.buckets.filter((b) => b.covered);
  const notes = [];
  if (!c.trackingEnabled) notes.push(h('p', { class: 'note warn' }, icon('alert', 14), 'Join/leave logging is currently switched off in Welcome settings, so new activity is not being recorded.'));
  if (c.partial) notes.push(h('p', { class: 'note' }, icon('info', 14), `Recording began ${fmtDate(c.trackingSince)}. Earlier periods are shown as “no data”, not as zero.`));
  const best = covered.length ? covered.reduce((a, b) => (b.joins > a.joins ? b : a)) : null;
  return h('div', { class: 'stack tight' },
    h('div', { class: 'kpi-row' },
      kpi('Joins', fmtNum(t.joins), { tone: 'success' }),
      kpi('Departures', fmtNum(t.leaves), { tone: 'danger' }),
      kpi('Net growth', fmtSigned(t.net), { tone: t.net > 0 ? 'success' : t.net < 0 ? 'danger' : 'neutral', hint: covered.length ? `${(t.net / covered.length).toFixed(1)} per ${d.bucket}` : null }),
      kpi('Busiest', best && best.joins ? fmtNum(best.joins) : '—', { hint: best && best.joins ? bucketLabel(best, d.bucket, true) : 'no joins yet' })),
    dashChart({ buckets: d.buckets, kind: d.bucket, mode: 'grouped', unit: 'member', aria: `Member joins and departures, ${fmtNum(t.joins)} joins and ${fmtNum(t.leaves)} departures`,
      series: [{ label: 'Joins', tone: 'success', get: (b) => b.joins }, { label: 'Departures', tone: 'danger', get: (b) => b.leaves }] }),
    h('div', { class: 'sub-title', text: 'Net growth' }),
    dashChart({ buckets: d.buckets, kind: d.bucket, mode: 'diverging', height: 130, aria: 'Net member growth', series: [{ label: 'Net', tone: 'accent', get: (b) => b.net }] }),
    ...notes);
}

// ---------- moderation analytics ----------
function moderationBody(d) {
  const t = d.totals;
  const types = DASH_MOD_TYPES.filter((k) => d.byType[k]);
  const notes = [];
  if (!d.source.auditEntries) notes.push(h('p', { class: 'note' }, icon('info', 14), 'These counts cover actions taken with MOONWEB. Actions made directly in Discord appear after audit-log sync has data (the bot needs View Audit Log).'));
  return h('div', { class: 'stack tight' },
    h('div', { class: 'kpi-row' },
      kpi('Actions in range', fmtNum(t.inRange), { tone: 'accent', delta: deltaBadge(t.change, t.previous) }),
      kpi('Last 24 hours', fmtNum(t.last24h), { tone: 'info' }),
      kpi('All time', fmtNum(t.allTime)),
      kpi('Most common', types.length ? metaOf(types.reduce((a, b) => (d.byType[b] > d.byType[a] ? b : a))).label : '—', { hint: types.length ? `${fmtNum(Math.max(...types.map((k) => d.byType[k])))} in range` : 'no actions in range' })),
    t.inRange ? h('div', { class: 'chips' }, types.map((k) => h('span', { class: `badge tone-${metaOf(k).tone}` }, icon(metaOf(k).icon, 12), `${metaOf(k).label} · ${fmtNum(d.byType[k])}`))) : null,
    t.inRange
      ? dashChart({ buckets: d.buckets, kind: d.bucket, mode: 'stacked', aria: `Moderation actions, ${t.inRange} in range`,
        series: DASH_MOD_TYPES.filter((k) => d.byType[k]).map((k) => ({ label: metaOf(k).label, tone: metaOf(k).tone, get: (b) => b.counts[k] || 0 })) })
      : emptyState({ ic: 'shield', title: 'No moderation actions in this period', text: 'The chart fills in as actions are taken.', compact: true }),
    ...notes);
}

// ---------- live statistics ----------
const PRESENCE_REASON = {
  intent_disabled: 'Presence unavailable — see README to enable the Presence Intent',
  members_incomplete: 'Presence unavailable — member list is still loading',
  too_large: 'Presence unavailable — server is too large to scan',
  discord_no_count: 'Discord did not return an online count',
};
const COMPOSITION_REASON = { members_incomplete: 'Member list is still loading', too_large: 'Server too large to scan' };

function liveStatCard({ label, ic, tone }) {
  const value = h('b', { text: '—' });
  const hint = h('small', { text: '' });
  const node = h('div', { class: `card stat tone-${tone}` }, h('span', { class: 'ibubble' }, icon(ic, 19)), h('div', {}, value, h('span', { class: 'lbl', text: label }), hint));
  node.classList.add('loading');
  return { node, set(v, hintText, extra) { value.textContent = v; hint.textContent = hintText || ''; node.classList.remove('loading'); node.classList.toggle('unavailable', v === '—'); node.dataset.source = extra || ''; } };
}

function liveStats() {
  const cards = {
    total: liveStatCard({ label: 'Total members', ic: 'users', tone: 'accent' }),
    online: liveStatCard({ label: 'Online', ic: 'checkCircle', tone: 'success' }),
    offline: liveStatCard({ label: 'Offline', ic: 'moon', tone: 'neutral' }),
    humans: liveStatCard({ label: 'Humans', ic: 'userPlus', tone: 'info' }),
    bots: liveStatCard({ label: 'Bots', ic: 'server', tone: 'warning' }),
    growth: liveStatCard({ label: 'Net growth (7 days)', ic: 'trend', tone: 'success' }),
  };
  const node = h('div', { class: 'grid-stats dash-stats' }, Object.values(cards).map((c) => c.node));
  function update(s) {
    const { live, growth } = s;
    cards.total.set(fmtNum(live.total), live.generatedAt ? `Updated ${new Date(live.generatedAt).toLocaleTimeString()}` : '');
    const p = live.presence;
    if (p.available) {
      const hintText = p.source === 'gateway' ? 'Exact · live from Discord' : 'Approximate · Discord estimate';
      cards.online.set(fmtNum(p.online), hintText, p.source);
      cards.offline.set(fmtNum(p.offline), hintText, p.source);
    } else {
      const why = PRESENCE_REASON[p.reason] || 'Presence data unavailable';
      cards.online.set('—', why); cards.offline.set('—', why);
    }
    const c = live.composition;
    if (c.available) { cards.humans.set(fmtNum(c.humans), 'People'); cards.bots.set(fmtNum(c.bots), 'Bot accounts'); }
    else { const why = COMPOSITION_REASON[c.reason] || 'Unavailable'; cards.humans.set('—', why); cards.bots.set('—', why); }
    if (!growth.hasData) cards.growth.set('—', 'Tracking starts with the first join or leave');
    else cards.growth.set(fmtSigned(growth.last7d.net), `${fmtNum(growth.last7d.joins)} joined · ${fmtNum(growth.last7d.leaves)} left${growth.last7d.partial ? ` · since ${new Date(growth.trackingSince).toLocaleDateString()}` : ''}`);
  }
  return { node, update };
}

// ---------- auto refresh ----------
/** Polls `tasks` ({ every ms, fn }) while `root` is on screen and the tab is visible. Never overlaps a task with itself. */
function startPoller(root, tasks, onStatus) {
  const t = tasks.map((x) => ({ ...x, last: 0, busy: false, fails: 0 }));
  let stopped = false;
  async function run(task) {
    if (task.busy || stopped) return;
    task.busy = true;
    try { await task.fn(); task.fails = 0; task.last = Date.now(); onStatus?.(true, task); }
    catch (e) { task.fails++; task.last = Date.now(); onStatus?.(false, task, e); }
    finally { task.busy = false; }
  }
  function tick() {
    if (stopped) return;
    if (!root.isConnected) return stop();
    if (document.hidden) return;
    const now = Date.now();
    for (const x of t) if (now - x.last >= x.every * Math.min(8, 2 ** x.fails)) run(x);
  }
  const onVis = () => { if (!document.hidden) tick(); };
  function stop() { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); }
  const timer = setInterval(tick, 5000);
  document.addEventListener('visibilitychange', onVis);
  return { stop, runAll: () => Promise.all(t.map((x) => { x.last = 0; return run(x); })) };
}

// ---------- page ----------
function dashboardPage() {
  const { guild } = state.data;
  const st = s();
  const chan = state.data.channels.find((c) => c.id === st.logChannelId);
  const gid = state.guildId;

  const stats = liveStats();
  const growth = analyticsCard({ title: 'Member growth', subtitle: 'Joins, departures and net change', path: 'growth', storeKey: 'dashGrowth', render: growthBody });
  const moderation = analyticsCard({ title: 'Moderation analytics', subtitle: 'Bans, kicks, timeouts, warnings and unbans', path: 'moderation', storeKey: 'dashMod', render: moderationBody });

  const feed = h('div', { class: 'activity' }, skeletonRows(5));
  const loadFeed = async () => {
    const rows = await loadRecent(true);
    feed.replaceChildren(...(rows.length ? rows.slice(0, 8).map((c) => activityItem(c)) : [emptyState({ ic: 'file', title: 'No moderation activity yet', text: 'Actions taken with the bot or from this dashboard will show up here.', compact: true })]));
  };

  const pill = h('span', { class: 'live-pill wait', role: 'status' }, h('i'), h('span', { text: 'Connecting…' }));
  const setPill = (kind, text) => { pill.className = `live-pill ${kind}`; pill.lastChild.textContent = text; };

  const root = h('div', { class: 'dash' });
  let firstSummary = true;
  const live = startPoller(root, [
    { every: 30_000, fn: async () => { const sum = await api(`/guilds/${gid}/dashboard/summary`); stats.update(sum); setPill('on', `Live · updated ${new Date().toLocaleTimeString()}`); firstSummary = false; await loadFeed().catch(() => {}); } },
    { every: 120_000, fn: () => growth.refresh() },
    { every: 120_000, fn: () => moderation.refresh() },
  ], (ok, task, err) => {
    if (task.every !== 30_000) return;
    if (!ok) setPill('off', firstSummary ? 'Could not load live data' : 'Connection problem — retrying');
  });
  // first paint: don't wait for the first 5 s tick
  live.runAll();

  const qa = (ic, label, tone, fn) => h('button', { class: 'qa', onclick: fn }, h('span', { class: `ibubble sm tone-${tone}` }, icon(ic, 16)), label, icon('chevRight', 16));
  const refreshBtn = h('button', { class: 'btn' }, icon('undo', 15), 'Refresh');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    await live.runAll();
    refreshBtn.disabled = false;
    toast('Dashboard refreshed', 'info');
  });

  root.append(
    pageHeader('Dashboard', `Overview of ${guild.name}`, [pill, refreshBtn]),
    stats.node,
    h('div', { class: 'grid-main' },
      h('div', { class: 'stack' },
        growth.node,
        moderation.node,
        card({ title: 'Recent moderation activity', actions: h('button', { class: 'btn small ghost', onclick: () => navigate('logs') }, 'View all', icon('chevRight', 14)) }, feed)),
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
  return root;
}
