'use strict';
/* Settings export / import. Mounted under /api/guilds/:guildId (the parent guard has already checked
   login, CSRF, that the bot is in the guild and that the user has Manage Server). */
const welcome = require('../../welcome');
const { getSettings, saveSettings, sanitizeSettings } = require('../../settings');

module.exports = function mount(api) {
  const base = '/guilds/:guildId/config';

  api.get(`${base}/export`, (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="moonweb-settings-${req.guild.id}.json"`);
    res.json(getSettings(req.guild.id));
  });

  // Every value is re-validated by sanitizeSettings, so an imported file can never store junk.
  api.post(`${base}/import`, (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Send the settings as a JSON object.' });
    }
    const before = getSettings(req.guild.id);
    const after = saveSettings(req.guild.id, sanitizeSettings(req.body, before));
    const changed = welcome.diffKeys(before, after);
    if (changed.length) welcome.audit(req.guild.id, 'config', { actor: `${req.session.user.username} (dashboard)`, detail: `Settings imported (changed: ${changed.join(', ')})` });
    res.json({ settings: after, warnings: welcome.configWarnings(req.guild, after) });
  });
};
