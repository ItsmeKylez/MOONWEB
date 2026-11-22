const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const bus = require('./utils/logbus');
const { CASE_TYPES } = require('./utils/audit');
const db = new Database(path.join(config.dataDir, 'modbot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  case_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_tag TEXT,
  moderator_id TEXT NOT NULL,
  moderator_tag TEXT,
  reason TEXT,
  duration_ms INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (guild_id, case_number)
);
CREATE INDEX IF NOT EXISTS idx_cases_user ON cases (guild_id, user_id);
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  run_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_run ON scheduled (run_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  action_type INTEGER NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  target_id TEXT,
  target_type TEXT,
  target_name TEXT,
  executor_id TEXT,
  executor_tag TEXT,
  executor_avatar TEXT,
  moderator_id TEXT,
  moderator_tag TEXT,
  source TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  changes TEXT,
  extra TEXT,
  case_id INTEGER,
  created_at INTEGER NOT NULL,
  imported INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (guild_id, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_mod ON audit_log (guild_id, moderator_id);
CREATE TABLE IF NOT EXISTS audit_sync (
  guild_id TEXT PRIMARY KEY,
  last_sync_at INTEGER,
  error TEXT
);
`);

// Migration: scheduled announcements need extra columns on databases created before they existed.
{
  const cols = new Set(db.prepare('PRAGMA table_info(scheduled)').all().map((c) => c.name));
  for (const [name, type] of [['channel_id', 'TEXT'], ['message', 'TEXT'], ['frequency', "TEXT NOT NULL DEFAULT 'once'"]]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE scheduled ADD COLUMN ${name} ${type}`);
  }
}

const insertCase = db.prepare(`
  INSERT INTO cases (guild_id, case_number, type, user_id, user_tag, moderator_id, moderator_tag, reason, duration_ms, active, created_at)
  VALUES (@guildId, @caseNumber, @type, @userId, @userTag, @moderatorId, @moderatorTag, @reason, @durationMs, 1, @createdAt)
`);
const nextNumber = db.prepare('SELECT COALESCE(MAX(case_number), 0) + 1 AS n FROM cases WHERE guild_id = ?');
const getById = db.prepare('SELECT * FROM cases WHERE id = ?');

// If Discord's audit entry for a bot action arrived before its case was written, link them now.
const linkAuditToCase = db.prepare(`
  UPDATE audit_log SET case_id = @cid
  WHERE id = (SELECT id FROM audit_log WHERE guild_id = @g AND is_self = 1 AND case_id IS NULL AND type = @t AND target_id = @u
              AND ABS(created_at - @ts) <= 60000 ORDER BY ABS(created_at - @ts) LIMIT 1)`);

const createCaseTx = db.transaction((c) => {
  const caseNumber = nextNumber.get(c.guildId).n;
  const info = insertCase.run({
    guildId: c.guildId,
    caseNumber,
    type: c.type,
    userId: c.userId,
    userTag: c.userTag ?? null,
    moderatorId: c.moderatorId,
    moderatorTag: c.moderatorTag ?? null,
    reason: c.reason ?? null,
    durationMs: c.durationMs ?? null,
    createdAt: Date.now(),
  });
  const row = getById.get(info.lastInsertRowid);
  linkAuditToCase.run({ cid: row.id, g: row.guild_id, t: row.type, u: row.user_id, ts: row.created_at });
  return row;
});

function createCase(c) {
  const row = createCaseTx(c);
  bus.emit('activity', { guildId: row.guild_id, kind: 'case', id: row.id });
  return row;
}

function getCase(guildId, caseNumber) {
  return db.prepare('SELECT * FROM cases WHERE guild_id = ? AND case_number = ?').get(guildId, caseNumber);
}

