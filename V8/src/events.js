const { Events, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const store = require('./db');
const { getSettings } = require('./settings');
const { evaluate, trackSpam, resetSpam, trackJoin } = require('./utils/automod');
const { performAction, ModError } = require('./utils/mod');
const { sendLog, infoEmbed, caseEmbed, COLORS } = require('./utils/modlog');
const { MAX_TIMEOUT_MS } = require('./utils/duration');
const { handleLive } = require('./utils/auditsync');
const welcome = require('./welcome');

function register(client, commands) {
  // ---------- Discord audit log (live) ----------
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    try {
      await handleLive(client, guild, entry);
    } catch (err) {
      console.error('[audit]', err);
    }
  });

  // ---------- Slash commands ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guild) return;
    const command = commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      let text = '⚠️ Something went wrong while running that command.';
      if (err instanceof ModError) text = `❌ ${err.message}`;
      else console.error(`[command:${interaction.commandName}]`, err);
      const payload = { content: text, flags: MessageFlags.Ephemeral };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: text, embeds: [], components: [] });
        else await interaction.reply(payload);
      } catch {
        /* interaction expired */
      }
    }
  });

  // ---------- Auto-moderation ----------
  client.on(Events.MessageCreate, async (msg) => {
    try {
      if (!msg.guild || msg.author.bot || msg.system || !msg.content) return;
      const settings = getSettings(msg.guild.id);
      const cfg = settings.automod;
      if (!cfg.enabled) return;

      const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
      if (!member) return;
      if (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator)) return;
      if (cfg.exemptChannelIds.includes(msg.channelId) || (msg.channel.parentId && cfg.exemptChannelIds.includes(msg.channel.parentId))) return;
      if (member.roles.cache.some((r) => cfg.exemptRoleIds.includes(r.id))) return;

      let violation = evaluate({ content: msg.content, mentionCount: msg.mentions.users.size + msg.mentions.roles.size }, cfg);
      if (!violation && cfg.spam.enabled && trackSpam(msg.guild.id, msg.author.id, cfg.spam)) {
        violation = { rule: 'spam', reason: 'Sending messages too quickly' };
        resetSpam(msg.guild.id, msg.author.id);
      }
      if (!violation) return;

      await msg.delete().catch(() => {});
      const notice = await msg.channel
        .send({ content: `${msg.author}, your message was removed: ${violation.reason}.`, allowedMentions: { users: [msg.author.id] } })
        .catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);

      const me = { id: client.user.id, tag: `${client.user.username} (AutoMod)` };
      await performAction({
        guild: msg.guild,
        action: 'warn',
        userId: msg.author.id,
        moderator: me,
        reason: `[AutoMod: ${violation.rule}] ${violation.reason}`,
      }).catch((e) => console.warn('[automod] warn failed:', e.message));

      // Escalation: every Nth active warning triggers the configured punishment.
      const count = store.activeWarnCount(msg.guild.id, msg.author.id);
      const { warnings, action, durationMin } = cfg.strikes;
      if (count >= warnings && count % warnings === 0) {
        await performAction({
          guild: msg.guild,
          action,
          userId: msg.author.id,
          moderator: me,
          reason: `[AutoMod] Reached ${count} warnings`,
          durationMs: action === 'timeout' ? Math.min(durationMin * 60_000, MAX_TIMEOUT_MS) : null,
        }).catch((e) => console.warn('[automod] escalation failed:', e.message));
      }
    } catch (err) {
      console.error('[automod]', err);
    }
  });

  // ---------- Joins / leaves ----------
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const settings = getSettings(member.guild.id);

      let actioned = false;
      if (settings.automod.enabled && settings.automod.raid.enabled) {
        const { raid, started } = trackJoin(member.guild.id, settings.automod.raid);
        if (started) {
          welcome.audit(member.guild.id, 'raid', { detail: `Raid threshold reached (${settings.automod.raid.joins}+ joins in ${settings.automod.raid.seconds}s). Action: ${settings.automod.raid.action}` });
          await sendLog(
            member.guild,
            infoEmbed('🚨 Possible raid detected', `${settings.automod.raid.joins}+ members joined within ${settings.automod.raid.seconds}s. Action: **${settings.automod.raid.action}**. Consider \`/lock\` on public channels.`, COLORS.ban),
          );
        }
        if (raid && ['kick', 'timeout'].includes(settings.automod.raid.action)) {
          actioned = await welcome.applyRaidAction(member, settings.automod.raid.action);
        }
      }

      // Auto role, new-account checks, welcome message, DM, join log (Stage 6)
      await welcome.handleJoin(member, { actioned });
      if (actioned && settings.automod.raid.action === 'kick') return;

      const age = Math.floor(member.user.createdTimestamp / 1000);
      await sendLog(
        member.guild,
        new EmbedBuilder()
          .setColor(COLORS.unban)
          .setTitle('Member joined')
          .setDescription(`${member} (${member.user.username})\nAccount created <t:${age}:R>`)
          .setFooter({ text: `ID: ${member.id}` })
          .setTimestamp(),
      );
    } catch (err) {
      console.error('[guildMemberAdd]', err);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try { await welcome.handleLeave(member); } catch (err) { console.error('[guildMemberRemove]', err); }
    await sendLog(
      member.guild,
      new EmbedBuilder()
        .setColor(COLORS.muted)
        .setTitle('Member left')
        .setDescription(`${member.user.username} (<@${member.id}>)`)
        .setFooter({ text: `ID: ${member.id}` })
        .setTimestamp(),
    );
  });

  // Bans done outside the bot (Discord UI) still show up in the log.
  client.on(Events.GuildBanAdd, async (ban) => {
    await new Promise((r) => setTimeout(r, 2000));
    if (store.recentCaseFor(ban.guild.id, ban.user.id, 'ban', 15_000)) return;
    await sendLog(
      ban.guild,
      infoEmbed('Member banned (outside the bot)', `${ban.user.username} (<@${ban.user.id}>)\nReason: ${ban.reason ?? 'none given'}`, COLORS.ban),
    );
  });

  // ---------- Message logs ----------
  client.on(Events.MessageDelete, async (msg) => {
    if (!msg.guild || msg.author?.bot) return;
    if (!msg.content && !msg.attachments?.size) return;
    const e = new EmbedBuilder()
      .setColor(COLORS.muted)
      .setTitle('Message deleted')
      .setDescription(`In <#${msg.channelId}> by ${msg.author ? `<@${msg.author.id}>` : 'unknown'}`)
      .setTimestamp();
    if (msg.content) e.addFields({ name: 'Content', value: msg.content.slice(0, 1000) });
    if (msg.attachments?.size) e.addFields({ name: 'Attachments', value: msg.attachments.map((a) => a.name).join(', ').slice(0, 500) });
    await sendLog(msg.guild, e);
  });

  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (!oldMsg.content || !newMsg.content || oldMsg.content === newMsg.content) return;
    await sendLog(
      newMsg.guild,
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('Message edited')
        .setDescription(`In <#${newMsg.channelId}> by <@${newMsg.author.id}> · [jump](${newMsg.url})`)
        .addFields(
          { name: 'Before', value: oldMsg.content.slice(0, 1000) },
          { name: 'After', value: newMsg.content.slice(0, 1000) },
        )
        .setTimestamp(),
    );
  });
}

