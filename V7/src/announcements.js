'use strict';
/* Stage 5 — announcements: storage (templates, drafts, history, per-channel deliveries) and the send/edit/delete/retry/schedule logic.
   Everything is scoped by guild_id. Tables are created here with IF NOT EXISTS, so existing databases migrate on startup. */

const { db } = require('./db');
const A = require('./utils/announce');
const { AnnounceError, sanitizePayload, buildMessage, neededPermissions, BUILTIN_TEMPLATES, LIMITS, CATEGORIES } = A;

db.exec(`
CREATE TABLE IF NOT EXISTS announcement_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Custom',
  payload TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_tpl_guild ON announcement_templates (guild_id);
CREATE TABLE IF NOT EXISTS announcement_drafts (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, author_id TEXT NOT NULL, author_tag TEXT,
  payload TEXT NOT NULL, status TEXT NOT NULL, scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ann_guild ON announcements (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ann_due ON announcements (status, scheduled_at);
CREATE TABLE IF NOT EXISTS announcement_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, announcement_id INTEGER NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, channel_name TEXT,
  message_id TEXT, status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_del ON announcement_deliveries (announcement_id);
`);

const now = () => Date.now();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT_CHANNEL_TYPES = [0, 5]; // GuildText, GuildAnnouncement
const MAX_SCHEDULE_MS = 365 * 86400000;

function log(guild, text) {
  try {
    const m = require('./utils/modlog');
    return Promise.resolve(m.sendLog(guild, m.infoEmbed('Announcement', text))).catch(() => {});
  } catch { return Promise.resolve(); }
}

