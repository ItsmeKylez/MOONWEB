'use strict';
/* Pure helpers for Discord audit-log entries and the merged activity feed.
   No discord.js or database imports, so everything here is easy to test offline. */

const SNOWFLAKE = /^\d{17,20}$/;

const CATEGORIES = [
  { id: 'moderation', label: 'Moderation' },
  { id: 'members', label: 'Members' },
  { id: 'channels', label: 'Channels' },
  { id: 'roles', label: 'Roles' },
  { id: 'messages', label: 'Messages' },
  { id: 'server', label: 'Server' },
];

const SOURCES = [
  { id: 'discord', label: 'Discord (native)' },
  { id: 'bot', label: 'Bot command' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'automod', label: 'AutoMod' },
  { id: 'scheduled', label: 'Scheduled' },
];

/** Audit types that are also recorded as numbered cases by MOONWEB. */
const CASE_TYPES = new Set(['ban', 'unban', 'kick', 'timeout', 'untimeout']);

// Discord AuditLogEvent numbers (stable API values) -> our type key, category and label.
const EVENTS = {};
const ev = (n, type, category, label) => { EVENTS[n] = { type, category, label }; };
ev(1, 'guild_update', 'server', 'Server updated');
ev(10, 'channel_create', 'channels', 'Channel created');
ev(11, 'channel_update', 'channels', 'Channel updated');
ev(12, 'channel_delete', 'channels', 'Channel deleted');
ev(13, 'channel_overwrite_create', 'channels', 'Channel permission added');
ev(14, 'channel_overwrite_update', 'channels', 'Channel permission changed');
ev(15, 'channel_overwrite_delete', 'channels', 'Channel permission removed');
ev(20, 'kick', 'moderation', 'Kick');
ev(21, 'member_prune', 'members', 'Members pruned');
ev(22, 'ban', 'moderation', 'Ban');
ev(23, 'unban', 'moderation', 'Unban');
ev(24, 'member_update', 'members', 'Member updated');
ev(25, 'member_role_update', 'members', 'Roles changed');
ev(26, 'member_move', 'members', 'Member moved (voice)');
ev(27, 'member_disconnect', 'members', 'Member disconnected (voice)');
ev(28, 'bot_add', 'server', 'Bot added');
ev(30, 'role_create', 'roles', 'Role created');
ev(31, 'role_update', 'roles', 'Role updated');
ev(32, 'role_delete', 'roles', 'Role deleted');
ev(40, 'invite_create', 'server', 'Invite created');
ev(41, 'invite_update', 'server', 'Invite updated');
ev(42, 'invite_delete', 'server', 'Invite deleted');
ev(50, 'webhook_create', 'server', 'Webhook created');
ev(51, 'webhook_update', 'server', 'Webhook updated');
ev(52, 'webhook_delete', 'server', 'Webhook deleted');
ev(60, 'emoji_create', 'server', 'Emoji created');
ev(61, 'emoji_update', 'server', 'Emoji updated');
ev(62, 'emoji_delete', 'server', 'Emoji deleted');
ev(72, 'message_delete', 'messages', 'Message deleted');
ev(73, 'message_bulk_delete', 'messages', 'Messages bulk deleted');
ev(74, 'message_pin', 'messages', 'Message pinned');
ev(75, 'message_unpin', 'messages', 'Message unpinned');
ev(80, 'integration_create', 'server', 'Integration added');
ev(81, 'integration_update', 'server', 'Integration updated');
ev(82, 'integration_delete', 'server', 'Integration removed');
ev(83, 'stage_create', 'server', 'Stage started');
ev(84, 'stage_update', 'server', 'Stage updated');
ev(85, 'stage_delete', 'server', 'Stage ended');
ev(90, 'sticker_create', 'server', 'Sticker created');
ev(91, 'sticker_update', 'server', 'Sticker updated');
ev(92, 'sticker_delete', 'server', 'Sticker deleted');
ev(100, 'event_create', 'server', 'Event created');
ev(101, 'event_update', 'server', 'Event updated');
ev(102, 'event_delete', 'server', 'Event deleted');
ev(110, 'thread_create', 'channels', 'Thread created');
ev(111, 'thread_update', 'channels', 'Thread updated');
ev(112, 'thread_delete', 'channels', 'Thread deleted');
ev(121, 'app_command_permissions', 'server', 'Command permissions changed');
ev(140, 'automod_rule_create', 'server', 'AutoMod rule created');
ev(141, 'automod_rule_update', 'server', 'AutoMod rule updated');
ev(142, 'automod_rule_delete', 'server', 'AutoMod rule deleted');
ev(143, 'automod_block', 'moderation', 'AutoMod blocked a message');
ev(144, 'automod_flag', 'moderation', 'AutoMod flagged a message');
ev(145, 'automod_timeout', 'moderation', 'AutoMod timed out a member');