// ---------- Scheduled jobs: temporary-ban unbans and scheduled channel messages ----------
const REPEAT_MS = { daily: 86_400_000, weekly: 7 * 86_400_000 };

async function runUnban(client, job) {
  const guild = client.guilds.cache.get(job.guild_id);
  if (!guild) return;
  await guild.bans.remove(job.user_id, 'Temporary ban expired').catch(() => {});
  const user = await client.users.fetch(job.user_id).catch(() => null);
  const c = store.createCase({
    guildId: guild.id,
    type: 'unban',
    userId: job.user_id,
    userTag: user?.username,
    moderatorId: client.user.id,
    moderatorTag: client.user.username,
    reason: 'Temporary ban expired',
  });
  await sendLog(guild, caseEmbed(c));
}

async function runAnnounce(client, job) {
  const guild = client.guilds.cache.get(job.guild_id);
  const channel = guild?.channels.cache.get(job.channel_id);
  if (!channel?.isTextBased() || !job.message) return;
  // Never ping anyone from a scheduled plain message.
  await channel.send({ content: job.message.slice(0, 2000), allowedMentions: { parse: [] } });
}

function startScheduler(client) {
  let busy = false;
  const tick = async () => {
    if (busy || !client.isReady()) return;
    busy = true;
    try {
      const now = Date.now();
      for (const job of store.dueScheduled(now)) {
        // Recurring jobs move to their next slot first, so a crash can never send them twice in a row.
        const step = REPEAT_MS[job.frequency];
        if (job.action === 'announce' && step) {
          let next = job.run_at + step;
          while (next <= now) next += step;
          store.rescheduleScheduled(job.id, next);
        } else {
          store.removeScheduled(job.id);
        }
        try {
          if (job.action === 'unban') await runUnban(client, job);
          else if (job.action === 'announce') await runAnnounce(client, job);
        } catch (err) {
          console.error(`[scheduler:${job.action}]`, err);
        }
      }
    } finally {
      busy = false;
    }
  };
  setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 30_000).unref();
  tick().catch((e) => console.error('[scheduler]', e));
}

module.exports = { register, startScheduler };
