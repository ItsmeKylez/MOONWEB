const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require('discord.js');
const config = require('../config');
const store = require('../db');
const { getSettings, saveSettings } = require('../settings');
const { ModError } = require('../utils/mod');
const { COLORS } = require('../utils/modlog');

const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Show information about a member')
      .setContexts(0)
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you')),
    async execute(interaction) {
      const user = interaction.options.getUser('user') ?? interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const warns = store.activeWarnCount(interaction.guildId, user.id);
      const { total } = store.listCases(interaction.guildId, { userId: user.id, limit: 1 });
      const e = new EmbedBuilder()
        .setColor(member?.displayColor || COLORS.info)
        .setTitle(user.username)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'ID', value: user.id, inline: true },
          { name: 'Account created', value: ts(user.createdTimestamp), inline: true },
          { name: 'Joined server', value: member?.joinedTimestamp ? ts(member.joinedTimestamp) : 'Not in server', inline: true },
          { name: 'Active warnings', value: String(warns), inline: true },
          { name: 'Total cases', value: String(total), inline: true },
        );
      if (member) {
        const roles = member.roles.cache.filter((r) => r.id !== interaction.guildId).sort((a, b) => b.position - a.position).map((r) => r.toString());
        e.addFields({ name: `Roles (${roles.length})`, value: roles.join(' ').slice(0, 1000) || 'None' });
      }
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('serverinfo')
      .setDescription('Show information about this server')
      .setContexts(0),
    async execute(interaction) {
      const g = interaction.guild;
      const e = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle(g.name)
        .setThumbnail(g.iconURL())
        .addFields(
          { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Members', value: String(g.memberCount), inline: true },
          { name: 'Channels', value: String(g.channels.cache.size), inline: true },
          { name: 'Roles', value: String(g.roles.cache.size), inline: true },
          { name: 'Boost level', value: String(g.premiumTier), inline: true },
          { name: 'Created', value: ts(g.createdTimestamp), inline: true },
        );
      await interaction.reply({ embeds: [e] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('config')
      .setDescription('Quick bot configuration (the dashboard has everything)')
      .setContexts(0)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('show').setDescription('Show the current settings'))
      .addSubcommand((s) =>
        s
          .setName('logchannel')
          .setDescription('Set the channel where moderation logs are posted')
          .addChannelOption((o) => o.setName('channel').setDescription('Log channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      )
      .addSubcommand((s) =>
        s
          .setName('automod')
          .setDescription('Turn auto-moderation on or off')
          .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
      ),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const settings = getSettings(interaction.guildId);
      if (sub === 'logchannel') {
        const channel = interaction.options.getChannel('channel', true);
        const perms = channel.permissionsFor(interaction.guild.members.me);
        if (!perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) {
          throw new ModError(`I can’t send embeds in ${channel}. Give me View Channel, Send Messages and Embed Links there first.`);
        }
        settings.logChannelId = channel.id;
        saveSettings(interaction.guildId, settings);
        return interaction.reply({ content: `Logs will be posted in ${channel}.`, flags: MessageFlags.Ephemeral });
      }
      if (sub === 'automod') {
        settings.automod.enabled = interaction.options.getBoolean('enabled', true);
        saveSettings(interaction.guildId, settings);
        return interaction.reply({ content: `Auto-moderation is now **${settings.automod.enabled ? 'on' : 'off'}**.`, flags: MessageFlags.Ephemeral });
      }
      const a = settings.automod;
      const on = (b) => (b ? '✅' : '❌');
      const e = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('Bot settings')
        .addFields(
          { name: 'Log channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'Not set', inline: true },
          { name: 'Auto-mod', value: on(a.enabled), inline: true },
          {
            name: 'Rules',
            value: [
              `${on(a.spam.enabled)} Spam (${a.spam.maxMessages} msgs / ${a.spam.seconds}s)`,
              `${on(a.invites.enabled)} Invite links`,
              `${on(a.links.enabled)} Links`,
              `${on(a.badWords.enabled)} Word filter (${a.badWords.words.length} words)`,
              `${on(a.mentions.enabled)} Mass mentions (>${a.mentions.max})`,
              `${on(a.caps.enabled)} Excess caps`,
              `${on(a.raid.enabled)} Raid protection`,
            ].join('\n'),
          },
          { name: 'Escalation', value: `${a.strikes.warnings} warnings → ${a.strikes.action}` },
        );
      await interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('dashboard')
      .setDescription('Get the link to the web dashboard')
      .setContexts(0)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
      await interaction.reply({ content: `Dashboard: ${config.baseUrl}`, flags: MessageFlags.Ephemeral });
    },
  },
];
