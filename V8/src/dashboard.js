'use strict';
/* Feature 1 — dashboard analytics service.
   Live member statistics (cached, no needless Discord requests), member-count snapshots, join/leave growth,
   moderation analytics, staff leaderboard, announcement delivery stats and the recent-events feed.
   Everything is scoped by guild_id and built from real stored or live Discord data only. */
const config = require('./config');
const store = require('./db');
const { db } = store;
const dash = require('./utils/dashfmt');
const { getSettings } = require('./settings');
require('./welcome'); // creates member_events / member_audit
require('./announcements'); // creates announcements / announcement_deliveries

db.exec(`
CREATE TABLE IF NOT EXISTS member_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, ts INTEGER NOT NULL,
  total INTEGER NOT NULL, online INTEGER, humans INTEGER, bots INTEGER
);
CREATE INDEX IF NOT EXISTS idx_member_snapshots ON member_snapshots (guild_id, ts);
`);

const LIVE_TTL_MS = 30_000; // how long a computed live-stats answer is reused
const APPROX_TTL_MS = 60_000; // Discord's approximate online count is fetched at most this often per server
const FETCH_RETRY_MS = 120_000; // retry a failed/partial full member fetch no sooner than this
const FULL_FETCH_MAX = 25_000; // above this many members the dashboard does not scan the whole list
const SNAPSHOT_EVERY_MS = 55 * 60_000;
const SNAPSHOT_KEEP_MS = 400 * 86400000;

const MOD_LABELS = ['ban', 'kick', 'timeout', 'warn', 'unban', 'untimeout'];
const ANN_DONE = "('sent','partial','failed','deleted')";

// ---------- live statistics ----------
const live = new Map(); // guildId -> { at, value, promise, membersTriedAt, approxAt, approx }

function entry(id) {
  if (!live.has(id)) live.set(id, { at: 0, value: null, promise: null, membersTriedAt: 0, approxAt: 0, approx: null });
  return live.get(id);
}

/** Make sure the member cache holds every member (needed for the human/bot split and exact presence). */
async function ensureMembers(guild, e) {
  const total = guild.memberCount || 0;
  if (total > FULL_FETCH_MAX) return { complete: false, reason: 'too_large' };
  if (guild.members.cache.size >= total) return { complete: true };
  if (Date.now() - e.membersTriedAt < FETCH_RETRY_MS) return { complete: false, reason: 'members_incomplete' };
  e.membersTriedAt = Date.now();
  try {
    await guild.members.fetch();
  } catch (err) {
    console.warn('[dashboard] member fetch failed:', err.message);
    return { complete: false, reason: 'members_incomplete' };
  }
  return guild.members.cache.size >= total ? { complete: true } : { complete: false, reason: 'members_incomplete' };
}

/** Discord's own approximate online count (REST, works without the Presence intent). Returns null when unavailable. */
async function approxOnline(guild, e) {
  if (Date.now() - e.approxAt < APPROX_TTL_MS) return e.approx;
  e.approxAt = Date.now();
  try {
    const g = await guild.client.guilds.fetch({ guild: guild.id, force: true, withCounts: true });
    e.approx = Number.isFinite(g?.approximatePresenceCount) ? g.approximatePresenceCount : null;
  } catch (err) {
    console.warn('[dashboard] approximate presence fetch failed:', err.message);
    e.approx = null;
  }
  return e.approx;
}

