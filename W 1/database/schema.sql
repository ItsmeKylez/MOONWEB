-- ===========================================================================
--  ESQUEMA COMPLETO DE LA BASE DE DATOS LOCAL (SQLite)
--  Se ejecuta entero en cada arranque: todo es CREATE ... IF NOT EXISTS, asi
--  que es seguro y sirve tambien como "migracion" para instalaciones viejas.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- --- Configuracion general por servidor ------------------------------------
CREATE TABLE IF NOT EXISTS guild_config (
    guild_id        INTEGER PRIMARY KEY,
    staff_role      INTEGER,
    admin_role      INTEGER,
    quarantine_role INTEGER,
    verified_role   INTEGER,
    autorole        INTEGER,
    embed_color     INTEGER DEFAULT 5793266,
    case_counter    INTEGER DEFAULT 0,
    ticket_counter  INTEGER DEFAULT 0,
    dm_on_punish    INTEGER DEFAULT 1,
    created_at      INTEGER DEFAULT 0
);

-- Un canal de log por categoria (ver LOG_CATEGORIES en config.py)
CREATE TABLE IF NOT EXISTS log_channels (
    guild_id   INTEGER NOT NULL,
    category   TEXT    NOT NULL,
    channel_id INTEGER NOT NULL,
    PRIMARY KEY (guild_id, category)
);

-- Canales / roles / usuarios que los modulos deben ignorar
CREATE TABLE IF NOT EXISTS ignored (
    guild_id  INTEGER NOT NULL,
    kind      TEXT    NOT NULL,   -- 'channel' | 'role' | 'user'
    target_id INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, target_id)
);

-- --- TICKETS ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_panels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    title       TEXT    DEFAULT 'Soporte',
    description TEXT    DEFAULT 'Pulsa el boton para abrir un ticket.',
    color       INTEGER DEFAULT 10181046,
    image       TEXT,
    thumbnail   TEXT,
    footer      TEXT,
    style       TEXT    DEFAULT 'buttons',   -- 'buttons' | 'select'
    channel_id  INTEGER,
    message_id  INTEGER
);

CREATE TABLE IF NOT EXISTS ticket_categories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id     INTEGER NOT NULL,
    guild_id     INTEGER NOT NULL,
    label        TEXT    NOT NULL,
    emoji        TEXT,
    description  TEXT,
    category_id  INTEGER,          -- categoria de Discord donde se crea el canal
    staff_role   INTEGER,
    open_message TEXT,
    use_threads  INTEGER DEFAULT 0,
    position     INTEGER DEFAULT 0,
    FOREIGN KEY (panel_id) REFERENCES ticket_panels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    label       TEXT    NOT NULL,
    placeholder TEXT,
    style       TEXT    DEFAULT 'short',   -- 'short' | 'long'
    required    INTEGER DEFAULT 1,
    position    INTEGER DEFAULT 0,
    FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tickets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      INTEGER NOT NULL,
    number        INTEGER NOT NULL,
    channel_id    INTEGER,
    user_id       INTEGER NOT NULL,
    category_id   INTEGER,
    category_name TEXT,
    claimed_by    INTEGER,
    priority      TEXT    DEFAULT 'media',
    status        TEXT    DEFAULT 'open',   -- 'open' | 'closed' | 'deleted'
    opened_at     INTEGER DEFAULT 0,
    closed_at     INTEGER,
    closed_by     INTEGER,
    close_reason  TEXT,
    last_activity INTEGER DEFAULT 0,
    first_reply   INTEGER,
    rating        INTEGER,
    feedback      TEXT
);

CREATE TABLE IF NOT EXISTS ticket_blacklist (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    reason   TEXT,
    added_by INTEGER,
    PRIMARY KEY (guild_id, user_id)
);

