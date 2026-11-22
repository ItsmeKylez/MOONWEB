const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const store = require('../db');
const { performAction, ModError, summarize } = require('../utils/mod');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../utils/duration');
const { sendLog, infoEmbed, COLORS, LABELS } = require('../utils/modlog');

const reasonOpt = (o) => o.setName('reason').setDescription('Reason (shown in logs and sent to the user)').setMaxLength(500);

async function act(interaction, action, extra = {}) {
  await interaction.deferReply();
  const user = interaction.options.getUser('user');
  const c = await performAction({
    guild: interaction.guild,
    action,
    userId: user?.id ?? interaction.options.getString('user_id'),
    moderator: { id: interaction.user.id, tag: interaction.user.tag ?? interaction.user.username },
    moderatorMember: interaction.member,
    reason: interaction.options.getString('reason'),
    ...extra,
  });
  await interaction.editReply({ content: `✅ ${summarize(c)}`, allowedMentions: { parse: [] } });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member (optionally for a limited time)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Who to ban').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('Temporary ban length, e.g. 3d, 12h (leave empty for permanent)'))
      .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their messages from the last N days').setMinValue(0).setMaxValue(7))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const raw = interaction.options.getString('duration');
      const durationMs = raw ? parseDuration(raw) : null;
      if (raw && !durationMs) throw new ModError('I could not read that duration. Try something like `3d`, `12h` or `1w`.');
      await act(interaction, 'ban', { durationMs, deleteDays: interaction.options.getInteger('delete_days') ?? 0 });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Unban a user by ID')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .setContexts(0)
      .addStringOption((o) => o.setName('user_id').setDescription('The banned user’s ID').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      await act(interaction, 'unban');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Who to kick').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      await act(interaction, 'kick');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Time a member out')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Who to time out').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 1d (max 28d)').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const durationMs = parseDuration(interaction.options.getString('duration', true));
      if (!durationMs || durationMs > MAX_TIMEOUT_MS) throw new ModError('Use a duration between 1s and 28d, like `10m`, `2h` or `1d`.');
      await act(interaction, 'timeout', { durationMs });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('Remove a member’s timeout')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Who to un-timeout').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      await act(interaction, 'untimeout');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
      .addStringOption((o) => reasonOpt(o).setRequired(true)),
    async execute(interaction) {
      await act(interaction, 'warn');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('Show a member’s warnings')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('user', true);
      const { rows } = store.listCases(interaction.guildId, { userId: user.id, type: 'warn', limit: 15 });
      const active = store.activeWarnCount(interaction.guildId, user.id);
      const e = new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`Warnings for ${user.username}`)
        .setDescription(
          rows.length
            ? rows
                .map((c) => `${c.active ? '' : '~~'}**#${c.case_number}** <t:${Math.floor(c.created_at / 1000)}:d> — ${c.reason}${c.active ? '' : '~~'}`)
                .join('\n')
                .slice(0, 4000)
            : 'No warnings on record.',
        )
        .setFooter({ text: `${active} active warning${active === 1 ? '' : 's'}` });
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('clearwarnings')
      .setDescription('Clear a member’s active warnings (cases stay in history)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('user', true);
      const n = store.clearWarns(interaction.guildId, user.id);
      await sendLog(
        interaction.guild,
        infoEmbed('Warnings cleared', `${interaction.user} cleared **${n}** active warning(s) for <@${user.id}>.`),
      );
      await interaction.reply({ content: `Cleared ${n} active warning(s) for **${user.username}**.`, flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('case')
      .setDescription('Look up a case by number')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const c = store.getCase(interaction.guildId, interaction.options.getInteger('number', true));
      if (!c) throw new ModError('No case with that number.');
      const e = new EmbedBuilder()
        .setColor(COLORS[c.type] ?? COLORS.info)
        .setTitle(`Case #${c.case_number} · ${LABELS[c.type] ?? c.type}`)
        .addFields(
          { name: 'User', value: `${c.user_tag} (<@${c.user_id}>)`, inline: true },
          { name: 'Moderator', value: `${c.moderator_tag} (<@${c.moderator_id}>)`, inline: true },
          { name: 'Reason', value: c.reason || 'No reason provided' },
        )
        .setTimestamp(c.created_at);
      if (c.duration_ms) e.addFields({ name: 'Duration', value: formatDuration(c.duration_ms), inline: true });
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('history')
      .setDescription('Show a member’s moderation history')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(0)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('user', true);
      const { rows, total } = store.listCases(interaction.guildId, { userId: user.id, limit: 15 });
      const e = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle(`History for ${user.username}`)
        .setDescription(
          rows.length
            ? rows.map((c) => `${summarize(c)} — ${c.reason ?? ''}`.slice(0, 200)).join('\n').slice(0, 4000)
            : 'Clean record.',
        )
        .setFooter({ text: `${total} case${total === 1 ? '' : 's'} total` });
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Bulk-delete recent messages (up to 14 days old)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setContexts(0)
      .addIntegerOption((o) => o.setName('amount').setDescription('How many messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user')),
    async execute(interaction) {
      const channel = interaction.channel;
      if (!channel?.isTextBased() || !('bulkDelete' in channel)) throw new ModError('I can only purge in server text channels.');
      const amount = interaction.options.getInteger('amount', true);
      const target = interaction.options.getUser('user');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let messages = await channel.messages.fetch({ limit: 100 });
      if (target) messages = messages.filter((m) => m.author.id === target.id);
      const toDelete = [...messages.values()].slice(0, amount);
      const deleted = await channel.bulkDelete(toDelete, true);
      await interaction.editReply(`🧹 Deleted ${deleted.size} message(s).`);
      await sendLog(
        interaction.guild,
        infoEmbed('Messages purged', `${interaction.user} deleted **${deleted.size}** message(s) in ${channel}${target ? ` from <@${target.id}>` : ''}.`),
      );
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set slowmode for a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .setContexts(0)
      .addIntegerOption((o) => o.setName('seconds').setDescription('0 turns slowmode off (max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600))
      .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    async execute(interaction) {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const seconds = interaction.options.getInteger('seconds', true);
      await channel.setRateLimitPerUser(seconds, `Slowmode by ${interaction.user.tag ?? interaction.user.username}`);
      await interaction.reply(seconds ? `🐌 Slowmode in ${channel} set to ${seconds}s.` : `Slowmode in ${channel} turned off.`);
    },
  },
  ...['lock', 'unlock'].map((name) => ({
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(name === 'lock' ? 'Stop @everyone from sending messages in a channel' : 'Let @everyone send messages in a channel again')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .setContexts(0)
      .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const reason = interaction.options.getString('reason') ?? 'No reason provided';
      const locking = name === 'lock';
      await channel.permissionOverwrites.edit(
        interaction.guild.roles.everyone,
        { SendMessages: locking ? false : null, SendMessagesInThreads: locking ? false : null },
        { reason: `[${interaction.user.tag ?? interaction.user.username}] ${reason}`.slice(0, 500) },
      );
      await interaction.reply(locking ? `🔒 ${channel} is locked. ${reason !== 'No reason provided' ? `Reason: ${reason}` : ''}` : `🔓 ${channel} is unlocked.`);
      await sendLog(interaction.guild, infoEmbed(`Channel ${locking ? 'locked' : 'unlocked'}`, `${interaction.user} ${locking ? 'locked' : 'unlocked'} ${channel}. ${reason}`));
    },
  })),
];

module.exports = commands;