async function computeLive(guild) {
  const e = entry(guild.id);
  const total = guild.memberCount || 0;
  const m = await ensureMembers(guild, e);

  let composition;
  if (m.complete) {
    let bots = 0;
    for (const mem of guild.members.cache.values()) if (mem.user?.bot) bots++;
    composition = { available: true, humans: Math.max(0, guild.members.cache.size - bots), bots, reason: null };
    // use the server's own count as the total when the cache is the same size, otherwise keep the cache split honest
    if (guild.members.cache.size !== total) composition.cacheSize = guild.members.cache.size;
  } else {
    composition = { available: false, humans: null, bots: null, reason: m.reason };
  }

  const intentEnabled = !!config.presenceIntent;
  let presence = { available: false, source: null, intentEnabled, online: null, offline: null, reason: intentEnabled ? 'members_incomplete' : 'intent_disabled' };
  if (intentEnabled && m.complete) {
    let online = 0;
    for (const mem of guild.members.cache.values()) {
      const st = mem.presence?.status;
      if (st && st !== 'offline' && st !== 'invisible') online++;
    }
    presence = { available: true, source: 'gateway', intentEnabled, online, offline: Math.max(0, total - online), reason: null };
  } else {
    const approx = await approxOnline(guild, e);
    if (approx !== null) {
      presence = { available: true, source: 'approximate', intentEnabled, online: approx, offline: Math.max(0, total - approx), reason: null };
    } else if (intentEnabled && !m.complete) {
      presence.reason = m.reason;
    } else {
      presence.reason = intentEnabled ? 'discord_no_count' : 'intent_disabled';
    }
  }

  return {
    generatedAt: Date.now(),
    guild: { id: guild.id, name: guild.name, icon: guild.icon || null },
    total, composition, presence,
  };
}

/** Cached live stats; concurrent callers share one computation. */
async function getLiveStats(guild, { force = false } = {}) {
  const e = entry(guild.id);
  if (!force && e.value && Date.now() - e.at < LIVE_TTL_MS) return e.value;
  if (e.promise) return e.promise;
  e.promise = computeLive(guild).then((v) => { e.value = v; e.at = Date.now(); return v; }).finally(() => { e.promise = null; });
  return e.promise;
}

// ---------- snapshots (member count over time) ----------
const insSnap = db.prepare('INSERT INTO member_snapshots (guild_id, ts, total, online, humans, bots) VALUES (?,?,?,?,?,?)');
function recordSnapshot(guildId, v, now = Date.now()) {
  insSnap.run(guildId, now, v.total, v.presence?.available ? v.presence.online : null, v.composition?.available ? v.composition.humans : null, v.composition?.available ? v.composition.bots : null);
}
function lastSnapshotAt(guildId) {
  return db.prepare('SELECT MAX(ts) AS t FROM member_snapshots WHERE guild_id = ?').get(guildId).t ?? 0;
}
async function snapshotTick(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      if (Date.now() - lastSnapshotAt(guild.id) < SNAPSHOT_EVERY_MS) continue;
      recordSnapshot(guild.id, await getLiveStats(guild, { force: true }));
    } catch (err) { console.warn('[dashboard] snapshot failed:', err.message); }
  }
  db.prepare('DELETE FROM member_snapshots WHERE ts < ?').run(Date.now() - SNAPSHOT_KEEP_MS);
}
function startSnapshots(client) {
  snapshotTick(client).catch(() => {});
  setInterval(() => snapshotTick(client).catch(() => {}), 10 * 60_000).unref();
}

// ---------- member join / leave growth ----------
function trackingSince(guildId) {
  return db.prepare('SELECT MIN(created_at) AS t FROM member_events WHERE guild_id = ?').get(guildId).t ?? null;
}

function joinLeaveCounts(guildId, from, until = Date.now() + 1000) {
  const r = db.prepare("SELECT type, COUNT(*) AS n FROM member_events WHERE guild_id = ? AND type IN ('join','leave') AND created_at >= ? AND created_at <= ? GROUP BY type").all(guildId, from, until);
  const o = { joins: 0, leaves: 0 };
  for (const x of r) o[x.type === 'join' ? 'joins' : 'leaves'] = x.n;
  return { ...o, net: o.joins - o.leaves };
}

