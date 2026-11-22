const { getSettings, saveSettings, sanitizeSettings } = require('../../settings');
const { PermissionFlagsBits } = require('discord.js');

// Helper to check if user has Manage Guild permission
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
    // Export config
    api.get('/config/export', async (req, res) => {
        const { guildId } = req.query;
        if (!guildId) return res.status(400).json({ error: 'guildId required' });

        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        const settings = getSettings(guildId);
        res.json(settings);
    });

    // Import config
    api.post('/config/import', async (req, res) => {
        const { guildId } = req.query;
        if (!guildId) return res.status(400).json({ error: 'guildId required' });

        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        const imported = req.body;
        const current = getSettings(guildId);
        const sanitized = sanitizeSettings(imported, current);
        saveSettings(guildId, sanitized);
        res.json(sanitized);
    });
};
