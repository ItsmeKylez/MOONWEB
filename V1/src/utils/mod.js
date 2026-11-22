const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const store = require('../db');
const { caseEmbed, sendLog, COLORS, LABELS } = require('./modlog');
const { formatDuration, MAX_TIMEOUT_MS } = require('./duration');

/** An error whose message is safe to show to the person running the command. */
class ModError extends Error {}

const ACTIONS = {
  ban: { perm: PermissionFlagsBits.BanMembers, needsMember: false, hierarchy: true },
  unban: { perm: PermissionFlagsBits.BanMembers, needsMember: false, hierarchy: false },
  kick: { perm: PermissionFlagsBits.KickMembers, needsMember: true, hierarchy: true },
  timeout: { perm: PermissionFlagsBits.ModerateMembers, needsMember: true, hierarchy: true },
  untimeout: { perm: PermissionFlagsBits.ModerateMembers, needsMember: true, hierarchy: true },
  warn: { perm: PermissionFlagsBits.ModerateMembers, needsMember: false, hierarchy: false },
};

const NOTIFY = new Set(['ban', 'kick', 'timeout', 'warn']);

async function notifyUser(user, guild, action, reason, durationMs) {
  try {
    const verb = { ban: 'banned from', kick: 'kicked from', timeout: 'timed out in', warn: 'warned in' }[action];
    const e = new EmbedBuilder()
      .setColor(COLORS[action])
      .setTitle(`You were ${verb} ${guild.name}`)
      .addFields({ name: 'Reason', value: reason.slice(0, 1024) });
    if (durationMs) e.addFields({ name: 'Duration', value: formatDuration(durationMs), inline: true });
    await user.send({ embeds: [e] });
  } catch {
    /* DMs closed – nothing to do */
  }
}

/**
 * Perform a moderation action and record it as a case.
 * moderator: { id, tag }.  moderatorMember: GuildMember of the human moderator (null for the bot itself).
 */
async function performAction({ guild, action, userId, moderator, moderatorMember = null, reason, durationMs = null, deleteDays = 0 }) {
  const def = ACTIONS[action];
  if (!def) throw new ModError(`Unknown action "${action}".`);
  if (!/^\d{17,20}$/.test(String(userId))) throw new ModError('That is not a valid user ID.');

  if (moderatorMember && !moderatorMember.permissions.has(def.perm)) {
    throw new ModError(`You need the permission required to ${action} members.`);
  }

  const client = guild.client;
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (userId === client.user.id) throw new ModError('I cannot moderate myself.');
  if (userId === moderator.id) throw new ModError('You cannot moderate yourself.');
  if (userId === guild.ownerId) throw new ModError('The server owner cannot be moderated.');

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) throw new ModError('I could not find a user with that ID.');
  const member = await guild.members.fetch(userId).catch(() => null);

  if (def.needsMember && !member) throw new ModError('That user is not in this server.');

  if (member && def.hierarchy) {
    if (moderatorMember && moderatorMember.id !== guild.ownerId && moderatorMember.roles.highest.position <= member.roles.highest.position) {
      throw new ModError('You cannot moderate someone with an equal or higher role than yours.');
    }
    if (me.roles.highest.position <= member.roles.highest.position) {
      throw new ModError('My highest role is not above that member’s highest role, so I cannot do that.');
    }
  }

  reason = (reason || 'No reason provided').trim().slice(0, 500) || 'No reason provided';
  const auditReason = `[${moderator.tag}] ${reason}`.slice(0, 500);

  if (NOTIFY.has(action)) await notifyUser(user, guild, action, reason, durationMs);

  try {
    switch (action) {
      case 'ban':
        await guild.members.ban(userId, { reason: auditReason, deleteMessageSeconds: Math.min(7, Math.max(0, deleteDays)) * 86400 });
        if (durationMs) store.schedule(guild.id, userId, 'unban', Date.now() + durationMs);
        else store.unschedule(guild.id, userId, 'unban');
        break;
      case 'unban':
        await guild.bans.remove(userId, auditReason);
        store.unschedule(guild.id, userId, 'unban');
        break;
      case 'kick':
        await member.kick(auditReason);
        break;
      case 'timeout':
        if (!durationMs || durationMs > MAX_TIMEOUT_MS) throw new ModError('A timeout must be between 1 second and 28 days.');
        await member.timeout(durationMs, auditReason);
        break;
      case 'untimeout':
        if (!member.isCommunicationDisabled()) throw new ModError('That member is not timed out.');
        await member.timeout(null, auditReason);
        break;
      case 'warn':
        break;
    }
  } catch (err) {
    if (err instanceof ModError) throw err;
    if (action === 'unban' && err.code === 10026) throw new ModError('That user is not banned.');
    if (err.code === 50013) throw new ModError('I am missing the permissions to do that.');
    throw err;
  }

  const created = store.createCase({
    guildId: guild.id,
    type: action,
    userId,
    userTag: user.tag ?? user.username,
    moderatorId: moderator.id,
    moderatorTag: moderator.tag,
    reason,
    durationMs: action === 'timeout' || action === 'ban' ? durationMs : null,
  });

  await sendLog(guild, caseEmbed(created));
  return created;
}

function summarize(c) {
  const label = LABELS[c.type] ?? c.type;
  return `**Case #${c.case_number}** · ${label} · <@${c.user_id}>${c.duration_ms ? ` · ${formatDuration(c.duration_ms)}` : ''}`;
}

module.exports = { performAction, ModError, summarize };