function memberGrowth(guildId, { range, bucket, tz = 0, now = Date.now() } = {}) {
  const L = dash.layout({ now, range, bucket, tz });
  const since = trackingSince(guildId);
  const buckets = L.buckets.map((b) => ({
    start: b.start, end: b.end, current: b.current, partial: b.partial,
    covered: since !== null && b.end > since, // false = nothing was being recorded for any part of this bucket
    joins: 0, leaves: 0, net: 0,
  }));
  const rows = db.prepare(`SELECT CAST((created_at + @off) / @size AS INTEGER) AS b, type, COUNT(*) AS n FROM member_events
      WHERE guild_id = @g AND type IN ('join','leave') AND created_at >= @from AND created_at <= @until GROUP BY b, type`)
    .all({ g: guildId, off: L.off, size: L.size, from: L.from, until: now });
  for (const r of rows) {
    const slot = L.slotOfBase(r.b);
    if (slot < 0) continue;
    buckets[slot][r.type === 'join' ? 'joins' : 'leaves'] += r.n;
  }
  const totals = { joins: 0, leaves: 0, net: 0 };
  for (const b of buckets) {
    if (!b.covered) { b.joins = b.leaves = b.net = null; continue; }
    b.net = b.joins - b.leaves;
    totals.joins += b.joins; totals.leaves += b.leaves;
  }
  totals.net = totals.joins - totals.leaves;
  const snaps = db.prepare('SELECT ts, total, online FROM member_snapshots WHERE guild_id = ? AND ts >= ? ORDER BY ts').all(guildId, L.from);
  return {
    range: L.range, bucket: L.bucket, from: L.from, to: now, buckets, totals,
    coverage: {
      hasData: since !== null,
      trackingSince: since,
      partial: since === null || since > L.from, // true = part of the selected range was not recorded
      trackingEnabled: !!getSettings(guildId).joinAutomation?.logJoinLeave,
    },
    snapshots: dash.downsample(snaps, 200),
  };
}

function growthSummary(guildId, now = Date.now()) {
  const since = trackingSince(guildId);
  const win = (ms) => ({ ...joinLeaveCounts(guildId, now - ms, now + 1000), partial: since === null || since > now - ms });
  return { hasData: since !== null, trackingSince: since, last24h: win(86400000), last7d: win(7 * 86400000), last30d: win(30 * 86400000), trackingEnabled: !!getSettings(guildId).joinAutomation?.logJoinLeave };
}

// ---------- moderation analytics ----------
function moderationAnalytics(guildId, { range, bucket, tz = 0, now = Date.now() } = {}) {
  const L = dash.layout({ now, range, bucket, tz });
  const buckets = L.buckets.map((b) => ({ start: b.start, end: b.end, current: b.current, partial: b.partial, total: 0, counts: {} }));
  for (const r of store.moderationBuckets(guildId, { from: L.from, until: now, size: L.size, off: L.off })) {
    const slot = L.slotOfBase(r.b);
    if (slot < 0) continue;
    buckets[slot].counts[r.type] = (buckets[slot].counts[r.type] || 0) + r.n;
    buckets[slot].total += r.n;
  }
  const byType = store.moderationCounts(guildId, { from: L.from, until: now });
  const span = now - L.from;
  const prevByType = store.moderationCounts(guildId, { from: L.from - span, until: L.from - 1 });
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const inRange = sum(byType);
  const previous = sum(prevByType);
  const all = store.moderationCounts(guildId, {});
  const last24h = sum(store.moderationCounts(guildId, { from: now - 86400000, until: now + 1000 }));
  const audit = store.auditStatus(guildId);
  return {
    range: L.range, bucket: L.bucket, from: L.from, to: now,
    totals: { allTime: sum(all), last24h, inRange, previous, change: dash.pctChange(inRange, previous) },
    allTimeByType: all, byType, previousByType: prevByType, buckets,
    source: { auditEntries: audit.entries, auditLastSyncAt: audit.lastSyncAt, auditError: audit.error },
  };
}

// ---------- staff leaderboard ----------
function displayFor(guild, id, fallbackTag, avatarHash) {
  const member = guild.members?.cache?.get(id);
  const user = member?.user ?? guild.client?.users?.cache?.get(id);
  return {
    name: member?.displayName || user?.globalName || user?.username || dash.cleanTag(fallbackTag) || id,
    username: user?.username || dash.cleanTag(fallbackTag) || null,
    avatar: user?.avatar || avatarHash || null,
  };
}

