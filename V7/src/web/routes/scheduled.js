const store = require('../../db');
const { PermissionFlagsBits } = require('discord.js');

async function checkPermission(req, res, guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot not in that server' });

    const member = await guild.members.fetch(req.session?.user?.id).catch(() => null);
    if (!member || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return res.status(403).json({ error: 'You need Manage Server permission' });
    }
    return true;
}

module.exports = (api) => {
    // List scheduled tasks
    api.get('/scheduled', async (req, res) => {
        const { guildId } = req.query;
        if (!guildId) return res.status(400).json({ error: 'guildId required' });
        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        const tasks = store.db.prepare('SELECT * FROM scheduled WHERE guild_id = ?').all(guildId);
        res.json({ tasks });
    });

    // Create scheduled task
    api.post('/scheduled', async (req, res) => {
        const { guildId, action, runAt, channelId, message, frequency } = req.body;
        if (!guildId || !action || !runAt) return res.status(400).json({ error: 'Missing required fields' });
        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        store.db.prepare(`
            INSERT INTO scheduled (guild_id, user_id, action, run_at, channel_id, message, frequency, next_run)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(guildId, req.session.user.id, action, runAt, channelId || null, message || null, frequency || 'once', runAt);

        res.json({ success: true });
    });

    // Delete scheduled task
    api.delete('/scheduled/:id', async (req, res) => {
        const { guildId } = req.query;
        const taskId = req.params.id;
        if (!guildId) return res.status(400).json({ error: 'guildId required' });
        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        store.db.prepare('DELETE FROM scheduled WHERE id = ? AND guild_id = ?').run(taskId, guildId);
        res.json({ success: true });
    });
};
