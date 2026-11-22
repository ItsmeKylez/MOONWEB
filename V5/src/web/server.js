const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');
const config = require('../config');
const store = require('../db');
const { getSettings, saveSettings, sanitizeSettings } = require('../settings');
const { performAction, ModError } = require('../utils/mod');
const { sendBulk } = require('../utils/bulk');
const { sendLog, infoEmbed } = require('../utils/modlog');
const { MAX_TIMEOUT_MS } = require('../utils/duration');
const bus = require('../utils/logbus');
const audit = require('../utils/audit');
const welcome = require('../welcome');

const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const SESSION_DAYS = 7;
const DISCORD_API = 'https://discord.com/api/v10';

const INVITE_PERMS = new PermissionsBitField([
  'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory',
  'ManageMessages', 'ManageChannels', 'ManageRoles', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog',
]).bitfield;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, clear = false } = {}) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) attrs.push('Secure');
  attrs.push(`Max-Age=${clear ? 0 : maxAge}`);
  res.append('Set-Cookie', `${name}=${clear ? '' : encodeURIComponent(value)}; ${attrs.join('; ')}`);
}

function createServer(client) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway terminates TLS in front of the app

  const origin = new URL(config.baseUrl).origin;
  const redirectUri = `${config.baseUrl}/auth/callback`;

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, discordReady: client.isReady() }));

  // ---------- Sessions ----------
  app.use((req, res, next) => {
    const sid = parseCookies(req.headers.cookie).sid;
    req.sid = sid;
    req.session = sid ? store.loadSession(sid) : null;
    next();
  });

  // ---------- OAuth login ----------
  app.get('/auth/login', (req, res) => {
    if (!config.clientSecret) return res.status(503).send('Dashboard login is not configured: set CLIENT_SECRET.');
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'oauth_state', state, { maxAge: 600 });
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify guilds',
      state,
      prompt: 'none',
    }).toString();
    res.redirect(url.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const expected = parseCookies(req.headers.cookie).oauth_state;
    setCookie(res, 'oauth_state', '', { clear: true });
    if (typeof code !== 'string' || !state || state !== expected) return res.status(400).send('Login failed (state mismatch). Go back and try again.');

    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
      const { access_token: token } = await tokenRes.json();
      const headers = { Authorization: `Bearer ${token}` };
      const [user, guilds] = await Promise.all([
        fetch(`${DISCORD_API}/users/@me`, { headers }).then((r) => r.json()),
        fetch(`${DISCORD_API}/users/@me/guilds`, { headers }).then((r) => r.json()),
      ]);
      if (!user?.id || !Array.isArray(guilds)) throw new Error('bad profile response');

      const sid = crypto.randomBytes(32).toString('hex');
      store.saveSession(
        sid,
        {
          user: { id: user.id, name: user.global_name || user.username, username: user.username, avatar: user.avatar },
          guilds: guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner, permissions: g.permissions })),
        },
        Date.now() + SESSION_DAYS * 86400000,
      );
      setCookie(res, 'sid', sid, { maxAge: SESSION_DAYS * 86400 });
      res.redirect('/');
    } catch (err) {
      console.error('[oauth]', err.message);
      res.status(502).send('Discord login failed. Check CLIENT_ID, CLIENT_SECRET and the redirect URL, then try again.');
    }
  });

  app.get('/auth/logout', (req, res) => {
    if (req.sid) store.deleteSession(req.sid);
    setCookie(res, 'sid', '', { clear: true });
    res.redirect('/');
  });

  // ---------- API guards ----------
  const api = express.Router();
  app.use('/api', api);

  const hits = new Map();
  api.use((req, res, next) => {
    // CSRF: state-changing requests must come from our own page.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const o = req.headers.origin;
      if ((o && o !== origin) || req.headers['x-requested-with'] !== 'modbot') {
        return res.status(403).json({ error: 'Cross-site request blocked.' });
      }
    }
    if (!req.session) return res.status(401).json({ error: 'Not logged in.' });
    // Simple per-session rate limit: 120 requests / minute
    const now = Date.now();
    const recent = (hits.get(req.sid) ?? []).filter((t) => now - t < 60000);
    recent.push(now);
    hits.set(req.sid, recent);
    if (recent.length > 120) return res.status(429).json({ error: 'Slow down a little.' });
    next();
  });
  setInterval(() => hits.clear(), 10 * 60000).unref();

  api.get('/me', (req, res) => {
    const { user, guilds } = req.session;
    const manageable = guilds
      .filter((g) => g.owner || (BigInt(g.permissions) & (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild)) !== 0n)
      .map((g) => ({ id: g.id, name: g.name, icon: g.icon, botPresent: client.guilds.cache.has(g.id) }));
    const invite = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands`;
    res.json({ user, guilds: manageable, inviteUrl: invite, limits: { maxFiles: config.bulk.maxFiles, maxFileMB: config.bulk.maxFileBytes / 1048576 } });
  });

  // Every /api/guilds/:guildId/* route: bot must be in the guild and the user must (still) manage it.
  api.use('/guilds/:guildId', async (req, res, next) => {
    const { guildId } = req.params;
    if (!SNOWFLAKE.test(guildId)) return res.status(400).json({ error: 'Bad server ID.' });
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return res.status(403).json({ error: 'You need the Manage Server permission there.' });
    }
    req.guild = guild;
    req.member = member;
    next();
  });

  api.get('/guilds/:guildId', (req, res) => {
    const g = req.guild;
    const channels = g.channels.cache
      .filter((c) => TEXT_TYPES.includes(c.type))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name }));
    const roles = g.roles.cache
      .filter((r) => r.id !== g.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));
    res.json({
      guild: { id: g.id, name: g.name, icon: g.icon, memberCount: g.memberCount },
      settings: getSettings(g.id),
      channels,
      roles,
      stats: store.caseStats(g.id),
    });
  });

  api.put('/guilds/:guildId/settings', express.json({ limit: '200kb' }), (req, res) => {
    const before = getSettings(req.guild.id);
    const next = sanitizeSettings(req.body, before);
    saveSettings(req.guild.id, next);
    const changed = welcome.diffKeys(before, next);
    if (changed.length) welcome.audit(req.guild.id, 'config', { actor: `${req.session.user.username} (dashboard)`, detail: `Settings changed: ${changed.join(', ')}` });
    res.json({ settings: next, warnings: welcome.configWarnings(req.guild, next) });
  });

  api.get('/guilds/:guildId/cases', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const userId = typeof req.query.user === 'string' && SNOWFLAKE.test(req.query.user) ? req.query.user : undefined;
    const type = ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn'].includes(req.query.type) ? req.query.type : undefined;
    const limit = 25;
    const { total, rows } = store.listCases(req.guild.id, { userId, type, limit, offset: (page - 1) * limit });
    res.json({ total, page, pages: Math.max(1, Math.ceil(total / limit)), cases: rows });
  });

  // Moderation cases per day (dashboard chart). `day` values are UTC-midnight timestamps of the viewer's local dates.
  api.get('/guilds/:guildId/cases/timeline', (req, res) => {
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const tz = Math.round(Number(req.query.tz));
    const offsetMin = Number.isFinite(tz) && Math.abs(tz) <= 840 ? tz : 0;
    res.json({ days, timeline: store.caseTimeline(req.guild.id, days, offsetMin) });
  });

  api.post('/guilds/:guildId/actions', express.json({ limit: '20kb' }), async (req, res) => {
    const { action, userId, reason, durationMinutes, deleteDays } = req.body ?? {};
    if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) throw new ModError('Enter a valid user ID (right-click a user → Copy User ID).');
    let durationMs = null;
    if (['timeout', 'ban'].includes(action) && durationMinutes) {
      durationMs = Math.round(Number(durationMinutes) * 60000);
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new ModError('Duration must be a positive number of minutes.');
      if (action === 'timeout' && durationMs > MAX_TIMEOUT_MS) throw new ModError('Timeouts can be at most 28 days (40320 minutes).');
    }
    const c = await performAction({
      guild: req.guild,
      action,
      userId,
      moderator: { id: req.session.user.id, tag: `${req.session.user.username} (dashboard)` },
      moderatorMember: req.member,
      reason: typeof reason === 'string' ? reason : '',
      durationMs,
      deleteDays: Math.min(7, Math.max(0, parseInt(deleteDays, 10) || 0)),
    });
    res.json({ case: c });
  });

  // ---------- Moderation logs: bot cases + Discord audit log, merged ----------
  const PAGE_SIZE = 25;

  api.get('/guilds/:guildId/activity', (req, res) => {
    const f = audit.parseFilters(req.query);
    const { total, rows } = store.listActivity(req.guild.id, f, { limit: PAGE_SIZE, offset: (f.page - 1) * PAGE_SIZE });
    res.json({ total, page: f.page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), rows: rows.map(audit.shapeRow) });
  });

  // Filter options, whether the bot can read the audit log, and how much has been stored.
  api.get('/guilds/:guildId/activity/status', (req, res) => {
    const permission = !!req.guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog);
    res.json({ audit: { permission, ...store.auditStatus(req.guild.id) }, categories: audit.CATEGORIES, types: audit.allTypes(), sources: audit.SOURCES });
  });

  api.get('/guilds/:guildId/activity/moderators', (req, res) => {
    res.json({ moderators: store.activityModerators(req.guild.id) });
  });

  // Server-Sent Events: pushes each new log entry to open dashboards. Ends after 30 min so access is re-checked on reconnect.
  api.get('/guilds/:guildId/activity/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const gid = req.guild.id;
    const onActivity = (ev) => {
      if (ev.guildId !== gid) return;
      try {
        const row = store.getActivityRow(gid, ev.kind, ev.id);
        if (row) res.write(`event: activity\ndata: ${JSON.stringify(audit.shapeRow(row))}\n\n`);
      } catch (err) {
        console.error('[stream]', err.message);
      }
    };
    bus.on('activity', onActivity);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const stop = setTimeout(() => { res.write('event: bye\ndata: {}\n\n'); res.end(); }, 30 * 60000);
    req.on('close', () => { clearInterval(ping); clearTimeout(stop); bus.off('activity', onActivity); });
  });

  api.get('/guilds/:guildId/activity/audit/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const entry = Number.isSafeInteger(id) ? store.getAuditEntry(req.guild.id, id) : null;
    if (!entry) return res.status(404).json({ error: 'Log entry not found.' });
    res.json({ entry: audit.shapeAuditDetail(entry) });
  });

  // ---------- Bulk send ----------
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.bulk.maxFileBytes, files: config.bulk.maxFiles, fields: 10 },
  });
  const jobs = new Map();

  api.post('/guilds/:guildId/bulk', upload.array('files', config.bulk.maxFiles), async (req, res) => {
    const files = (req.files ?? []).map((f) => ({ name: f.originalname, data: f.buffer }));
    if (!files.length) throw new ModError('Choose at least one file.');
    const channel = req.guild.channels.cache.get(String(req.body.channelId));
    if (!channel || !TEXT_TYPES.includes(channel.type)) throw new ModError('Pick a text channel.');

    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
    if (!channel.permissionsFor(req.guild.members.me)?.has(need)) throw new ModError(`The bot needs View Channel, Send Messages and Attach Files in #${channel.name}.`);
    if (!channel.permissionsFor(req.member)?.has(need)) throw new ModError(`You can’t attach files in #${channel.name} yourself, so the bot won’t do it for you.`);

    for (const j of jobs.values()) {
      if (j.guildId === req.guild.id && j.status === 'running') throw new ModError('A bulk send is already running for this server. Wait for it to finish.');
    }

    const delaySeconds = req.body.delaySeconds === undefined || req.body.delaySeconds === '' ? config.bulk.defaultDelayMs / 1000 : Number(req.body.delaySeconds);
    const delayMs = Math.min(30, Math.max(0, Number.isFinite(delaySeconds) ? delaySeconds : 1.5)) * 1000;
    const caption = typeof req.body.caption === 'string' ? req.body.caption.slice(0, 1900) : '';

    const job = { id: crypto.randomBytes(6).toString('hex'), guildId: req.guild.id, userId: req.session.user.id, status: 'running', total: files.length, sent: 0, failed: 0, failures: [], messages: 0 };
    jobs.set(job.id, job);
    setTimeout(() => jobs.delete(job.id), 3600_000).unref();

    sendBulk({
      channel,
      files,
      caption,
      delayMs,
      onProgress: (p) => { job.sent = p.sent; job.failed = p.failed; },
    })
      .then(async (result) => {
        job.sent = result.sent;
        job.failures = result.failed;
        job.failed = result.failed.length;
        job.messages = result.messages;
        job.status = 'done';
        await sendLog(req.guild, infoEmbed('Bulk send', `${req.session.user.username} (dashboard) sent ${result.sent}/${files.length} file(s) to <#${channel.id}>.`));
      })
      .catch((err) => {
        console.error('[bulk]', err);
        job.status = 'error';
        job.error = err.message;
      });

    res.status(202).json({ jobId: job.id });
  });

  api.get('/guilds/:guildId/bulk/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.guildId !== req.guild.id) return res.status(404).json({ error: 'Job not found.' });
    res.json(job);
  });

  // ---------- Announcements (Stage 5) ----------
  require('./routes/announcements')(api, client);
  // ---------- Welcome & Goodbye (Stage 6) ----------
  require('./routes/welcome')(api);

  // ---------- Static dashboard ----------
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // ---------- Errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ModError) return res.status(400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than ${config.bulk.maxFileBytes / 1048576} MB.` : err.code === 'LIMIT_FILE_COUNT' ? `You can upload at most ${config.bulk.maxFiles} files at once.` : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    console.error('[web]', err);
    res.status(500).json({ error: 'Internal error.' });
  });

  return app;
}

module.exports = { createServer, parseCookies };