async function staffLeaderboard(guild, { range, now = Date.now() } = {}) {
  const r = dash.parseRange(range);
  const from = dash.layout({ now, range: r }).from;
  const rows = store.staffBreakdown(guild.id, { from });
  const botId = guild.client?.user?.id;
  const by = new Map();
  let automated = 0;
  for (const x of rows) {
    if (botId && x.id === botId) { automated += x.n; continue; }
    let s = by.get(x.id);
    if (!s) { s = { id: x.id, tag: x.tag, avatarHash: null, total: 0, breakdown: {}, lastAt: 0, lastType: null }; by.set(x.id, s); }
    s.total += x.n;
    s.breakdown[x.type] = (s.breakdown[x.type] || 0) + x.n;
    if (x.avatar) s.avatarHash = x.avatar;
    if (x.last_at > s.lastAt) { s.lastAt = x.last_at; s.lastType = x.type; }
  }
  const top = [...by.values()].sort((a, b) => b.total - a.total || b.lastAt - a.lastAt).slice(0, 10);
  const missing = top.filter((s) => !guild.members.cache.has(s.id)).map((s) => s.id);
  if (missing.length) await guild.members.fetch({ user: missing }).catch(() => {});
  return {
    range: r, from, automated,
    staff: top.map((s) => ({ id: s.id, ...displayFor(guild, s.id, s.tag, s.avatarHash), total: s.total, breakdown: s.breakdown, lastAt: s.lastAt, lastType: s.lastType })),
  };
}

// ---------- announcements ----------
function previewOf(payloadJson) {
  try {
    const p = JSON.parse(payloadJson);
    const t = (p.content || p.embeds?.find((e) => e.title || e.description)?.title || p.embeds?.[0]?.description || '').toString().replace(/\s+/g, ' ').trim();
    return t.length > 90 ? `${t.slice(0, 89)}…` : t || '(embed)';
  } catch { return ''; }
}

function announcementStats(guildId, { range, bucket, tz = 0, now = Date.now() } = {}) {
  const L = dash.layout({ now, range, bucket, tz });
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM announcements WHERE guild_id = ? GROUP BY status').all(guildId).map((r) => [r.status, r.n]));
  const del = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM announcement_deliveries WHERE guild_id = ? GROUP BY status').all(guildId).map((r) => [r.status, r.n]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const delivered = (del.sent || 0) + (del.deleted || 0);
  const failed = del.failed || 0;
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM scheduled WHERE guild_id = ? AND action = 'announce'").get(guildId).n;
  const next = db.prepare("SELECT id, author_tag, scheduled_at, payload, (SELECT COUNT(*) FROM announcement_deliveries d WHERE d.announcement_id = announcements.id) AS channels FROM announcements WHERE guild_id = ? AND status = 'scheduled' ORDER BY scheduled_at LIMIT 5").all(guildId)
    .map((a) => ({ id: a.id, author: a.author_tag, scheduledAt: a.scheduled_at, channels: a.channels, preview: previewOf(a.payload) }));
  const recent = db.prepare(`SELECT a.id, a.author_tag, a.status, a.payload, COALESCE(a.sent_at, a.created_at) AS at,
      COALESCE((SELECT SUM(d.status IN ('sent','deleted')) FROM announcement_deliveries d WHERE d.announcement_id = a.id), 0) AS ok,
      COALESCE((SELECT SUM(d.status = 'failed') FROM announcement_deliveries d WHERE d.announcement_id = a.id), 0) AS bad,
      (SELECT COUNT(*) FROM announcement_deliveries d WHERE d.announcement_id = a.id) AS channels
      FROM announcements a WHERE a.guild_id = ? AND a.status IN ${ANN_DONE} ORDER BY at DESC, a.id DESC LIMIT 6`).all(guildId)
    .map((a) => ({ id: a.id, author: a.author_tag, status: a.status, at: a.at, delivered: a.ok, failed: a.bad, channels: a.channels, preview: previewOf(a.payload) }));
  const buckets = L.buckets.map((b) => ({ start: b.start, end: b.end, current: b.current, partial: b.partial, announcements: 0, delivered: 0, failed: 0 }));
  const rows = db.prepare(`SELECT CAST((COALESCE(a.sent_at, a.created_at) + @off) / @size AS INTEGER) AS b, COUNT(DISTINCT a.id) AS n,
      COALESCE(SUM(d.status IN ('sent','deleted')), 0) AS ok, COALESCE(SUM(d.status = 'failed'), 0) AS bad
      FROM announcements a LEFT JOIN announcement_deliveries d ON d.announcement_id = a.id
      WHERE a.guild_id = @g AND a.status IN ${ANN_DONE} AND COALESCE(a.sent_at, a.created_at) >= @from AND COALESCE(a.sent_at, a.created_at) <= @until GROUP BY b`)
    .all({ g: guildId, off: L.off, size: L.size, from: L.from, until: now });
  for (const r of rows) {
    const slot = L.slotOfBase(r.b);
    if (slot < 0) continue;
    buckets[slot].announcements += r.n; buckets[slot].delivered += r.ok; buckets[slot].failed += r.bad;
  }
  const inRange = buckets.reduce((a, b) => a + b.announcements, 0);
  return {
    range: L.range, bucket: L.bucket, from: L.from, to: now,
    totals: { announcements: total, byStatus, inRange },
    deliveries: { delivered, failed, pending: del.pending || 0, cancelled: del.cancelled || 0, successRate: delivered + failed > 0 ? Math.round((delivered / (delivered + failed)) * 1000) / 10 : null },
    pending: { scheduled: byStatus.scheduled || 0, legacyScheduledMessages: legacy, total: (byStatus.scheduled || 0) + legacy, next },
    recent, buckets,
  };
}

