'use strict';
/* Stage 6 API, mounted under /api/guilds/:guildId/welcome (parent guard: login, CSRF, bot in guild, Manage Server). */
const express = require('express');
const multer = require('multer');
const svc = require('../../welcome');
const fmt = require('../../utils/welcomefmt');
const { getSettings, saveSettings } = require('../../settings');

module.exports = function mount(api) {
  const base = '/guilds/:guildId/welcome';
  const json = express.json({ limit: '200kb' });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1048576, files: 1 } });
  const h = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof svc.WelcomeError) return res.status(400).json({ error: err.message });
      next(err);
    }
  };
  const page = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);

  api.get(`${base}/meta`, h((req, res) => res.json({
    variables: svc.VARIABLES, imageTemplates: svc.IMAGE_TEMPLATES, limits: svc.LIMITS,
    imageAvailable: svc.image.available(), imageNote: svc.image.available() ? null : svc.image.unavailableReason(),
    warnings: svc.configWarnings(req.guild, getSettings(req.guild.id)),
  })));

  api.post(`${base}/test`, json, h(async (req, res) => {
    await svc.sendTest(req.guild, req.member, req.body?.kind);
    res.json({ ok: true });
  }));

  // Renders with the (possibly unsaved) image settings from the editor, using the logged-in staff member as the sample.
  api.post(`${base}/image-preview`, json, h(async (req, res) => {
    if (!svc.image.available()) throw new svc.WelcomeError(svc.image.unavailableReason());
    const cur = getSettings(req.guild.id);
    const draft = fmt.sanitizeImage(req.body?.image, cur.welcome.image);
    const buf = await svc.previewImage(req.guild, req.member, { ...cur.welcome, image: draft });
    res.json({ png: buf.toString('base64') });
  }));

  api.post(`${base}/background`, (req, res, next) => upload.single('file')(req, res, next), h((req, res) => {
    if (!req.file) throw new svc.WelcomeError('Choose a PNG or JPEG file.');
    svc.saveBackground(req.guild.id, req.file.buffer);
    const s = getSettings(req.guild.id); s.welcome.image.hasBackground = true; saveSettings(req.guild.id, s);
    svc.audit(req.guild.id, 'config', { actor: `${req.session.user.username} (dashboard)`, detail: 'Welcome image background uploaded' });
    res.json({ settings: s });
  }));
  api.delete(`${base}/background`, h((req, res) => {
    svc.removeBackground(req.guild.id);
    const s = getSettings(req.guild.id); s.welcome.image.hasBackground = false; saveSettings(req.guild.id, s);
    svc.audit(req.guild.id, 'config', { actor: `${req.session.user.username} (dashboard)`, detail: 'Welcome image background removed' });
    res.json({ settings: s });
  }));

  api.get(`${base}/events`, h((req, res) => res.json(svc.listEvents(req.guild.id, { type: req.query.type, page: page(req) }))));
  api.get(`${base}/audit`, h((req, res) => res.json(svc.listAudit(req.guild.id, { page: page(req) }))));
};
