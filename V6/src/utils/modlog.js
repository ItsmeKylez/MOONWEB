const { EmbedBuilder } = require('discord.js');
const { getSettings } = require('../settings');
const { formatDuration } = require('./duration');

const COLORS = {
  ban: 0xed4245,
  unban: 0x57f287,
  kick: 0xe67e22,
  timeout: 0xf1c40f,
  untimeout: 0x57f287,
  warn: 0xfee75c,
  info: 0x5865f2,
  muted: 0x99aab5,
};

const LABELS = {
  ban: 'Ban',
  unban: 'Unban',
  kick: 'Kick',
  timeout: 'Timeout',
  untimeout: 'Timeout removed',
  warn: 'Warning',
};

function caseEmbed(c) {
  const e = new EmbedBuilder()
    .setColor(COLORS[c.type] ?? COLORS.info)
    .setTitle(`Case #${c.case_number} · ${LABELS[c.type] ?? c.type}`)
    .addFields(
      { name: 'User', value: `${c.user_tag ?? 'Unknown'} (<@${c.user_id}>)`, inline: true },
      { name: 'Moderator', value: `${c.moderator_tag ?? 'Unknown'} (<@${c.moderator_id}>)`, inline: true },
      { name: 'Reason', value: (c.reason || 'No reason provided').slice(0, 1024) },
    )
    .setTimestamp(c.created_at);
  if (c.duration_ms) e.addFields({ name: 'Duration', value: formatDuration(c.duration_ms), inline: true });
  e.setFooter({ text: `User ID: ${c.user_id}` });
  return e;
}

async function sendLog(guild, embed) {
  try {
    const { logChannelId } = getSettings(guild.id);
    if (!logChannelId) return;
    const channel = guild.channels.cache.get(logChannelId) ?? (await guild.channels.fetch(logChannelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`[modlog] could not send log in ${guild.id}: ${err.message}`);
  }
}

function infoEmbed(title, description, color = COLORS.info) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description.slice(0, 4000)).setTimestamp();
}

module.exports = { caseEmbed, sendLog, infoEmbed, COLORS, LABELS };