function listCases(guildId, { userId, type, limit = 25, offset = 0 } = {}) {
  const where = ['guild_id = @guildId'];
  const params = { guildId, limit, offset };
  if (userId) { where.push('user_id = @userId'); params.userId = userId; }
  if (type) { where.push('type = @type'); params.type = type; }
  const clause = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE ${clause}`).get(params).n;
  const rows = db
    .prepare(`SELECT * FROM cases WHERE ${clause} ORDER BY case_number DESC LIMIT @limit OFFSET @offset`)
    .all(params);
  return { total, rows };
}

function activeWarnCount(guildId, userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM cases WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1")
    .get(guildId, userId).n;
}

function clearWarns(guildId, userId) {
  return db
    .prepare("UPDATE cases SET active = 0 WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1")
    .run(guildId, userId).changes;
}

function caseStats(guildId) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE guild_id = ?').get(guildId).n;
  const day = db
    .prepare('SELECT COUNT(*) AS n FROM cases WHERE guild_id = ? AND created_at > ?')
    .get(guildId, Date.now() - 86400000).n;
  const byType = db
    .prepare('SELECT type, COUNT(*) AS n FROM cases WHERE guild_id = ? GROUP BY type')
    .all(guildId);
  return { total, last24h: day, byType: Object.fromEntries(byType.map((r) => [r.type, r.n])) };
}

/** Cases per local day for the last `days` days. offsetMin = browser's UTC offset in minutes (e.g. +420 for UTC+7). */
function caseTimeline(guildId, days, offsetMin = 0) {
  const DAY = 86400000;
  const off = offsetMin * 60000;
  const lastIdx = Math.floor((Date.now() + off) / DAY);
  const firstIdx = lastIdx - (days - 1);
  const rows = db
    .prepare('SELECT CAST((created_at + @off) / 86400000 AS INTEGER) AS d, type, COUNT(*) AS n FROM cases WHERE guild_id = @g AND created_at >= @since GROUP BY d, type')
    .all({ off, g: guildId, since: firstIdx * DAY - off });
  const out = Array.from({ length: days }, (_, i) => ({ day: (firstIdx + i) * DAY, total: 0, counts: {} }));
  for (const r of rows) {
    const slot = out[r.d - firstIdx];
    if (!slot) continue;
    slot.counts[r.type] = r.n;
    slot.total += r.n;
  }
  return out;
}

function recentCaseFor(guildId, userId, type, withinMs) {
  return db
    .prepare('SELECT * FROM cases WHERE guild_id = ? AND user_id = ? AND type = ? AND created_at > ? LIMIT 1')
    .get(guildId, userId, type, Date.now() - withinMs);
}

// Scheduled actions (temp bans)
function schedule(guildId, userId, action, runAt) {
  db.prepare('DELETE FROM scheduled WHERE guild_id = ? AND user_id = ? AND action = ?').run(guildId, userId, action);
  db.prepare('INSERT INTO scheduled (guild_id, user_id, action, run_at) VALUES (?, ?, ?, ?)').run(guildId, userId, action, runAt);
}
function unschedule(guildId, userId, action) {
  db.prepare('DELETE FROM scheduled WHERE guild_id = ? AND user_id = ? AND action = ?').run(guildId, userId, action);
}
function dueScheduled(now = Date.now()) {
  return db.prepare('SELECT * FROM scheduled WHERE run_at <= ? ORDER BY run_at').all(now);
}
function removeScheduled(id) {
  db.prepare('DELETE FROM scheduled WHERE id = ?').run(id);
}
function rescheduleScheduled(id, runAt) {
  db.prepare('UPDATE scheduled SET run_at = ? WHERE id = ?').run(runAt, id);
}

// Scheduled channel messages ("announce" tasks). Temporary-ban unbans use schedule()/unschedule() above.
function addScheduledMessage(guildId, userId, { runAt, channelId, message, frequency }) {
  const info = db
    .prepare("INSERT INTO scheduled (guild_id, user_id, action, run_at, channel_id, message, frequency) VALUES (?, ?, 'announce', ?, ?, ?, ?)")
    .run(guildId, userId, runAt, channelId, message, frequency);
  return Number(info.lastInsertRowid);
}
function listScheduled(guildId) {
  return db.prepare('SELECT * FROM scheduled WHERE guild_id = ? ORDER BY run_at').all(guildId);
}
function deleteScheduled(guildId, id) {
  return db.prepare('DELETE FROM scheduled WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;
}

// ---------- Discord audit log + merged activity feed ----------
const insertAuditStmt = db.prepare(`
  INSERT OR IGNORE INTO audit_log (guild_id, entry_id, action_type, type, category, target_id, target_type, target_name, executor_id, executor_tag,
    executor_avatar, moderator_id, moderator_tag, source, is_self, reason, changes, extra, case_id, created_at, imported)
  VALUES (@guild_id, @entry_id, @action_type, @type, @category, @target_id, @target_type, @target_name, @executor_id, @executor_tag,
    @executor_avatar, @moderator_id, @moderator_tag, @source, @is_self, @reason, @changes, @extra, @case_id, @created_at, @imported)`);
const findCaseForAudit = db.prepare(`
  SELECT c.id FROM cases c
  WHERE c.guild_id = @g AND c.user_id = @u AND c.type = @t AND ABS(c.created_at - @ts) <= 60000
    AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.case_id = c.id)
  ORDER BY ABS(c.created_at - @ts) LIMIT 1`);

/** Store one normalized audit entry (see utils/audit.js). Duplicates are ignored. Returns { inserted, id, linked }. */
function insertAudit(guildId, a, { imported = false } = {}) {
  let caseId = null;
  if (a.is_self && CASE_TYPES.has(a.type) && a.target_id) {
    caseId = findCaseForAudit.get({ g: guildId, u: a.target_id, t: a.type, ts: a.created_at })?.id ?? null;
  }
  const n = (v) => (v === undefined ? null : v);
  const info = insertAuditStmt.run({
    guild_id: guildId, entry_id: a.entry_id, action_type: a.action_type, type: a.type, category: a.category,
    target_id: n(a.target_id), target_type: n(a.target_type), target_name: n(a.target_name),
    executor_id: n(a.executor_id), executor_tag: n(a.executor_tag), executor_avatar: n(a.executor_avatar),
    moderator_id: n(a.moderator_id), moderator_tag: n(a.moderator_tag), source: a.source, is_self: a.is_self ? 1 : 0,
    reason: n(a.reason), changes: n(a.changes), extra: n(a.extra), case_id: caseId, created_at: a.created_at, imported: imported ? 1 : 0,
  });
  return { inserted: info.changes > 0, id: info.changes ? Number(info.lastInsertRowid) : null, linked: caseId != null };
}

// One feed made of bot cases plus audit entries that are not already represented by a case.
const ACTIVITY_SQL = `
  SELECT 'case' AS kind, id AS rid, case_number, type, 'moderation' AS category,
         user_id AS target_id, user_tag AS target_name, 'user' AS target_type,
         moderator_id, moderator_tag, NULL AS avatar,
         CASE WHEN moderator_tag LIKE '% (dashboard)' THEN 'dashboard'
              WHEN moderator_tag LIKE '% (AutoMod)' THEN 'automod'
              WHEN reason = 'Temporary ban expired' THEN 'scheduled'
              ELSE 'bot' END AS source,
         reason, duration_ms, created_at
  FROM cases WHERE guild_id = @g
  UNION ALL
  SELECT 'audit', id, NULL, type, category, target_id, target_name, target_type, moderator_id, moderator_tag, executor_avatar,
         source, reason, json_extract(extra, '$.duration_ms'), created_at
  FROM audit_log WHERE guild_id = @g AND case_id IS NULL`;

function activityWhere(f) {
  const w = ['1 = 1'];
  const p = {};
  if (f.category) { w.push('category = @category'); p.category = f.category; }
  if (f.type) { w.push('type = @type'); p.type = f.type; }
  if (f.source) { w.push('source = @source'); p.source = f.source; }
  if (f.moderatorId) { w.push('moderator_id = @moderatorId'); p.moderatorId = f.moderatorId; }
  if (f.userId) { w.push('target_id = @userId'); p.userId = f.userId; }
  if (f.from) { w.push('created_at >= @from'); p.from = f.from; }
  if (f.to) { w.push('created_at <= @to'); p.to = f.to; }
  if (f.after) { w.push('created_at > @after'); p.after = f.after; }
  if (f.q) {
    w.push("(reason LIKE @q ESCAPE '\\' OR target_name LIKE @q ESCAPE '\\' OR moderator_tag LIKE @q ESCAPE '\\' OR target_id = @qraw)");
    p.q = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    p.qraw = f.q;
  }
  return { clause: w.join(' AND '), params: p };
}

function attachCases(rows) {
  const ids = rows.filter((r) => r.kind === 'case').map((r) => r.rid);
  if (!ids.length) return rows;
  const found = db.prepare(`SELECT * FROM cases WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byId = new Map(found.map((c) => [c.id, c]));
  for (const r of rows) if (r.kind === 'case') r.case = byId.get(r.rid);
  return rows;
}

