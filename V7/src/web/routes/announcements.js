'use strict';
/* Announcement API. Mounted under /api/guilds/:guildId/announcements — the parent guard has already
   checked login, CSRF, that the bot is in the guild and that the user has Manage Server. */
const express = require('express');
const svc = require('../../announcements');
const { LIMITS, CATEGORIES, AnnounceError } = require('../../utils/announce');

module.exports = function mount(api, client) {
  const base = '/guilds/:guildId/announcements';
  const json = express.json({ limit: '200kb' });
  // Express 5 forwards rejected promises to the error handler; turn our validation errors into 400s here.
  const h = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof AnnounceError) return res.status(400).json({ error: err.message });
      next(err);
    }
  };
  const ctx = (req) => ({ guild: req.guild, member: req.member, userTag: `${req.session.user.username} (dashboard)` });

  api.get(`${base}/meta`, h((req, res) => res.json({ limits: LIMITS, categories: CATEGORIES, templates: svc.listTemplates(req.guild.id), stats: svc.announcementStats(req.guild.id) })));

  // ----- templates -----
  api.post(`${base}/templates`, json, h((req, res) => {
    const { name, category, payload } = req.body ?? {};
    res.status(201).json({ template: svc.createTemplate(req.guild.id, { name, category, payload, userId: req.session.user.id }) });
  }));
  api.put(`${base}/templates/:id`, json, h((req, res) => res.json({ template: svc.updateTemplate(req.guild.id, req.params.id, req.body ?? {}) })));
  api.post(`${base}/templates/:id/duplicate`, h((req, res) => res.status(201).json({ template: svc.duplicateTemplate(req.guild.id, req.params.id, req.session.user.id) })));
  api.delete(`${base}/templates/:id`, h((req, res) => {
    if (!svc.deleteTemplate(req.guild.id, req.params.id)) return res.status(404).json({ error: 'Template not found.' });
    res.json({ ok: true });
  }));

  // ----- draft autosave (per user, per server) -----
  api.get(`${base}/draft`, h((req, res) => res.json(svc.getDraft(req.guild.id, req.session.user.id))));
  api.put(`${base}/draft`, json, h((req, res) => { svc.saveDraft(req.guild.id, req.session.user.id, req.body?.draft); res.json({ ok: true }); }));
  api.delete(`${base}/draft`, h((req, res) => { svc.clearDraft(req.guild.id, req.session.user.id); res.json({ ok: true }); }));

  // ----- validate / test / send -----
  api.post(`${base}/validate`, json, h((req, res) => {
    const { payload, channels } = svc.preview(req.guild, req.member, req.body?.payload, req.body?.channelIds);
    res.json({ ok: true, payload, channels });
  }));
  api.post(`${base}/test`, json, h(async (req, res) => {
    await svc.sendTest(client, { guild: req.guild, member: req.member, input: req.body?.payload });
    res.json({ ok: true });
  }));
  api.post(base, json, h(async (req, res) => {
    const { payload, channelIds, scheduledAt } = req.body ?? {};
    const announcement = await svc.create(client, { ...ctx(req), input: payload, channelIds, scheduledAt });
    res.status(201).json({ announcement });
  }));

  // ----- history -----
  api.get(base, h((req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json({ ...svc.listAnnouncements(req.guild.id, { page, status: req.query.status }), stats: svc.announcementStats(req.guild.id) });
  }));
  api.get(`${base}/:id`, h((req, res) => {
    const announcement = svc.getAnnouncement(req.guild.id, req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
    res.json({ announcement });
  }));

  // ----- manage -----
  api.put(`${base}/:id`, json, h(async (req, res) => res.json(await svc.edit(client, { ...ctx(req), id: req.params.id, input: req.body?.payload, scheduledAt: req.body?.scheduledAt }))));
  api.post(`${base}/:id/cancel`, h((req, res) => res.json({ announcement: svc.cancel(req.guild, req.params.id) })));
  api.post(`${base}/:id/retry`, h(async (req, res) => res.json({ announcement: await svc.retry(client, { guild: req.guild, member: req.member, id: req.params.id }) })));
  api.post(`${base}/:id/delete-messages`, h(async (req, res) => res.json(await svc.deleteMessages(client, { guild: req.guild, member: req.member, id: req.params.id }))));
};
