'use strict';
/* Stage 6: welcome/goodbye, join/leave logs, automation audit, join automation (roles, DM, new-account, raid actions). */
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits: P, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('./db');
const config = require('./config');
const { getSettings } = require('./settings');
const fmt = require('./utils/welcomefmt');
const image = require('./utils/welcomeimage');
const { sendLog, COLORS } = require('./utils/modlog');

db.exec(`
CREATE TABLE IF NOT EXISTS member_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT,
  type TEXT NOT NULL, account_created INTEGER, joined_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_events ON member_events (guild_id, type, created_at);
CREATE TABLE IF NOT EXISTS member_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT, actor TEXT,
  detail TEXT, ok INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_audit ON member_audit (guild_id, created_at);
`);

const BG_DIR = path.join(config.dataDir, 'welcome-bg');
const bgPath = (guildId) => path.join(BG_DIR, `${guildId}.img`);
function readBackground(guildId) { try { return fs.readFileSync(bgPath(guildId)); } catch { return null; } }
function saveBackground(guildId, buf) {
  if (!image.isImageBuffer(buf)) throw new WelcomeError('Background must be a PNG or JPEG image.');
  if (buf.length > 2 * 1048576) throw new WelcomeError('Background must be 2 MB or smaller.');
  fs.mkdirSync(BG_DIR, { recursive: true }); fs.writeFileSync(bgPath(guildId), buf);
}
function removeBackground(guildId) { try { fs.unlinkSync(bgPath(guildId)); } catch { /* none */ } }

class WelcomeError extends Error {}