-- Ajustes globales del sistema de tickets, por servidor
CREATE TABLE IF NOT EXISTS ticket_config (
    guild_id        INTEGER PRIMARY KEY,
    max_open        INTEGER DEFAULT 2,
    transcript_dm   INTEGER DEFAULT 1,
    ask_rating      INTEGER DEFAULT 1,
    autoclose_hours INTEGER DEFAULT 0,     -- 0 = desactivado
    archive_category INTEGER
);

-- --- MODERACION ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    number       INTEGER NOT NULL,
    action       TEXT    NOT NULL,
    user_id      INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    reason       TEXT,
    duration     INTEGER,
    created_at   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS warns (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    reason       TEXT,
    created_at   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    author_id  INTEGER NOT NULL,
    content    TEXT,
    created_at INTEGER DEFAULT 0
);

-- Sanciones temporales pendientes de expirar (sobreviven a un reinicio)
CREATE TABLE IF NOT EXISTS temp_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    action     TEXT    NOT NULL,   -- 'ban' | 'quarantine'
    expires_at INTEGER NOT NULL
);

-- --- SEGURIDAD -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS antinuke_config (
    guild_id              INTEGER PRIMARY KEY,
    enabled               INTEGER DEFAULT 0,
    punishment            TEXT    DEFAULT 'strip',  -- 'strip' | 'kick' | 'ban'
    window                INTEGER DEFAULT 60,
    alert_owner           INTEGER DEFAULT 1,
    restore               INTEGER DEFAULT 1,
    lim_channel_delete    INTEGER DEFAULT 3,
    lim_channel_create    INTEGER DEFAULT 5,
    lim_role_delete       INTEGER DEFAULT 3,
    lim_role_create       INTEGER DEFAULT 5,
    lim_ban               INTEGER DEFAULT 3,
    lim_kick              INTEGER DEFAULT 5,
    lim_webhook           INTEGER DEFAULT 2,
    lim_emoji_delete      INTEGER DEFAULT 5,
    lim_perm_update       INTEGER DEFAULT 4,
    block_dangerous_roles INTEGER DEFAULT 1,
    block_bots            INTEGER DEFAULT 1,
    block_guild_update    INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS antiraid_config (
    guild_id         INTEGER PRIMARY KEY,
    enabled          INTEGER DEFAULT 0,
    join_count       INTEGER DEFAULT 8,
    join_window      INTEGER DEFAULT 10,
    min_age_days     INTEGER DEFAULT 7,
    age_action       TEXT    DEFAULT 'kick',       -- none|quarantine|kick|ban
    no_avatar_action TEXT    DEFAULT 'none',
    raid_action      TEXT    DEFAULT 'quarantine',
    lockdown         INTEGER DEFAULT 1,
    lockdown_minutes INTEGER DEFAULT 10,
    alert_role       INTEGER,
    panic            INTEGER DEFAULT 0,
    name_regex       TEXT
);

CREATE TABLE IF NOT EXISTS antispam_config (
    guild_id       INTEGER PRIMARY KEY,
    enabled        INTEGER DEFAULT 0,
    msg_rate       INTEGER DEFAULT 6,
    msg_window     INTEGER DEFAULT 5,
    dup_limit      INTEGER DEFAULT 4,
    mention_limit  INTEGER DEFAULT 6,
    caps_percent   INTEGER DEFAULT 75,
    caps_min_len   INTEGER DEFAULT 12,
    emoji_limit    INTEGER DEFAULT 10,
    newline_limit  INTEGER DEFAULT 15,
    attach_limit   INTEGER DEFAULT 5,
    block_invites  INTEGER DEFAULT 1,
    block_links    INTEGER DEFAULT 0,
    block_everyone INTEGER DEFAULT 1,
    block_zalgo    INTEGER DEFAULT 1,
    delete_message INTEGER DEFAULT 1,
    warn_at        INTEGER DEFAULT 3,
    mute_at        INTEGER DEFAULT 6,
    kick_at        INTEGER DEFAULT 12,
    ban_at         INTEGER DEFAULT 20,
    mute_minutes   INTEGER DEFAULT 10,
    decay          INTEGER DEFAULT 60
);

-- Usuarios y bots inmunes al anti-nuke / anti-raid
CREATE TABLE IF NOT EXISTS whitelist (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    added_by INTEGER,
    PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS filtered_words (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL,
    word     TEXT    NOT NULL,
    is_regex INTEGER DEFAULT 0
);

-- --- BIENVENIDA / VERIFICACION --------------------------------------------
CREATE TABLE IF NOT EXISTS welcome_config (
    guild_id         INTEGER PRIMARY KEY,
    welcome_enabled  INTEGER DEFAULT 0,
    welcome_channel  INTEGER,
    welcome_message  TEXT DEFAULT 'Bienvenido {mention} a **{server}**. Ahora somos {count} miembros.',
    welcome_image    INTEGER DEFAULT 1,
    goodbye_enabled  INTEGER DEFAULT 0,
    goodbye_channel  INTEGER,
    goodbye_message  TEXT DEFAULT '{user} ha salido del servidor.',
    dm_enabled       INTEGER DEFAULT 0,
    dm_message       TEXT
);

CREATE TABLE IF NOT EXISTS verification_panels (
    guild_id   INTEGER PRIMARY KEY,
    channel_id INTEGER,
    message_id INTEGER,
    role_id    INTEGER,
    captcha    INTEGER DEFAULT 1
);

-- --- EXTRAS ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   INTEGER NOT NULL,
    name       TEXT,
    data       TEXT NOT NULL,     -- JSON con roles, categorias y canales
    created_at INTEGER DEFAULT 0,
    created_by INTEGER
);

CREATE TABLE IF NOT EXISTS levels (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    xp       INTEGER DEFAULT 0,
    level    INTEGER DEFAULT 0,
    last_msg INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS level_config (
    guild_id      INTEGER PRIMARY KEY,
    enabled       INTEGER DEFAULT 0,
    announce      INTEGER DEFAULT 1,
    channel_id    INTEGER,
    xp_min        INTEGER DEFAULT 15,
    xp_max        INTEGER DEFAULT 25
);

CREATE TABLE IF NOT EXISTS level_rewards (
    guild_id INTEGER NOT NULL,
    level    INTEGER NOT NULL,
    role_id  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, level)
);

CREATE TABLE IF NOT EXISTS role_menus (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    channel_id  INTEGER,
    message_id  INTEGER,
    title       TEXT,
    description TEXT,
    max_roles   INTEGER DEFAULT 0    -- 0 = sin limite
);

CREATE TABLE IF NOT EXISTS role_menu_options (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id     INTEGER NOT NULL,
    role_id     INTEGER NOT NULL,
    label       TEXT,
    emoji       TEXT,
    description TEXT,
    FOREIGN KEY (menu_id) REFERENCES role_menus(id) ON DELETE CASCADE
);

-- --- Indices ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cases_guild_user   ON cases(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_cases_number       ON cases(guild_id, number);
CREATE INDEX IF NOT EXISTS idx_warns_guild_user   ON warns(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notes_guild_user   ON notes(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_temp_expires       ON temp_actions(expires_at);
CREATE INDEX IF NOT EXISTS idx_tickets_channel    ON tickets(channel_id);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets(guild_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tcat_panel         ON ticket_categories(panel_id);
CREATE INDEX IF NOT EXISTS idx_tq_category        ON ticket_questions(category_id);
CREATE INDEX IF NOT EXISTS idx_panels_guild       ON ticket_panels(guild_id);
CREATE INDEX IF NOT EXISTS idx_words_guild        ON filtered_words(guild_id);
CREATE INDEX IF NOT EXISTS idx_backups_guild      ON backups(guild_id);
CREATE INDEX IF NOT EXISTS idx_levels_guild_xp    ON levels(guild_id, xp);
CREATE INDEX IF NOT EXISTS idx_rmo_menu           ON role_menu_options(menu_id);