function listActivity(guildId, f = {}, { limit = 25, offset = 0 } = {}) {
  const { clause, params } = activityWhere(f);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${ACTIVITY_SQL}) WHERE ${clause}`).get({ g: guildId, ...params }).n;
  const rows = db
    .prepare(`SELECT * FROM (${ACTIVITY_SQL}) WHERE ${clause} ORDER BY created_at DESC, rid DESC, kind LIMIT @limit OFFSET @offset`)
    .all({ g: guildId, ...params, limit, offset });
  return { total, rows: attachCases(rows) };
}

function getActivityRow(guildId, kind, id) {
  const row = db.prepare(`SELECT * FROM (${ACTIVITY_SQL}) WHERE kind = @kind AND rid = @rid`).get({ g: guildId, kind, rid: id });
  return row ? attachCases([row])[0] : null;
}

function getAuditEntry(guildId, id) {
  return db.prepare('SELECT * FROM audit_log WHERE guild_id = ? AND id = ?').get(guildId, id);
}

function activityModerators(guildId) {
  return db
    .prepare(`SELECT moderator_id AS id, MAX(moderator_tag) AS tag, COUNT(*) AS n FROM (
        SELECT moderator_id, moderator_tag FROM cases WHERE guild_id = @g
        UNION ALL
        SELECT moderator_id, moderator_tag FROM audit_log WHERE guild_id = @g AND case_id IS NULL)
      WHERE moderator_id IS NOT NULL GROUP BY moderator_id ORDER BY n DESC LIMIT 100`)
    .all({ g: guildId });
}

function lastAuditEntryId(guildId) {
  return db.prepare('SELECT entry_id FROM audit_log WHERE guild_id = ? ORDER BY CAST(entry_id AS INTEGER) DESC LIMIT 1').get(guildId)?.entry_id ?? null;
}

function setSyncState(guildId, error) {
  db.prepare('INSERT OR REPLACE INTO audit_sync (guild_id, last_sync_at, error) VALUES (?, ?, ?)').run(guildId, Date.now(), error ?? null);
}

function auditStatus(guildId) {
  const a = db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM audit_log WHERE guild_id = ?').get(guildId);
  const s = db.prepare('SELECT * FROM audit_sync WHERE guild_id = ?').get(guildId);
  return { entries: a.n, firstAt: a.first, lastAt: a.last, lastSyncAt: s?.last_sync_at ?? null, error: s?.error ?? null };
}

function pruneAudit(days) {
  return db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(Date.now() - days * 86400000).changes;
}

// ---------- Dashboard analytics (Feature 1) ----------
// These read the same merged feed as the Logs page (bot cases + Discord audit entries not already covered by a case),
// so actions taken in Discord's own UI are counted too. All queries are scoped by guild_id.
const MOD_TYPES = ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn'];
const MOD_IN = MOD_TYPES.map((t) => `'${t}'`).join(',');
const EVENT_TYPES = [...MOD_TYPES, 'role_create', 'role_update', 'role_delete', 'channel_create', 'channel_update', 'channel_delete', 'guild_update', 'member_prune', 'bot_add'];
const EVENT_IN = EVENT_TYPES.map((t) => `'${t}'`).join(',');

/** Moderation actions per bucket and type. size = bucket length in ms (hour/day), off = viewer's UTC offset in ms. */
function moderationBuckets(guildId, { from, until, size, off }) {
  return db.prepare(`SELECT CAST((created_at + @off) / @size AS INTEGER) AS b, type, COUNT(*) AS n
      FROM (${ACTIVITY_SQL}) WHERE type IN (${MOD_IN}) AND created_at >= @from AND created_at <= @until GROUP BY b, type`)
    .all({ g: guildId, off, size, from, until });
}

/** { ban: n, ... } for a time window (until optional). */
function moderationCounts(guildId, { from = 0, until = Date.now() + 1000 } = {}) {
  const rows = db.prepare(`SELECT type, COUNT(*) AS n FROM (${ACTIVITY_SQL}) WHERE type IN (${MOD_IN}) AND created_at >= @from AND created_at <= @until GROUP BY type`)
    .all({ g: guildId, from, until });
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

/** Per moderator and type: count, last action time, and any known avatar hash (from Discord audit entries). */
function staffBreakdown(guildId, { from = 0 } = {}) {
  return db.prepare(`SELECT moderator_id AS id, MAX(moderator_tag) AS tag, MAX(avatar) AS avatar, type, COUNT(*) AS n, MAX(created_at) AS last_at
      FROM (${ACTIVITY_SQL}) WHERE type IN (${MOD_IN}) AND moderator_id IS NOT NULL AND created_at >= @from GROUP BY moderator_id, type`)
    .all({ g: guildId, from });
}

/** Newest-first mixed feed: moderation/audit events, member joins/leaves, announcement results, dashboard config changes. */
function recentEvents(guildId, { category = '', after = 0, limit = 20 } = {}) {
  const sql = `SELECT * FROM (
      SELECT kind || ':' || rid AS key, kind AS src, type, category, target_id, target_name, target_type,
             moderator_id AS actor_id, moderator_tag AS actor_name, reason AS detail, created_at, avatar, rid AS ref, case_number
      FROM (${ACTIVITY_SQL}) WHERE type IN (${EVENT_IN})
      UNION ALL
      SELECT 'member:' || id, 'member', type, 'members', user_id, user_tag, 'user', NULL, NULL, NULL, created_at, NULL, id, NULL
      FROM member_events WHERE guild_id = @g AND type IN ('join', 'leave')
      UNION ALL
      SELECT 'announcement:' || a.id, 'announcement',
             CASE a.status WHEN 'failed' THEN 'announcement_failed' WHEN 'partial' THEN 'announcement_partial' ELSE 'announcement_sent' END,
             'announcements', CAST(a.id AS TEXT), 'Announcement #' || a.id, 'announcement', a.author_id, a.author_tag,
             (SELECT COALESCE(SUM(d.status IN ('sent','deleted')), 0) || ' of ' || COUNT(*) || ' channel(s) delivered' FROM announcement_deliveries d WHERE d.announcement_id = a.id),
             COALESCE(a.sent_at, a.created_at), NULL, a.id, NULL
      FROM announcements a WHERE a.guild_id = @g AND a.status IN ('sent', 'partial', 'failed')
      UNION ALL
      SELECT 'config:' || id, 'config', 'config_change', 'server', NULL, NULL, NULL, NULL, actor, detail, created_at, NULL, id, NULL
      FROM member_audit WHERE guild_id = @g AND kind = 'config'
    ) WHERE created_at > @after ${category ? 'AND category = @category' : ''} ORDER BY created_at DESC, key DESC LIMIT @limit`;
  const params = { g: guildId, after, limit };
  if (category) params.category = category;
  return db.prepare(sql).all(params);
}

function auditChanges(guildId, ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT id, changes FROM audit_log WHERE guild_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(guildId, ...ids);
  return new Map(rows.map((r) => [r.id, r.changes]));
}

// Dashboard sessions
function saveSession(id, data, expiresAt) {
  db.prepare('INSERT OR REPLACE INTO sessions (id, data, expires_at) VALUES (?, ?, ?)').run(id, JSON.stringify(data), expiresAt);
}
function loadSession(id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return JSON.parse(row.data);
}
function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
function purgeSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  db,
  createCase,
  getCase,
  listCases,
  activeWarnCount,
  clearWarns,
  caseStats,
  caseTimeline,
  recentCaseFor,
  schedule,
  unschedule,
  dueScheduled,
  removeScheduled,
  rescheduleScheduled,
  addScheduledMessage,
  listScheduled,
  deleteScheduled,
  insertAudit,
  listActivity,
  getActivityRow,
  getAuditEntry,
  activityModerators,
  lastAuditEntryId,
  setSyncState,
  auditStatus,
  pruneAudit,
  MOD_TYPES,
  moderationBuckets,
  moderationCounts,
  staffBreakdown,
  recentEvents,
  auditChanges,
  saveSession,
  loadSession,
  deleteSession,
  purgeSessions,
};
