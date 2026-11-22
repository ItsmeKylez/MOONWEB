
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

CREATE INDEX IF NOT EXISTS idx_cases_user
ON cases (guild_id, user_id);

CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  channel_id TEXT,
  message TEXT,
  frequency TEXT,
  next_run INTEGER,
  duration_ms INTEGER,
  reason TEXT,
  title TEXT,
  days INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scheduled_run
ON scheduled (run_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_next
ON scheduled (next_run);

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

CREATE INDEX IF NOT EXISTS idx_audit_time
ON audit_log (guild_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_target
ON audit_log (guild_id, target_id);

CREATE INDEX IF NOT EXISTS idx_audit_mod
ON audit_log (guild_id, moderator_id);

CREATE TABLE IF NOT EXISTS audit_sync (
  guild_id TEXT PRIMARY KEY,
  last_sync_at INTEGER,
  error TEXT
);
