const { db } = require('./db');
const fmt = require('./utils/welcomefmt');

const DEFAULTS = {
  logChannelId: null,
  autoRoleId: null,
  welcome: fmt.DEFAULT_WELCOME,
  goodbye: fmt.DEFAULT_GOODBYE,
  joinAutomation: fmt.DEFAULT_JOIN_AUTOMATION,
        botPresence: {
            enabled: false,
            activityType: 'PLAYING',
            activityName: '',
            status: 'online'
        },
  automod: {
    enabled: false,
    exemptRoleIds: [],
    exemptChannelIds: [],
    spam: { enabled: true, maxMessages: 5, seconds: 6 },
    invites: { enabled: true },
    links: { enabled: false, allowlist: [] },
    badWords: { enabled: false, words: [] },
    mentions: { enabled: true, max: 5 },
    caps: { enabled: false, minLength: 15, percent: 70 },
    raid: { enabled: false, joins: 8, seconds: 10, action: 'alert' },
    strikes: { warnings: 3, action: 'timeout', durationMin: 60 },
  },
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = {};
  for (const key of Object.keys(base)) {
    out[key] = deepMerge(base[key], extra && typeof extra === 'object' ? extra[key] : undefined);
  }
  return out;
}

const getStmt = db.prepare('SELECT data FROM settings WHERE guild_id = ?');
const putStmt = db.prepare('INSERT OR REPLACE INTO settings (guild_id, data) VALUES (?, ?)');

function getSettings(guildId) {
  const row = getStmt.get(guildId);
  let stored = {};
  if (row) {
    try { stored = JSON.parse(row.data); } catch { stored = {}; }
  }
  return deepMerge(clone(DEFAULTS), stored);
}

function saveSettings(guildId, settings) {
  putStmt.run(guildId, JSON.stringify(settings));
  return settings;
}

// ---- Validation of untrusted input (dashboard) ----
const SNOWFLAKE = /^\d{17,20}$/;
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const int = (v, d, min, max) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : d;
};
const snow = (v, d) => (v === null || v === '' ? null : typeof v === 'string' && SNOWFLAKE.test(v) ? v : d);
const snowList = (v, d, max = 50) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && SNOWFLAKE.test(x)))].slice(0, max) : d;
const strList = (v, d, max = 300, len = 64) =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter((x) => x && x.length <= len))].slice(0, max)
    : d;
const str = (v, d, len) => (typeof v === 'string' ? v.slice(0, len) : d);
const oneOf = (v, d, list) => (list.includes(v) ? v : d);

function sanitizeSettings(input, current) {
  const i = input && typeof input === 'object' ? input : {};
  const c = current;
  const a = i.automod || {};
  const rule = (name) => a[name] || {};
  return {
    logChannelId: snow(i.logChannelId, c.logChannelId),
    autoRoleId: snow(i.autoRoleId, c.autoRoleId),
    welcome: fmt.sanitizeWelcome(i.welcome, c.welcome),
    goodbye: fmt.sanitizeGoodbye(i.goodbye, c.goodbye),
    joinAutomation: fmt.sanitizeJoinAutomation(i.joinAutomation, c.joinAutomation),
    botPresence: {
      enabled: bool(i.botPresence?.enabled, c.botPresence.enabled),
      activityType: oneOf(i.botPresence?.activityType, c.botPresence.activityType, ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'CUSTOM']),
      activityName: str(i.botPresence?.activityName, c.botPresence.activityName, 128),
      status: oneOf(i.botPresence?.status, c.botPresence.status, ['online', 'idle', 'dnd', 'invisible']),
    },
    automod: {
      enabled: bool(a.enabled, c.automod.enabled),
      exemptRoleIds: snowList(a.exemptRoleIds, c.automod.exemptRoleIds),
      exemptChannelIds: snowList(a.exemptChannelIds, c.automod.exemptChannelIds),
      spam: {
        enabled: bool(rule('spam').enabled, c.automod.spam.enabled),
        maxMessages: int(rule('spam').maxMessages, c.automod.spam.maxMessages, 2, 30),
        seconds: int(rule('spam').seconds, c.automod.spam.seconds, 2, 60),
      },
      invites: { enabled: bool(rule('invites').enabled, c.automod.invites.enabled) },
      links: {
        enabled: bool(rule('links').enabled, c.automod.links.enabled),
        allowlist: strList(rule('links').allowlist, c.automod.links.allowlist),
      },
      badWords: {
        enabled: bool(rule('badWords').enabled, c.automod.badWords.enabled),
        words: strList(rule('badWords').words, c.automod.badWords.words, 500, 40),
      },
      mentions: {
        enabled: bool(rule('mentions').enabled, c.automod.mentions.enabled),
        max: int(rule('mentions').max, c.automod.mentions.max, 2, 50),
      },
      caps: {
        enabled: bool(rule('caps').enabled, c.automod.caps.enabled),
        minLength: int(rule('caps').minLength, c.automod.caps.minLength, 8, 200),
        percent: int(rule('caps').percent, c.automod.caps.percent, 40, 100),
      },
      raid: {
        enabled: bool(rule('raid').enabled, c.automod.raid.enabled),
        joins: int(rule('raid').joins, c.automod.raid.joins, 3, 100),
        seconds: int(rule('raid').seconds, c.automod.raid.seconds, 3, 120),
        action: oneOf(rule('raid').action, c.automod.raid.action, ['alert', 'kick', 'timeout']),
      },
      strikes: {
        warnings: int(rule('strikes').warnings, c.automod.strikes.warnings, 1, 20),
        action: oneOf(rule('strikes').action, c.automod.strikes.action, ['timeout', 'kick', 'ban']),
        durationMin: int(rule('strikes').durationMin, c.automod.strikes.durationMin, 1, 40320),
      },
    },
  };
}

module.exports = { DEFAULTS, getSettings, saveSettings, sanitizeSettings };
