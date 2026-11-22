'use strict';
// Stage 9: Scheduled Tasks API. Mounted under /api/guilds/:guildId/scheduler.
// Parent guard: login, CSRF, bot in guild, Manage Server.

const express = require('express');
const { SNOWFLAKE } = require('../../../src/utils/mod');
const store = require('../../../src/db');

module.exports = function mount(api) {
  const base = '/guilds/:guildId/scheduler';
  const json = express.json({ limit: '50kb' });

  // List all scheduled tasks for this server
  api.get(`${base}`, async (req, res) => {
    try {
      const tasks = store.dueScheduled();
      res.json({ tasks });
    } catch (err) {
      console.error('[scheduler/list]', err);
      res.status(500).json({ error: 'Failed to load scheduled tasks' });
    }
  });

  // Schedule a new task
  api.post(`${base}`, json, async (req, res) => {
    try {
      const { userId, action, runAt, reason, deleteDays } = req.body ?? {};
      if (!userId || !SNOWFLAKE.test(String(userId))) throw new Error('Valid user ID required.');
      if (!action) throw new Error('Action required.');
      if (!runAt || isNaN(Number(runAt))) throw new Error('Valid run time required.');

      // Ensure bot is in the guild and user manages it (handled by parent guard)
      store.schedule(req.guild.id, userId, action, Number(runAt));

      res.json({ ok: true, taskId: req.guild.id + ':' + userId + ':' + action });
    } catch (err) {
      console.error('[scheduler/create]', err);
      res.status(400).json({ error: err.message });
    }
  });

  // Remove a scheduled task
  api.post(`${base}/remove`, json, async (req, res) => {
    try {
      const { userId, action } = req.body ?? {};
      if (userId && SNOWFLAKE.test(String(userId))) {
        store.unschedule(req.guild.id, userId, action || 'unban');
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[scheduler/remove]', err);
      res.status(500).json({ error: 'Failed to remove task' });
    }
  });
};