const TIMEOUT = { type: 'timeout', category: 'moderation', label: 'Timeout' };
const UNTIMEOUT = { type: 'untimeout', category: 'moderation', label: 'Timeout removed' };

/** Every event type the log can contain (used for the dashboard's filter dropdown). */
function allTypes() {
  const seen = new Map();
  for (const e of [...Object.values(EVENTS), TIMEOUT, UNTIMEOUT, { type: 'warn', category: 'moderation', label: 'Warning' }, { type: 'other', category: 'server', label: 'Other events' }]) {
    if (!seen.has(e.type)) seen.set(e.type, { key: e.type, label: e.label, category: e.category });
  }
  return [...seen.values()];
}

function classify(action, rawChanges) {
  if (action === 24 && Array.isArray(rawChanges)) {
    const c = rawChanges.find((x) => x && x.key === 'communication_disabled_until');
    if (c) return c.new ? TIMEOUT : UNTIMEOUT;
  }
  return EVENTS[action] || { type: 'other', category: 'server', label: `Audit event ${action}` };
}

const idToMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

function safeValue(v) {
  if (v === null || v === undefined) return null;
  let s;
  try { s = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return null; }
  if (s === undefined) return null;
  return s.length > 400 ? `${s.slice(0, 400)}…` : JSON.parse(s);
}

/** Keeps before/after values small and drops anything that looks like a credential. */
function cleanChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return null;
  const out = [];
  for (const c of changes.slice(0, 25)) {
    if (!c || typeof c.key !== 'string' || /token|secret|password/i.test(c.key)) continue;
    out.push({ key: c.key, old: safeValue(c.old), new: safeValue(c.new) });
  }
  return out.length ? out : null;
}

/** Bot-executed actions carry "[moderator] reason" as their audit reason (see utils/mod.js). */
function resolveActor({ executorId, executorTag, botId, reason }) {
  const isSelf = !!executorId && executorId === botId;
  if (!isSelf) return { isSelf: false, source: 'discord', moderatorId: executorId || null, moderatorTag: executorTag || null, reason: reason || null };
  const m = /^\[(.+?)\]\s?([\s\S]*)$/.exec(reason || '');
  if (!m) return { isSelf: true, source: 'bot', moderatorId: botId, moderatorTag: executorTag || null, reason: reason || null };
  const tag = m[1];
  const source = /\(dashboard\)$/.test(tag) ? 'dashboard' : /\(AutoMod\)$/.test(tag) ? 'automod' : 'bot';
  return { isSelf: true, source, moderatorId: source === 'automod' ? botId : null, moderatorTag: tag, reason: m[2] || null };
}

/**
 * Turn a discord.js GuildAuditLogsEntry into a flat row for the audit_log table.
 * opts: { botId, executor?, target? } - executor/target are User objects resolved by the caller when the entry has none.
 */
