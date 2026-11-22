'use strict';
/* Scheduled channel messages. Mounted under /api/guilds/:guildId (parent guard applies).
   Executed by startScheduler() in src/events.js. Temporary-ban unbans share the table but are not exposed here. */
const store = require('../../db');

const MAX_AHEAD_MS = 365 * 86_400_000;
const FREQUENCIES = ['once', 'daily', 'weekly'];
const TEXT_CHANNEL_TYPES = [0, 5]; // GuildText, GuildAnnouncement

const shape = (t) => ({ id: t.id, action: t.action, runAt: t.run_at, channelId: t.channel_id, message: t.message, frequency: t.frequency || 'once', createdBy: t.user_id });

module.exports = function mount(api) {
  const base = '/guilds/:guildId/scheduled';

  api.get(base, (req, res) => {
    res.json({ tasks: store.listScheduled(req.guild.id).filter((t) => t.action === 'announce').map(shape) });
  });

  api.post(base, (req, res) => {
    const { channelId, message, frequency = 'once' } = req.body ?? {};
    const runAt = Number(req.body?.runAt);
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) return res.status(400).json({ error: 'Write the message to send.' });
    if (text.length > 2000) return res.status(400).json({ error: 'Messages can be at most 2000 characters.' });
    if (!FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'Frequency must be once, daily or weekly.' });
    if (!Number.isFinite(runAt) || runAt < Date.now() + 30_000) return res.status(400).json({ error: 'Pick a time at least a minute from now.' });
    if (runAt > Date.now() + MAX_AHEAD_MS) return res.status(400).json({ error: 'You can schedule at most one year ahead.' });

    const channel = typeof channelId === 'string' ? req.guild.channels.cache.get(channelId) : null;
    if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) return res.status(400).json({ error: 'Choose a text channel in this server.' });
    const need = ['ViewChannel', 'SendMessages'];
    if (!channel.permissionsFor(req.guild.members.me)?.has(need)) return res.status(400).json({ error: `The bot can't send messages in #${channel.name}.` });
    if (!channel.permissionsFor(req.member)?.has(need)) return res.status(400).json({ error: `You can't send messages in #${channel.name}, so the bot won't post there for you.` });

    const id = store.addScheduledMessage(req.guild.id, req.session.user.id, { runAt: Math.floor(runAt), channelId: channel.id, message: text, frequency });
    res.status(201).json({ id });
  });

  api.delete(`${base}/:id`, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.deleteScheduled(req.guild.id, id)) return res.status(404).json({ error: 'Scheduled task not found.' });
    res.json({ ok: true });
  });
};