// ---------- templates ----------
function templateRow(r) { return { id: String(r.id), name: r.name, category: r.category, payload: parse(r.payload), builtin: false, updatedAt: r.updated_at }; }
function cleanTemplateMeta(name, category) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new AnnounceError('Give the template a name.');
  if (n.length > LIMITS.templateName) throw new AnnounceError(`Template names can be at most ${LIMITS.templateName} characters.`);
  return { name: n, category: CATEGORIES.includes(category) ? category : 'Custom' };
}
function listTemplates(g) {
  const saved = db.prepare('SELECT * FROM announcement_templates WHERE guild_id = ? ORDER BY updated_at DESC').all(g).map(templateRow);
  return [...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })), ...saved];
}
function getTemplate(g, id) {
  if (String(id).startsWith('builtin:')) { const t = BUILTIN_TEMPLATES.find((x) => x.id === id); return t ? { ...t, builtin: true } : null; }
  const r = /^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM announcement_templates WHERE guild_id = ? AND id = ?').get(g, Number(id)) : null;
  return r ? templateRow(r) : null;
}
function createTemplate(g, { name, category, payload, userId }) {
  const meta = cleanTemplateMeta(name, category);
  const clean = sanitizePayload(payload);
  if (db.prepare('SELECT COUNT(*) AS n FROM announcement_templates WHERE guild_id = ?').get(g).n >= 100) throw new AnnounceError('You can save at most 100 templates.');
  const t = now();
  const info = db.prepare('INSERT INTO announcement_templates (guild_id, name, category, payload, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(g, meta.name, meta.category, JSON.stringify(clean), userId ?? null, t, t);
  return getTemplate(g, Number(info.lastInsertRowid));
}
function updateTemplate(g, id, { name, category, payload }) {
  const cur = getTemplate(g, id);
  if (!cur || cur.builtin) throw new AnnounceError('Template not found.');
  const meta = cleanTemplateMeta(name ?? cur.name, category ?? cur.category);
  const clean = payload === undefined ? cur.payload : sanitizePayload(payload);
  db.prepare('UPDATE announcement_templates SET name = ?, category = ?, payload = ?, updated_at = ? WHERE guild_id = ? AND id = ?').run(meta.name, meta.category, JSON.stringify(clean), now(), g, Number(id));
  return getTemplate(g, id);
}
function duplicateTemplate(g, id, userId) {
  const cur = getTemplate(g, id);
  if (!cur) throw new AnnounceError('Template not found.');
  return createTemplate(g, { name: `${cur.name} (copy)`.slice(0, LIMITS.templateName), category: cur.category, payload: cur.payload, userId });
}
function deleteTemplate(g, id) {
  if (!/^\d+$/.test(String(id))) throw new AnnounceError('Built-in templates can’t be deleted.');
  return db.prepare('DELETE FROM announcement_templates WHERE guild_id = ? AND id = ?').run(g, Number(id)).changes > 0;
}

// ---------- drafts (autosave; stored as typed, validated when sent) ----------
function getDraft(g, userId) {
  const r = db.prepare('SELECT payload, updated_at FROM announcement_drafts WHERE guild_id = ? AND user_id = ?').get(g, userId);
  return r ? { draft: parse(r.payload), updatedAt: r.updated_at } : { draft: null };
}
function saveDraft(g, userId, draft) {
  if (!draft || typeof draft !== 'object') throw new AnnounceError('Invalid draft.');
  const text = JSON.stringify(draft);
  if (text.length > 150000) throw new AnnounceError('Draft is too large.');
  db.prepare('INSERT OR REPLACE INTO announcement_drafts (guild_id, user_id, payload, updated_at) VALUES (?,?,?,?)').run(g, userId, text, now());
}
function clearDraft(g, userId) { db.prepare('DELETE FROM announcement_drafts WHERE guild_id = ? AND user_id = ?').run(g, userId); }

// ---------- history ----------
const delRows = (id) => db.prepare('SELECT * FROM announcement_deliveries WHERE announcement_id = ? ORDER BY id').all(id);
function shape(a, withDeliveries = true) {
  const payload = parse(a.payload);
  const dels = withDeliveries ? delRows(a.id) : [];
  const first = payload?.embeds?.[0];
  return {
    id: a.id, status: a.status, authorId: a.author_id, authorTag: a.author_tag, scheduledAt: a.scheduled_at, createdAt: a.created_at, sentAt: a.sent_at, editedAt: a.edited_at,
    summary: (first?.title || payload?.content || first?.description || '(no text)').slice(0, 120), payload,
    deliveries: dels.map((d) => ({
      id: d.id, channelId: d.channel_id, channelName: d.channel_name, status: d.status, error: d.error, attempts: d.attempts,
      link: d.message_id ? `https://discord.com/channels/${a.guild_id}/${d.channel_id}/${d.message_id}` : null,
    })),
  };
}
const STATUSES = ['scheduled', 'sending', 'sent', 'partial', 'failed', 'cancelled', 'deleted'];
function getAnnouncement(g, id) {
  const a = /^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM announcements WHERE guild_id = ? AND id = ?').get(g, Number(id)) : null;
  return a ? shape(a) : null;
}
function listAnnouncements(g, { page = 1, status, limit = 15 } = {}) {
  const where = ['guild_id = @g']; const p = { g, limit, offset: (Math.max(1, page) - 1) * limit };
  if (STATUSES.includes(status)) { where.push('status = @status'); p.status = status; }
  const clause = where.join(' AND ');
  const { limit: _l, offset: _o, ...cp } = p;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM announcements WHERE ${clause}`).get(cp).n;
  const rows = db.prepare(`SELECT * FROM announcements WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`).all(p).map((a) => shape(a));
  return { total, page, pages: Math.max(1, Math.ceil(total / limit)), rows };
}
function announcementStats(g) {
  const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM announcements WHERE guild_id = ? GROUP BY status').all(g).map((r) => [r.status, r.n]));
  const d = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM announcement_deliveries WHERE guild_id = ? GROUP BY status').all(g).map((r) => [r.status, r.n]));
  const sent = (d.sent ?? 0) + (d.deleted ?? 0); const failed = d.failed ?? 0;
  return { announcements: by, total: Object.values(by).reduce((a, b) => a + b, 0), deliveries: { sent, failed, pending: d.pending ?? 0 }, successRate: sent + failed ? Math.round((sent / (sent + failed)) * 100) : null };
}

// ---------- validation against the live guild ----------
const has = (perms, need) => !!perms && need.every((p) => perms.has(p));
const PERM_LABEL = { ViewChannel: 'View Channel', SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', MentionEveryone: 'Mention Everyone' };
const missing = (perms, need) => need.filter((p) => !perms?.has(p)).map((p) => PERM_LABEL[p] || p).join(', ');

function resolveChannels(guild, member, channelIds, payload) {
  if (!Array.isArray(channelIds) || !channelIds.length) throw new AnnounceError('Choose at least one channel.');
  const ids = [...new Set(channelIds.map(String))];
  if (ids.length > LIMITS.channels) throw new AnnounceError(`Choose at most ${LIMITS.channels} channels at a time.`);
  const need = neededPermissions(payload);
  return ids.map((id) => {
    const ch = A.SNOWFLAKE.test(id) ? guild.channels.cache.get(id) : null;
    if (!ch || !TEXT_CHANNEL_TYPES.includes(ch.type)) throw new AnnounceError('One of the selected channels doesn’t exist or isn’t a text channel.');
    const bot = ch.permissionsFor(guild.members.me);
    if (!has(bot, need)) throw new AnnounceError(`The bot is missing ${missing(bot, need)} in #${ch.name}.`);
    const user = ch.permissionsFor(member);
    if (!has(user, need)) throw new AnnounceError(`You don’t have ${missing(user, need)} in #${ch.name}, so the bot won’t post there for you.`);
    if (payload.mentions.everyone && !user?.has('MentionEveryone')) throw new AnnounceError(`You need the Mention Everyone permission in #${ch.name} to allow @everyone/@here.`);
    return ch;
  });
}
function checkRoles(guild, payload) {
  for (const m of payload.content.matchAll(/<@&(\d{17,20})>/g)) if (!guild.roles.cache.has(m[1])) throw new AnnounceError('Your message mentions a role that doesn’t exist in this server.');
}
function requireReady(client) { if (!client.isReady()) throw new AnnounceError('The bot is not connected to Discord right now. Try again in a moment.'); }

