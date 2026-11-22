const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, PermissionsBitField } = require('discord.js');
const config = require('../config');
const { ModError } = require('../utils/mod');
const { sendBulk, MAX_FILES_PER_MESSAGE } = require('../utils/bulk');
const { sendLog, infoEmbed } = require('../utils/modlog');

const builder = new SlashCommandBuilder()
  .setName('bulksend')
  .setDescription('Send several images, videos or files to a channel in one go')
  .setContexts(0)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o.setName('channel').setDescription('Where to send the files').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  )
  .addAttachmentOption((o) => o.setName('file1').setDescription('File, image or video').setRequired(true))
  .addStringOption((o) => o.setName('caption').setDescription('Optional text posted with the first message').setMaxLength(1000))
  .addIntegerOption((o) => o.setName('delay').setDescription('Seconds to wait between messages (default 1.5)').setMinValue(0).setMaxValue(30));
for (let i = 2; i <= MAX_FILES_PER_MESSAGE; i++) {
  builder.addAttachmentOption((o) => o.setName(`file${i}`).setDescription('Another file'));
}

module.exports = [
  {
    data: builder,
    async execute(interaction) {
      const channel = interaction.options.getChannel('channel', true);
      const perms = channel.permissionsFor(interaction.guild.members.me);
      if (!perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles])) {
        throw new ModError(`I need View Channel, Send Messages and Attach Files in ${channel}.`);
      }
      const userPerms = channel.permissionsFor(interaction.member);
      if (!userPerms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AttachFiles])) {
        throw new ModError(`You can’t attach files in ${channel} yourself, so I can’t do it for you.`);
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const attachments = [];
      for (let i = 1; i <= MAX_FILES_PER_MESSAGE; i++) {
        const a = interaction.options.getAttachment(`file${i}`);
        if (a) attachments.push(a);
      }

      const files = [];
      const skipped = [];
      for (const a of attachments) {
        try {
          const res = await fetch(a.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          files.push({ name: a.name, data: Buffer.from(await res.arrayBuffer()) });
        } catch (err) {
          skipped.push(`${a.name} (${err.message})`);
        }
      }

      const delayMs = (interaction.options.getInteger('delay') ?? config.bulk.defaultDelayMs / 1000) * 1000;
      const result = await sendBulk({
        channel,
        files,
        caption: interaction.options.getString('caption') ?? '',
        delayMs,
      });

      const lines = [`📤 Sent **${result.sent}** of ${attachments.length} file(s) to ${channel} in ${result.messages} message(s).`];
      const problems = [...skipped, ...result.failed.map((f) => `${f.name} (${f.reason})`)];
      if (problems.length) lines.push(`⚠️ Not sent: ${problems.join('; ').slice(0, 800)}`);
      await interaction.editReply(lines.join('\n'));

      await sendLog(
        interaction.guild,
        infoEmbed('Bulk send', `${interaction.user} sent ${result.sent} file(s) to ${channel} via /bulksend.`),
      );
    },
  },
];
