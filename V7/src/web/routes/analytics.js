const store = require('../../db');
const { PermissionFlagsBits } = require('discord.js');
const { parseFilters } = require('../../utils/audit');

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
    // Staff analytics
    api.get('/analytics/staff', async (req, res) => {
        const { guildId } = req.query;
        if (!guildId) return res.status(400).json({ error: 'guildId required' });
        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        const staff = store.activityModerators(guildId);
        res.json({ staff });
    });

    // Advanced Reporting with CSV export
    api.get('/analytics/report', async (req, res) => {
        const { guildId, format, from, to } = req.query;
        if (!guildId) return res.status(400).json({ error: 'guildId required' });
        const permitted = await checkPermission(req, res, guildId);
        if (!permitted) return;

        const filters = parseFilters({ from, to });
        const { rows } = store.listActivity(guildId, filters, { limit: 10000 });

        if (format === 'csv') {
            const csvRows = [
                ['Kind', 'ID', 'Category', 'Type', 'Target Name', 'Moderator Tag', 'Reason', 'Created At'],
                ...rows.map(r => [r.kind, r.rid, r.category, r.type, r.target_name, r.moderator_tag, r.reason, new Date(r.created_at).toISOString()])
            ];
            const csvContent = csvRows.map(e => e.join(',')).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
            return res.send(csvContent);
        }

        res.json({ rows });
    });
};