/** Validate everything without sending. Returns the clean payload and the channel names. */
function preview(guild, member, input, channelIds) {
  const payload = sanitizePayload(input);
  checkRoles(guild, payload);
  const channels = channelIds?.length ? resolveChannels(guild, member, channelIds, payload) : [];
  return { payload, channels: channels.map((c) => ({ id: c.id, name: c.name })) };
}

// ---------- sending ----------
function discordError(err) {
  const code = err?.code;
  if (code === 50013 || code === 50001) return 'Discord refused: the bot lacks permission in that channel.';
  if (code === 10003) return 'That channel no longer exists.';
  if (code === 10008) return 'The message no longer exists.';
  if (code === 50035) return 'Discord rejected the message content.';
  return String(err?.message || 'Unknown error').slice(0, 300);
}

function setDelivery(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE announcement_deliveries SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @t WHERE id = @id`).run({ ...fields, id, t: now() });
}

function finalize(id) {
  const d = delRows(id);
  const sent = d.filter((x) => x.status === 'sent').length;
  const failed = d.filter((x) => x.status === 'failed').length;
  const status = sent && failed ? 'partial' : sent ? 'sent' : failed ? 'failed' : 'cancelled';
  db.prepare('UPDATE announcements SET status = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?').run(status, sent ? now() : null, id);
  return status;
}

/** Send every pending delivery of an announcement. Safe to call twice: only one caller can claim it. */
async function run(client, id, { gapMs = 400 } = {}) {
  const claimed = db.prepare("UPDATE announcements SET status = 'sending' WHERE id = ? AND status = 'scheduled'").run(id).changes;
  if (!claimed) return null;
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  const payload = parse(a.payload);
  const guild = client.guilds.cache.get(a.guild_id);
  const pending = delRows(id).filter((d) => d.status === 'pending');
  let author = null; let authorErr = null;
  if (!guild) authorErr = 'The bot is no longer in this server.';
  else {
    author = await guild.members.fetch(a.author_id).catch(() => null);
    if (!author || !author.permissions.has('ManageGuild')) authorErr = 'The person who created this announcement no longer has Manage Server.';
  }
  const need = payload ? neededPermissions(payload) : [];
  for (let i = 0; i < pending.length; i++) {
    const d = pending[i];
    try {
      if (authorErr) throw new Error(authorErr);
      const ch = guild.channels.cache.get(d.channel_id);
      if (!ch) throw new Error('That channel no longer exists.');
      const bot = ch.permissionsFor(guild.members.me);
      if (!has(bot, need)) throw new Error(`The bot is missing ${missing(bot, need)} in #${ch.name}.`);
      const user = ch.permissionsFor(author);
      if (!has(user, need)) throw new Error(`The author no longer has ${missing(user, need)} in #${ch.name}.`);
      if (payload.mentions.everyone && !user.has('MentionEveryone')) throw new Error('The author can’t mention @everyone there.');
      const msg = await ch.send(buildMessage(payload));
      setDelivery(d.id, { status: 'sent', message_id: msg.id, error: null, attempts: d.attempts + 1, channel_name: ch.name });
    } catch (err) {
      setDelivery(d.id, { status: 'failed', error: discordError(err), attempts: d.attempts + 1 });
    }
    if (i < pending.length - 1) await sleep(gapMs); // Discord's client already queues on 429; this just keeps bursts gentle
  }
  const status = finalize(id);
  if (guild) {
    const sent = delRows(id).filter((x) => x.status === 'sent').length;
    log(guild, `${a.author_tag || a.author_id} ${status === 'failed' ? 'tried to send' : 'sent'} announcement #${id} (${sent}/${delRows(id).length} channel(s) delivered).`);
  }
  return getAnnouncement(a.guild_id, id);
}

