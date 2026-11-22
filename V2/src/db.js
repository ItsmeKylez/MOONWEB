const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
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
`);

const insertCase = db.prepare(`
  INSERT INTO cases (guild_id, case_number, type, user_id, user_tag, moderator_id, moderator_tag, reason, duration_ms, active, created_at)
  VALUES (@guildId, @caseNumber, @type, @userId, @userTag, @moderatorId, @moderatorTag, @reason, @durationMs, 1, @createdAt)
`);
const nextNumber = db.prepare('SELECT COALESCE(MAX(case_number), 0) + 1 AS n FROM cases WHERE guild_id = ?');
const getById = db.prepare('SELECT * FROM cases WHERE id = ?');

const createCase = db.transaction((c) => {
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
  return getById.get(info.lastInsertRowid);
});

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
  return db.prepare('SELECT * FROM scheduled WHERE run_at <= ?').all(now);
}
function removeScheduled(id) {
  db.prepare('DELETE FROM scheduled WHERE id = ?').run(id);
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
  saveSession,
  loadSession,
  deleteSession,
  purgeSessions,
};