function normalizeEntry(entry, { botId, executor = null, target = null } = {}) {
  const exec = executor ?? entry.executor ?? null;
  const tgt = target ?? entry.target ?? null;
  const executorId = entry.executorId ?? exec?.id ?? null;
  const executorTag = exec?.username ?? exec?.tag ?? null;
  const createdAt = Number(entry.createdTimestamp) || idToMs(entry.id);
  const kind = classify(entry.action, entry.changes);

  const actor = resolveActor({ executorId, executorTag, botId, reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 500) : null });

  const extra = {};
  const ex = entry.extra;
  if (ex && typeof ex === 'object') {
    if (ex.count != null && Number.isFinite(Number(ex.count))) extra.count = Number(ex.count);
    if (ex.channel?.id) extra.channel_id = String(ex.channel.id);
    if (ex.membersRemoved != null) extra.removed = Number(ex.membersRemoved);
    if (ex.deleteMemberDays != null) extra.days = Number(ex.deleteMemberDays);
  }
  if (kind.type === 'timeout') {
    const c = (entry.changes || []).find((x) => x && x.key === 'communication_disabled_until');
    const until = Date.parse(c?.new);
    if (Number.isFinite(until)) {
      extra.until = until;
      const d = Math.max(0, until - createdAt);
      extra.duration_ms = d >= 60000 ? Math.round(d / 60000) * 60000 : d;
    }
  }

  const targetId = entry.targetId ?? tgt?.id ?? null;
  const targetName = tgt?.username ?? tgt?.user?.username ?? tgt?.name ?? null;

  return {
    entry_id: String(entry.id),
    action_type: Number(entry.action),
    type: kind.type,
    category: kind.category,
    target_id: targetId ? String(targetId) : null,
    target_type: entry.targetType ? String(entry.targetType).toLowerCase() : null,
    target_name: targetName ? String(targetName).slice(0, 100) : null,
    executor_id: executorId ? String(executorId) : null,
    executor_tag: executorTag ? String(executorTag).slice(0, 100) : null,
    executor_avatar: actor.source === 'discord' ? exec?.avatar ?? null : null,
    moderator_id: actor.moderatorId,
    moderator_tag: actor.moderatorTag ? String(actor.moderatorTag).slice(0, 100) : null,
    source: actor.source,
    is_self: actor.isSelf ? 1 : 0,
    reason: actor.reason,
    changes: (() => { const c = cleanChanges(entry.changes); return c ? JSON.stringify(c) : null; })(),
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    created_at: createdAt,
  };
}

/** Validate untrusted query-string filters for GET /activity. */
function parseFilters(q = {}) {
  const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const snow = (v) => (typeof v === 'string' && SNOWFLAKE.test(v) ? v : '');
  return {
    page: Math.min(10000, Math.max(1, int(q.page) || 1)),
    category: CATEGORIES.some((c) => c.id === q.category) ? q.category : '',
    type: typeof q.type === 'string' && /^[a-z0-9_]{1,40}$/.test(q.type) ? q.type : '',
    source: SOURCES.some((s) => s.id === q.source) ? q.source : '',
    moderatorId: snow(q.moderator),
    userId: snow(q.user),
    from: int(q.from),
    to: int(q.to),
    after: int(q.after),
    q: typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '',
  };
}

/** Shape one merged-feed row for the API. */
function shapeRow(r) {
  return {
    key: `${r.kind}:${r.rid}`, kind: r.kind, id: r.rid, case_number: r.case_number ?? null,
    type: r.type, category: r.category,
    target_id: r.target_id, target_name: r.target_name, target_type: r.target_type,
    moderator_id: r.moderator_id, moderator_tag: r.moderator_tag, avatar: r.avatar ?? null,
    source: r.source, reason: r.reason, duration_ms: r.duration_ms ?? null, created_at: r.created_at,
    case: r.case,
  };
}

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** Full detail of one stored audit entry. */
function shapeAuditDetail(e) {
  return {
    id: e.id, entry_id: e.entry_id, action_type: e.action_type, type: e.type, category: e.category,
    target_id: e.target_id, target_type: e.target_type, target_name: e.target_name,
    executor_id: e.executor_id, executor_tag: e.executor_tag,
    moderator_id: e.moderator_id, moderator_tag: e.moderator_tag, source: e.source,
    reason: e.reason, changes: parseJson(e.changes) || [], extra: parseJson(e.extra) || {},
    created_at: e.created_at, imported: !!e.imported,
  };
}

module.exports = { CATEGORIES, SOURCES, CASE_TYPES, EVENTS, allTypes, classify, idToMs, cleanChanges, resolveActor, normalizeEntry, parseFilters, shapeRow, shapeAuditDetail };