/** Create an announcement and send it now, or leave it scheduled for `scheduledAt` (ms epoch). */
async function create(client, { guild, member, userTag, input, channelIds, scheduledAt }) {
  requireReady(client);
  const { payload } = preview(guild, member, input, []);
  const channels = resolveChannels(guild, member, channelIds, payload);
  let when = now();
  if (scheduledAt !== undefined && scheduledAt !== null) {
    when = Number(scheduledAt);
    if (!Number.isFinite(when) || when < now() + 30000) throw new AnnounceError('Pick a time at least a minute from now.');
    if (when > now() + MAX_SCHEDULE_MS) throw new AnnounceError('You can schedule at most one year ahead.');
  }
  const text = JSON.stringify(payload);
  const key = [...new Set(channels.map((c) => c.id))].sort().join(',');
  const recent = db.prepare("SELECT a.id FROM announcements a WHERE a.guild_id = ? AND a.author_id = ? AND a.payload = ? AND a.created_at > ? AND a.status IN ('scheduled','sending','sent','partial')").all(guild.id, member.id, text, now() - 15000);
  for (const r of recent) if (delRows(r.id).map((d) => d.channel_id).sort().join(',') === key) throw new AnnounceError('That exact announcement was just sent. Wait a few seconds if you meant to send it again.');

  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO announcements (guild_id, author_id, author_tag, payload, status, scheduled_at, created_at) VALUES (?,?,?,?, 'scheduled', ?, ?)")
      .run(guild.id, member.id, userTag, text, when, now());
    const id = Number(info.lastInsertRowid);
    for (const c of channels) db.prepare("INSERT INTO announcement_deliveries (announcement_id, guild_id, channel_id, channel_name, status, updated_at) VALUES (?,?,?,?, 'pending', ?)").run(id, guild.id, c.id, c.name, now());
    return id;
  });
  const id = tx();
  if (when > now()) { log(guild, `${userTag} scheduled announcement #${id} for <t:${Math.floor(when / 1000)}:f>.`); return getAnnouncement(guild.id, id); }
  return run(client, id);
}

async function sendTest(client, { guild, member, input }) {
  requireReady(client);
  const { payload } = preview(guild, member, input, []);
  try { await member.user.send(buildMessage(payload, { test: true })); }
  catch { throw new AnnounceError('Couldn’t DM you. Allow direct messages from server members, then try again.'); }
}

/** Retry the failed channels of a failed/partial announcement. */
async function retry(client, { guild, member, id }) {
  requireReady(client);
  const a = getAnnouncement(guild.id, id);
  if (!a) throw new AnnounceError('Announcement not found.');
  if (!['failed', 'partial'].includes(a.status)) throw new AnnounceError('Only failed or partly delivered announcements can be retried.');
  const clean = sanitizePayload(a.payload);
  const failed = a.deliveries.filter((d) => d.status === 'failed');
  resolveChannels(guild, member, failed.map((d) => d.channelId), clean); // requester must be allowed too
  const changed = db.prepare("UPDATE announcements SET status = 'scheduled' WHERE id = ? AND guild_id = ? AND status IN ('failed','partial')").run(a.id, guild.id).changes;
  if (!changed) throw new AnnounceError('This announcement is already being retried.');
  db.prepare("UPDATE announcement_deliveries SET status = 'pending', error = NULL, updated_at = ? WHERE announcement_id = ? AND status = 'failed'").run(now(), a.id);
  db.prepare('UPDATE announcements SET author_id = ?, author_tag = COALESCE(?, author_tag) WHERE id = ?').run(member.id, `${member.user.username} (dashboard)`, a.id);
  return run(client, a.id);
}

function cancel(guild, id) {
  const changed = db.prepare("UPDATE announcements SET status = 'cancelled' WHERE id = ? AND guild_id = ? AND status = 'scheduled'").run(Number(id), guild.id).changes;
  if (!changed) throw new AnnounceError('Only scheduled announcements that haven’t started sending can be cancelled.');
  db.prepare("UPDATE announcement_deliveries SET status = 'cancelled', updated_at = ? WHERE announcement_id = ? AND status = 'pending'").run(now(), Number(id));
  return getAnnouncement(guild.id, id);
}

