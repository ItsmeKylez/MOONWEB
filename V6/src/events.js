const { Events, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const store = require('./db');
const { getSettings } = require('./settings');
const { evaluate, trackSpam, resetSpam, trackJoin } = require('./utils/automod');
const { performAction, ModError } = require('./utils/mod');
const { sendLog, infoEmbed, COLORS } = require('./utils/modlog');
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

// ---------- Scheduled actions (bans, timeouts, reminders, cleanup) ----------
function startScheduler(client) {
  const tick = async () => {
    for (const job of store.dueScheduled()) {
      store.removeScheduled(job.id);
      try {
        const guild = client.guilds.cache.get(job.guild_id);
        if (!guild) continue;
        const user = await guild.members.fetch(job.user_id).catch(() => null);
        if (!user) continue;

        if (job.action === 'unban') {
          await guild.bans.remove(job.user_id, 'Temporary ban expired').catch(() => {});
          const c = store.createCase({
            guildId: guild.id,
            type: 'unban',
            userId: job.user_id,
            userTag: user.user.username,
            moderatorId: client.user.id,
            moderatorTag: client.user.username,
            reason: 'Temporary ban expired',
          });
          const { caseEmbed } = require('./utils/modlog');
          await sendLog(guild, caseEmbed(c));
        }

        else if (job.action === 'timeout') {
          const durationMs = job.durationMs || 10 * 60_000; // default 10 min
          await user.timeout(durationMs, job.reason || 'Scheduled timeout').catch(() => {});
          const c = store.createCase({
            guildId: guild.id,
            type: 'timeout',
            userId: job.user_id,
            userTag: user.user.username,
            moderatorId: client.user.id,
            moderatorTag: client.user.username,
            reason: job.reason || 'Scheduled timeout',
            durationMs,
          });
          const { caseEmbed } = require('./utils/modlog');
          await sendLog(guild, caseEmbed(c));
        }

        else if (job.action === 'kick') {
          await user.kick(job.reason || 'Scheduled kick').catch(() => {});
          const c = store.createCase({
            guildId: guild.id,
            type: 'kick',
            userId: job.user_id,
            userTag: user.user.username,
            moderatorId: client.user.id,
            moderatorTag: client.user.username,
            reason: job.reason || 'Scheduled kick',
          });
          const { caseEmbed } = require('./utils/modlog');
          await sendLog(guild, caseEmbed(c));
        }

        else if (job.action === 'reminder') {
          // Send reminder message to user (DM)
          if (job.message) {
            try { await user.send(job.message); } catch {}
          }
        }

        else if (job.action === 'cleanup-audit') {
          // Clean up old audit logs (automated cleanup)
          const days = job.days || 30;
          const purged = store.pruneAudit(days);
          await sendLog(guild, {
            embeds: [{
              color: 0x3498db,
              title: 'Automated audit log cleanup',
              description: `Removed ${purged} audit log entries older than ${days} days.`,
              timestamp: new Date().toISOString(),
            }]
          });
        }

        else if (job.action === 'announce') {
          // Post announcement message to configured channel
          const settings = getSettings(guild.id);
          const logChannelId = settings.logChannelId;
          if (logChannelId) {
            const channel = guild.channels.cache.get(logChannelId);
            if (channel) {
              const embed = new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle(job.title || 'Automated Announcement')
                .setDescription(job.message)
                .setTimestamp();
              await channel.send({ embeds: [embed] });
            }
          }
        }

        // Log scheduled action execution
        store.insertAudit(guild.id, {
          guild_id: guild.id,
          entry_id: `sched-${Date.now()}-${job.user_id}`,
          action_type: 0,
          type: 'scheduled-action',
          category: job.action,
          target_id: job.user_id,
          target_type: 'user',
          target_name: user.user.username,
          executor_id: client.user.id,
          executor_tag: client.user.username,
          source: 'scheduler',
          is_self: 0,
          reason: job.reason,
          changes: null,
          extra: JSON.stringify({ scheduled_action_id: job.id, action: job.action }),
          case_id: null,
          created_at: Date.now(),
          imported: 0,
        });

      } catch (err) {
        console.error('[scheduler]', err);
      }
    }
  };
  setInterval(tick, 30_000).unref();
  tick();
}

// ---------- Scheduled task management ----------
function scheduleAction(guildId, userId, action, runAt, durationMs, reason, message, title, days) {
  store.schedule(guildId, userId, action, runAt);
  if (durationMs) {
    const db = store.db;
    db.prepare('INSERT INTO scheduled (guild_id, user_id, action, run_at, duration_ms, reason, message, title, days) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(guildId, userId, action, runAt, durationMs, reason, message, title, days);
  }
}
function removeScheduledAction(guildId, userId, action) {
  store.unschedule(guildId, userId, action);
  const db = store.db;
  db.prepare('DELETE FROM scheduled WHERE guild_id = ? AND user_id = ? AND action = ?').run(guildId, userId, action);
}
function listScheduled(guildId) {
  return store.db.prepare('SELECT * FROM scheduled WHERE guild_id = ? ORDER BY run_at').all(guildId);
}

module.exports = { register, startScheduler, scheduleAction, removeScheduledAction, listScheduled };

module.exports = { register, startScheduler };