// ---------- log + audit ----------
const insEvent = db.prepare('INSERT INTO member_events (guild_id, user_id, user_tag, type, account_created, joined_at, created_at) VALUES (?,?,?,?,?,?,?)');
const insAudit = db.prepare('INSERT INTO member_audit (guild_id, kind, user_id, actor, detail, ok, created_at) VALUES (?,?,?,?,?,?,?)');
function recordEvent(guildId, type, user, joinedAt) {
  insEvent.run(guildId, user.id, user.username ?? null, type, user.createdTimestamp ?? null, joinedAt ?? null, Date.now());
}
function audit(guildId, kind, { userId = null, actor = 'system', detail = '', ok = true } = {}) {
  try { insAudit.run(guildId, kind, userId, actor, String(detail).slice(0, 500), ok ? 1 : 0, Date.now()); } catch (e) { console.warn('[welcome-audit]', e.message); }
}
function listEvents(guildId, { type, page = 1, limit = 25 } = {}) {
  const t = ['join', 'leave'].includes(type) ? type : null;
  const where = t ? 'guild_id = ? AND type = ?' : 'guild_id = ?'; const args = t ? [guildId, t] : [guildId];
  const total = db.prepare(`SELECT COUNT(*) n FROM member_events WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM member_events WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
  const since = Date.now() - 7 * 86400000;
  const c = (ty) => db.prepare('SELECT COUNT(*) n FROM member_events WHERE guild_id = ? AND type = ? AND created_at >= ?').get(guildId, ty, since).n;
  return { total, rows, week: { joins: c('join'), leaves: c('leave') } };
}
function listAudit(guildId, { page = 1, limit = 25 } = {}) {
  const total = db.prepare('SELECT COUNT(*) n FROM member_audit WHERE guild_id = ?').get(guildId).n;
  return { total, rows: db.prepare('SELECT * FROM member_audit WHERE guild_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(guildId, limit, (page - 1) * limit) };
}

// ---------- context + permission helpers ----------
function ctxFor(member, guild, memberCount) {
  const user = member.user ?? member;
  return { id: user.id, username: user.username, createdAt: user.createdTimestamp, joinedAt: member.joinedTimestamp ?? null, guildName: guild.name, memberCount: memberCount ?? guild.memberCount };
}
const avatarOf = (member) => (member.user ?? member).displayAvatarURL?.({ extension: 'png', size: 256 }) ?? null;
function roleProblem(guild, roleId) {
  const me = guild.members.me; const role = guild.roles.cache.get(roleId);
  if (!role) return 'that role no longer exists';
  if (role.managed || role.id === guild.id) return 'that role can’t be assigned manually';
  if (!me?.permissions.has(P.ManageRoles)) return 'the bot lacks the Manage Roles permission';
  if (role.position >= me.roles.highest.position) return `the bot’s highest role must be above “${role.name}”`;
  return null;
}
function channelProblem(guild, channelId, needAttach = false) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch || !ch.isTextBased?.()) return 'that channel no longer exists or is not a text channel';
  const perms = ch.permissionsFor(guild.members.me);
  const need = [P.ViewChannel, P.SendMessages, P.EmbedLinks, ...(needAttach ? [P.AttachFiles] : [])];
  const miss = need.filter((p) => !perms?.has(p));
  if (miss.length) return `the bot is missing ${miss.map((p) => Object.keys(P).find((k) => P[k] === p)).join(', ')} in #${ch.name}`;
  return null;
}
/** Non-blocking warnings shown after saving settings. */
function configWarnings(guild, s) {
  const w = [];
  const chk = (label, id, needAttach) => { if (id) { const p = channelProblem(guild, id, needAttach); if (p) w.push(`${label}: ${p}.`); } };
  if (s.welcome.enabled) chk('Welcome channel', s.welcome.channelId, s.welcome.image.enabled);
  if (s.goodbye.enabled) chk('Goodbye channel', s.goodbye.channelId, false);
  if (s.welcome.enabled && !s.welcome.channelId) w.push('Welcome is on but no channel is selected.');
  if (s.goodbye.enabled && !s.goodbye.channelId) w.push('Goodbye is on but no channel is selected.');
  for (const [label, id] of [['Auto role', s.autoRoleId], ['Verification role', s.joinAutomation.verificationRoleId]]) {
    if (id) { const p = roleProblem(guild, id); if (p) w.push(`${label}: ${p}.`); }
  }
  if (s.joinAutomation.newAccount.enabled && s.joinAutomation.newAccount.action === 'kick' && !guild.members.me?.permissions.has(P.KickMembers)) w.push('New-account kick needs the Kick Members permission.');
  if (s.automod.raid.enabled && ['kick', 'timeout'].includes(s.automod.raid.action)) {
    const need = s.automod.raid.action === 'kick' ? P.KickMembers : P.ModerateMembers;
    if (!guild.members.me?.permissions.has(need)) w.push(`Anti-raid “${s.automod.raid.action}” needs the ${s.automod.raid.action === 'kick' ? 'Kick Members' : 'Timeout Members'} permission.`);
  }
  if (s.welcome.image.enabled && !image.available()) w.push(image.unavailableReason());
  return w;
}
/** Which sections changed (for the config audit trail). */
function diffKeys(before, after) {
  return ['logChannelId', 'autoRoleId', 'welcome', 'goodbye', 'joinAutomation', 'automod'].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// ---------- sending ----------
async function makeImage(guild, member, cfg) {
  const ctx = ctxFor(member, guild);
  return image.renderWelcomeImage(cfg.image, ctx, { avatarUrl: avatarOf(member), bg: readBackground(guild.id) });
}
async function deliver(guild, member, kind, { memberCount, testBy } = {}) {
  const s = getSettings(guild.id);
  const cfg = s[kind];
  const problem = cfg.channelId ? channelProblem(guild, cfg.channelId, kind === 'welcome' && cfg.image.enabled) : 'no channel selected';
  if (problem) throw new WelcomeError(`Can’t send: ${problem}.`);
  const channel = guild.channels.cache.get(cfg.channelId);
  const ctx = ctxFor(member, guild, memberCount);
  let file = null;
  if (kind === 'welcome' && cfg.image.enabled) {
    try { file = new AttachmentBuilder(await makeImage(guild, member, cfg), { name: 'welcome.png' }); } catch (e) { audit(guild.id, 'image', { userId: ctx.id, detail: e.message, ok: false }); }
  }
  const msg = fmt.buildMessage(cfg, ctx, { hasImage: !!file, avatarUrl: avatarOf(member), isWelcome: kind === 'welcome' });
  const { imageAsFile, ...payload } = msg;
  if (file) payload.files = [file];
  await channel.send(payload);
  audit(guild.id, testBy ? 'test' : kind, { userId: ctx.id, actor: testBy ?? 'system', detail: `${testBy ? 'Test ' : ''}${kind} message sent to #${channel.name}` });
}
async function sendTest(guild, member, kind) {
  if (!['welcome', 'goodbye'].includes(kind)) throw new WelcomeError('Unknown message type.');
  await deliver(guild, member, kind, { testBy: `${member.user.username} (dashboard)` });
}
async function previewImage(guild, member, cfg = getSettings(guild.id).welcome) {
  return makeImage(guild, member, cfg);
}

// ---------- event handlers ----------
async function applyRaidAction(member, action) {
  const g = member.guild; const me = g.members.me;
  try {
    if (action === 'kick') {
      if (!me?.permissions.has(P.KickMembers) || !member.kickable) throw new Error('bot cannot kick this member');
      await member.kick('[Anti-raid] Join rate exceeded');
    } else if (action === 'timeout') {
      if (!me?.permissions.has(P.ModerateMembers) || !member.moderatable) throw new Error('bot cannot time out this member');
      await member.timeout(10 * 60_000, '[Anti-raid] Join rate exceeded');
    } else return false;
    audit(g.id, 'raid', { userId: member.id, detail: `Anti-raid ${action} applied to ${member.user.username}` });
    return true;
  } catch (e) {
    audit(g.id, 'raid', { userId: member.id, detail: `Anti-raid ${action} failed: ${e.message}`, ok: false });
    return false;
  }
}

/** Called for every join after raid handling. `actioned` = the anti-raid action already removed/muted the member. */
async function handleJoin(member, { actioned = false } = {}) {
  const guild = member.guild; const s = getSettings(guild.id);
  if (s.joinAutomation.logJoinLeave) recordEvent(guild.id, 'join', member.user, member.joinedTimestamp ?? Date.now());
  if (actioned) return;
  const ja = s.joinAutomation;

  // new-account detection
  let flagged = false;
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  if (ja.newAccount.enabled && ageDays < ja.newAccount.days) {
    flagged = true;
    audit(guild.id, 'newaccount', { userId: member.id, detail: `${member.user.username}: account ${ageDays.toFixed(1)} days old (limit ${ja.newAccount.days})` });
    await sendLog(guild, new EmbedBuilder().setColor(COLORS.warn ?? COLORS.ban).setTitle('⚠️ New account joined')
      .setDescription(`${member} (${member.user.username})\nAccount is only **${ageDays < 1 ? 'hours' : `${Math.floor(ageDays)} day(s)`}** old (threshold: ${ja.newAccount.days} days).\nAccount created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`)
      .setFooter({ text: `ID: ${member.id}` }).setTimestamp());
    if (ja.newAccount.action === 'kick') {
      if (guild.members.me?.permissions.has(P.KickMembers) && member.kickable) {
        try { await member.kick('[New-account protection]'); audit(guild.id, 'newaccount', { userId: member.id, detail: 'Kicked (account too new)' }); return; } catch (e) { audit(guild.id, 'newaccount', { userId: member.id, detail: `Kick failed: ${e.message}`, ok: false }); }
      } else audit(guild.id, 'newaccount', { userId: member.id, detail: 'Kick skipped: missing permission or role hierarchy', ok: false });
    }
  }

  // roles: flagged accounts get the verification role (if set) instead of the auto role
  const roleId = flagged && ja.verificationRoleId ? ja.verificationRoleId : s.autoRoleId;
  if (roleId) {
    const problem = roleProblem(guild, roleId);
    if (problem) audit(guild.id, 'role', { userId: member.id, detail: `Role not assigned: ${problem}`, ok: false });
    else try { await member.roles.add(roleId, flagged ? 'Verification role (new account)' : 'Auto role'); audit(guild.id, 'role', { userId: member.id, detail: `Assigned role ${guild.roles.cache.get(roleId)?.name}` }); } catch (e) { audit(guild.id, 'role', { userId: member.id, detail: `Role failed: ${e.message}`, ok: false }); }
  }

  if (s.welcome.enabled && s.welcome.channelId) {
    try { await deliver(guild, member, 'welcome'); } catch (e) { audit(guild.id, 'welcome', { userId: member.id, detail: e.message, ok: false }); }
  }
  if (s.welcome.dm.enabled) {
    try { await member.send({ content: fmt.render(s.welcome.dm.message, ctxFor(member, guild), { plain: true }).slice(0, 2000) }); audit(guild.id, 'dm', { userId: member.id, detail: 'Welcome DM sent' }); }
    catch { audit(guild.id, 'dm', { userId: member.id, detail: 'Welcome DM failed (member has DMs closed)', ok: false }); }
  }
}

async function handleLeave(member) {
  const guild = member.guild; const s = getSettings(guild.id);
  if (s.joinAutomation.logJoinLeave) recordEvent(guild.id, 'leave', member.user, member.joinedTimestamp ?? null);
  if (s.goodbye.enabled && s.goodbye.channelId) {
    try { await deliver(guild, member, 'goodbye'); } catch (e) { audit(guild.id, 'goodbye', { userId: member.id, detail: e.message, ok: false }); }
  }
}

module.exports = { WelcomeError, VARIABLES: fmt.VARIABLES, IMAGE_TEMPLATES: fmt.IMAGE_TEMPLATES, LIMITS: fmt.LIMITS, image,
  readBackground, saveBackground, removeBackground, recordEvent, audit, listEvents, listAudit, configWarnings, diffKeys,
  sendTest, previewImage, handleJoin, handleLeave, applyRaidAction, roleProblem, channelProblem };