/** Edit a scheduled announcement (content and/or time) or the already-posted Discord messages. */
async function edit(client, { guild, member, id, input, scheduledAt }) {
  const a = getAnnouncement(guild.id, id);
  if (!a) throw new AnnounceError('Announcement not found.');
  const payload = sanitizePayload(input);
  checkRoles(guild, payload);
  if (a.status === 'scheduled') {
    resolveChannels(guild, member, a.deliveries.map((d) => d.channelId), payload);
    let when = a.scheduledAt;
    if (scheduledAt !== undefined && scheduledAt !== null) {
      when = Number(scheduledAt);
      if (!Number.isFinite(when) || when < now() + 30000 || when > now() + MAX_SCHEDULE_MS) throw new AnnounceError('Pick a time between a minute and a year from now.');
    }
    const ch = db.prepare("UPDATE announcements SET payload = ?, scheduled_at = ?, edited_at = ? WHERE id = ? AND guild_id = ? AND status = 'scheduled'").run(JSON.stringify(payload), when, now(), a.id, guild.id).changes;
    if (!ch) throw new AnnounceError('That announcement just started sending and can’t be edited as scheduled.');
    return { announcement: getAnnouncement(guild.id, id), edited: 0, failed: 0 };
  }
  if (!['sent', 'partial'].includes(a.status)) throw new AnnounceError('This announcement can’t be edited.');
  requireReady(client);
  const sent = a.deliveries.filter((d) => d.status === 'sent');
  const opts = buildMessage(payload); delete opts.allowedMentions; // edits never ping again
  let ok = 0; let bad = 0;
  for (const d of sent) {
    try {
      const ch = guild.channels.cache.get(d.channelId);
      const mid = d.link.split('/').pop();
      const msg = ch ? await ch.messages.fetch(mid) : null;
      if (!msg) throw new Error('The message could not be found.');
      await msg.edit({ ...opts, allowedMentions: { parse: [] } });
      setDelivery(d.id, { error: null }); ok++;
    } catch (err) { setDelivery(d.id, { error: `Edit failed: ${discordError(err)}` }); bad++; }
  }
  if (ok) db.prepare('UPDATE announcements SET payload = ?, edited_at = ? WHERE id = ?').run(JSON.stringify(payload), now(), a.id);
  log(guild, `${member.user.username} (dashboard) edited announcement #${a.id} (${ok} message(s) updated, ${bad} failed).`);
  return { announcement: getAnnouncement(guild.id, id), edited: ok, failed: bad };
}

/** Delete the Discord messages of a sent announcement (the history row stays, marked deleted). */
async function deleteMessages(client, { guild, member, id }) {
  requireReady(client);
  const a = getAnnouncement(guild.id, id);
  if (!a) throw new AnnounceError('Announcement not found.');
  const sent = a.deliveries.filter((d) => d.status === 'sent');
  if (!sent.length) throw new AnnounceError('There are no posted messages to delete.');
  let ok = 0; let bad = 0;
  for (const d of sent) {
    try {
      const ch = guild.channels.cache.get(d.channelId);
      const msg = ch ? await ch.messages.fetch(d.link.split('/').pop()).catch((e) => (e?.code === 10008 ? null : Promise.reject(e))) : null;
      if (msg) await msg.delete();
      setDelivery(d.id, { status: 'deleted', error: null }); ok++;
    } catch (err) { setDelivery(d.id, { error: `Delete failed: ${discordError(err)}` }); bad++; }
  }
  if (!db.prepare("SELECT 1 FROM announcement_deliveries WHERE announcement_id = ? AND status = 'sent'").get(a.id)) db.prepare("UPDATE announcements SET status = 'deleted' WHERE id = ?").run(a.id);
  log(guild, `${member.user.username} (dashboard) deleted the messages of announcement #${a.id} (${ok} deleted, ${bad} failed).`);
  return { announcement: getAnnouncement(guild.id, id), deleted: ok, failed: bad };
}

// ---------- scheduler ----------
function startScheduler(client) {
  // Anything left "sending" by a crash goes back in the queue; already-sent channels are skipped because only pending deliveries run.
  db.prepare("UPDATE announcements SET status = 'scheduled' WHERE status = 'sending'").run();
  let busy = false;
  const tick = async () => {
    if (busy || !client.isReady()) return;
    busy = true;
    try {
      for (const a of db.prepare("SELECT id FROM announcements WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20").all(now())) await run(client, a.id);
    } catch (err) { console.error('[announcements]', err); } finally { busy = false; }
  };
  setInterval(tick, 20_000).unref();
  tick();
}

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, duplicateTemplate, deleteTemplate,
  getDraft, saveDraft, clearDraft, getAnnouncement, listAnnouncements, announcementStats,
  preview, create, run, sendTest, retry, cancel, edit, deleteMessages, startScheduler, AnnounceError,
};