// ---------- recent events ----------
const CATEGORY_IDS = ['members', 'moderation', 'roles', 'channels', 'server', 'announcements'];
const parseCategory = (c) => (CATEGORY_IDS.includes(c) ? c : '');

function recentServerEvents(guildId, { category = '', after = 0, limit = 20 } = {}) {
  limit = Math.min(50, Math.max(1, Number(limit) || 20));
  const rows = store.recentEvents(guildId, { category: parseCategory(category), after: Math.max(0, Number(after) || 0), limit });
  const changes = store.auditChanges(guildId, rows.filter((r) => r.src === 'audit').map((r) => r.ref));
  return rows.map((r) => ({
    key: r.key, source: r.src, type: r.type, category: r.category,
    target: r.target_id || r.target_name ? { id: r.target_id, name: r.target_name, type: r.target_type } : null,
    actor: r.actor_id || r.actor_name ? { id: r.actor_id, name: dash.cleanTag(r.actor_name), avatar: r.avatar || null } : null,
    detail: r.detail || (r.src === 'audit' ? dash.summarizeChanges(changes.get(r.ref)) : null) || null,
    caseNumber: r.case_number ?? null, at: r.created_at,
  }));
}

// ---------- summary (one cheap request for the stat cards) ----------
async function summary(guild, { now = Date.now() } = {}) {
  const g = guild.id;
  const [liveStats] = await Promise.all([getLiveStats(guild)]);
  const mod = store.moderationCounts(g, { from: now - 86400000, until: now + 1000 });
  const ann = db.prepare("SELECT status, COUNT(*) AS n FROM announcements WHERE guild_id = ? GROUP BY status").all(g);
  const del = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM announcement_deliveries WHERE guild_id = ? GROUP BY status').all(g).map((r) => [r.status, r.n]));
  const delivered = (del.sent || 0) + (del.deleted || 0);
  const audit = store.auditStatus(g);
  return {
    generatedAt: now,
    live: liveStats,
    growth: growthSummary(g, now),
    moderation: { last24h: Object.values(mod).reduce((a, b) => a + b, 0), last24hByType: mod },
    announcements: {
      total: ann.reduce((a, r) => a + r.n, 0),
      pending: (ann.find((r) => r.status === 'scheduled')?.n || 0),
      delivered, failed: del.failed || 0,
      successRate: delivered + (del.failed || 0) > 0 ? Math.round((delivered / (delivered + (del.failed || 0))) * 1000) / 10 : null,
    },
    audit: { entries: audit.entries, lastSyncAt: audit.lastSyncAt, error: audit.error, permission: !!guild.members?.me?.permissions?.has?.(1n << 7n) },
  };
}

module.exports = {
  MOD_LABELS, CATEGORY_IDS, parseCategory,
  getLiveStats, recordSnapshot, snapshotTick, startSnapshots,
  memberGrowth, growthSummary, moderationAnalytics, staffLeaderboard, announcementStats, recentServerEvents, summary,
};
