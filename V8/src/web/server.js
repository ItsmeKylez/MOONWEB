'use strict';
/* Dashboard server: Discord OAuth login, server-side sessions, JSON API, live log stream, bulk-send jobs, static frontend.

   Every /api/guilds/:guildId/* route sits behind one guard that, on EVERY request, checks the session,
   that the bot is in that server, and that the user currently has Manage Server there. */
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const config = require('../config');
const store = require('../db');
const bus = require('../utils/logbus');
const audit = require('../utils/audit');
const welcome = require('../welcome');
const { sendBulk } = require('../utils/bulk');
const { getSettings, saveSettings, sanitizeSettings } = require('../settings');
const { performAction, ModError } = require('../utils/mod');
const { sendLog, infoEmbed } = require('../utils/modlog');

const SNOWFLAKE = /^\d{17,20}$/;
const SESSION_MS = 7 * 24 * 3600 * 1000;
const DISCORD_API = 'https://discord.com/api/v10';
const TEXT_CHANNEL_TYPES = [0, 5]; // GuildText, GuildAnnouncement
const CASE_PAGE = 25;
const ACTION_TYPES = ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn'];

const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ViewAuditLog,
]).bitfield.toString();

const inviteUrl = () => `https://discord.com/oauth2/authorize?${new URLSearchParams({
  client_id: config.clientId || '', scope: 'bot applications.commands', permissions: INVITE_PERMISSIONS,
})}`;

// ---------- small helpers ----------
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}
function setCookie(res, name, value, { maxAgeMs } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  parts.push(maxAgeMs === 0 ? 'Max-Age=0' : `Max-Age=${Math.floor((maxAgeMs ?? SESSION_MS) / 1000)}`);
  res.append('Set-Cookie', parts.join('; '));
}
const clearCookie = (res, name) => setCookie(res, name, '', { maxAgeMs: 0 });
const randomId = () => crypto.randomBytes(32).toString('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Fixed-window in-memory rate limiter. */
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    if (++e.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Slow down for a moment.' });
    }
    next();
  };
}

/** Discord's REST helper for the OAuth flow. */
async function discordFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Discord responded with ${res.status}`);
  return res.json();
}

const canManage = (g) => g.owner === true || (BigInt(g.permissions || 0) & PermissionFlagsBits.ManageGuild) !== 0n;

function createServer(client) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway terminates TLS in front of us

  // ---------- security headers ----------
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' https: data:",
      "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // Health check (Railway) answers even while Discord is still connecting.
  app.get('/health', (req, res) => res.json({ ok: true, discordReady: !!client.isReady?.() }));

  // ---------- OAuth ----------
  const redirectUri = `${config.baseUrl}/auth/callback`;
  const authLimit = rateLimit({ windowMs: 60_000, max: 30, key: (req) => `auth:${req.ip}` });

  app.get('/auth/login', authLimit, (req, res) => {
    if (!config.clientId || !config.clientSecret) return res.status(500).send('The dashboard login is not configured: set CLIENT_ID and CLIENT_SECRET.');
    const state = randomId();
    setCookie(res, 'oauth_state', state, { maxAgeMs: 10 * 60_000 });
    res.redirect(`https://discord.com/oauth2/authorize?${new URLSearchParams({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify guilds', state, prompt: 'none',
    })}`);
  });

  app.get('/auth/callback', authLimit, async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const { code, state } = req.query;
    clearCookie(res, 'oauth_state');
    if (typeof code !== 'string' || typeof state !== 'string' || !cookies.oauth_state || !safeEqual(state, cookies.oauth_state)) {
      return res.status(400).send('Login failed: the login session expired or was tampered with. Go back and try again.');
    }
    try {
      const token = await discordFetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });
      const auth = { headers: { Authorization: `Bearer ${token.access_token}` } };
      const [user, guilds] = await Promise.all([discordFetch(`${DISCORD_API}/users/@me`, auth), discordFetch(`${DISCORD_API}/users/@me/guilds`, auth)]);
      const sid = randomId();
      store.saveSession(sid, {
        user: { id: user.id, username: user.username, name: user.global_name || user.username, avatar: user.avatar || null },
        guilds: guilds.filter(canManage).map((g) => ({ id: g.id, name: g.name, icon: g.icon || null, owner: !!g.owner, permissions: String(g.permissions) })),
      }, Date.now() + SESSION_MS);
      setCookie(res, 'sid', sid);
      res.redirect('/');
    } catch (err) {
      console.warn('[auth] login failed:', err.message);
      res.status(502).send('Login failed: Discord did not accept the request. Go back and try again.');
    }
  });

  app.get('/auth/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) store.deleteSession(sid);
    clearCookie(res, 'sid');
    res.redirect('/');
  });

  // ---------- API ----------
  const api = express.Router();
  app.use('/api', api);

  const sessionKey = (req) => `api:${parseCookies(req.headers.cookie).sid || req.ip}`;
  api.use(rateLimit({ windowMs: 60_000, max: 600, key: sessionKey }));

  // CSRF: browsers can't add this header or forge a same-origin Origin from another site.
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'modbot') return res.status(403).json({ error: 'Blocked: missing request header.' });
    const origin = req.get('Origin');
    if (origin && origin !== config.baseUrl && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked: cross-site request.' });
    next();
  });

  // Login
  api.use((req, res, next) => {
    const sid = parseCookies(req.headers.cookie).sid;
    const data = sid ? store.loadSession(sid) : null;
    if (!data) return res.status(401).json({ error: 'Please log in.' });
    req.sid = sid;
    req.session = data;
    next();
  });

  api.use(express.json({ limit: '512kb' }));

  api.get('/me', (req, res) => {
    const { user, guilds } = req.session;
    res.json({
      user,
      guilds: guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, botPresent: client.guilds.cache.has(g.id) })),
      inviteUrl: inviteUrl(),
      limits: { maxFileMB: Math.round(config.bulk.maxFileBytes / 1048576), maxFiles: config.bulk.maxFiles },
    });
  });

  // The per-request permission guard for everything below /guilds/:guildId.
  api.use('/guilds/:guildId', async (req, res, next) => {
    const { guildId } = req.params;
    // Same 404 for "not yours" and "bot not there" so the API doesn't reveal which servers exist.
    if (!SNOWFLAKE.test(guildId) || !req.session.guilds.some((g) => g.id === guildId)) return res.status(404).json({ error: 'Server not found.' });
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });
    const member = await guild.members.fetch(req.session.user.id).catch(() => null);
    if (!member || !member.permissions.has(PermissionFlagsBits.ManageGuild)) return res.status(403).json({ error: 'You need the Manage Server permission there.' });
    req.guild = guild;
    req.member = member;
    next();
  });

  // ----- overview + settings -----
  api.get('/guilds/:guildId', (req, res) => {
    const g = req.guild;
    res.json({
      guild: { id: g.id, name: g.name, icon: g.icon, memberCount: g.memberCount },
      settings: getSettings(g.id),
      channels: g.channels.cache.filter((c) => TEXT_CHANNEL_TYPES.includes(c.type)).sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name })),
      roles: g.roles.cache.filter((r) => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name })),
      stats: store.caseStats(g.id),
    });
  });

  api.put('/guilds/:guildId/settings', (req, res) => {
    const before = getSettings(req.guild.id);
    const settings = saveSettings(req.guild.id, sanitizeSettings(req.body, before));
    const changed = welcome.diffKeys(before, settings);
    if (changed.length) welcome.audit(req.guild.id, 'config', { actor: `${req.session.user.username} (dashboard)`, detail: `Changed: ${changed.join(', ')}` });
    res.json({ settings, warnings: welcome.configWarnings(req.guild, settings) });
  });

  // ----- cases -----
  api.get('/guilds/:guildId/cases', (req, res) => {
    const page = Math.min(10000, Math.max(1, parseInt(req.query.page, 10) || 1));
    const userId = SNOWFLAKE.test(req.query.user || '') ? req.query.user : undefined;
    const type = ACTION_TYPES.includes(req.query.type) ? req.query.type : undefined;
    const { total, rows } = store.listCases(req.guild.id, { userId, type, limit: CASE_PAGE, offset: (page - 1) * CASE_PAGE });
    res.json({ cases: rows, total, page, pages: Math.max(1, Math.ceil(total / CASE_PAGE)) });
  });

  api.get('/guilds/:guildId/cases/timeline', (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const tz = Math.min(840, Math.max(-720, parseInt(req.query.tz, 10) || 0));
    res.json({ timeline: store.caseTimeline(req.guild.id, days, tz) });
  });

  // ----- moderation actions (same checks as the slash commands) -----
  api.post('/guilds/:guildId/actions', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    if (!ACTION_TYPES.includes(b.action)) return res.status(400).json({ error: 'Unknown action.' });
    let durationMs = null;
    if (b.durationMinutes !== undefined && b.durationMinutes !== '' && b.durationMinutes !== null) {
      durationMs = Math.round(Number(b.durationMinutes) * 60_000);
      if (!Number.isFinite(durationMs) || durationMs <= 0) return res.status(400).json({ error: 'Invalid duration.' });
    }
    try {
      const created = await performAction({
        guild: req.guild,
        action: b.action,
        userId: String(b.userId ?? ''),
        moderator: { id: req.session.user.id, tag: `${req.session.user.username} (dashboard)` },
        moderatorMember: req.member,
        reason: typeof b.reason === 'string' ? b.reason : '',
        durationMs: ['ban', 'timeout'].includes(b.action) ? durationMs : null,
        deleteDays: Math.min(7, Math.max(0, Number(b.deleteDays) || 0)),
      });
      res.status(201).json({ case: created });
    } catch (err) {
      if (err instanceof ModError) return res.status(400).json({ error: err.message });
      if (typeof err?.code === 'number') return res.status(400).json({ error: `Discord refused the request: ${err.message}` });
      throw err;
    }
  });

  // ----- moderation logs (cases + Discord audit log) -----
  const pageOf = (n, f) => Math.min(10000, Math.max(1, n || f));

  api.get('/guilds/:guildId/activity/status', (req, res) => {
    res.json({
      categories: audit.CATEGORIES,
      sources: audit.SOURCES,
      types: audit.allTypes(),
      audit: { permission: !!req.guild.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog), ...store.auditStatus(req.guild.id) },
    });
  });

  api.get('/guilds/:guildId/activity/moderators', (req, res) => {
    res.json({ moderators: store.activityModerators(req.guild.id) });
  });

  api.get('/guilds/:guildId/activity/audit/:id', (req, res) => {
    const entry = /^\d+$/.test(req.params.id) ? store.getAuditEntry(req.guild.id, Number(req.params.id)) : null;
    if (!entry) return res.status(404).json({ error: 'Log entry not found.' });
    res.json({ entry: audit.shapeAuditDetail(entry) });
  });

  // Server-sent events. The connection is recycled every few minutes so permissions and the session are re-checked.
  api.get('/guilds/:guildId/activity/stream', (req, res) => {
    const gid = req.guild.id;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const onActivity = (e) => {
      if (e.guildId !== gid) return;
      try {
        const row = store.getActivityRow(gid, e.kind, e.id);
        if (row) res.write(`event: activity\ndata: ${JSON.stringify(audit.shapeRow(row))}\n\n`);
      } catch (err) { console.warn('[stream]', err.message); }
    };
    bus.on('activity', onActivity);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const recycle = setTimeout(() => { res.write('event: bye\ndata: {}\n\n'); res.end(); }, 5 * 60_000);
    req.on('close', () => { bus.off('activity', onActivity); clearInterval(ping); clearTimeout(recycle); });
  });

  api.get('/guilds/:guildId/activity', (req, res) => {
    const f = audit.parseFilters(req.query);
    const page = pageOf(f.page, 1);
    const { total, rows } = store.listActivity(req.guild.id, f, { limit: 25, offset: (page - 1) * 25 });
    res.json({ rows: rows.map(audit.shapeRow), total, page, pages: Math.max(1, Math.ceil(total / 25)) });
  });

  // ----- bulk send -----
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.bulk.maxFileBytes, files: config.bulk.maxFiles },
    defParamCharset: 'utf8',
  });
  const jobs = new Map();
  setInterval(() => { const old = Date.now() - 3600_000; for (const [id, j] of jobs) if (j.status !== 'running' && j.createdAt < old) jobs.delete(id); }, 600_000).unref();

  api.post('/guilds/:guildId/bulk', (req, res, next) => upload.array('files', config.bulk.maxFiles)(req, res, next), async (req, res) => {
    const files = req.files ?? [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one file.' });
    const channel = SNOWFLAKE.test(req.body?.channelId || '') ? req.guild.channels.cache.get(req.body.channelId) : null;
    if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) return res.status(400).json({ error: 'Choose a text channel in this server.' });
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
    if (!channel.permissionsFor(req.guild.members.me)?.has(need)) return res.status(400).json({ error: `The bot needs View Channel, Send Messages and Attach Files in #${channel.name}.` });
    if (!channel.permissionsFor(req.member)?.has(need)) return res.status(400).json({ error: `You can't attach files in #${channel.name} yourself, so the bot won't do it for you.` });
    for (const j of jobs.values()) if (j.guildId === req.guild.id && j.status === 'running') return res.status(409).json({ error: 'A bulk send is already running in this server. Wait for it to finish.' });

    const caption = typeof req.body.caption === 'string' ? req.body.caption.slice(0, 1900) : '';
    const delaySeconds = Number(req.body.delaySeconds);
    const delayMs = Number.isFinite(delaySeconds) ? Math.min(30, Math.max(0, delaySeconds)) * 1000 : config.bulk.defaultDelayMs;

    const id = randomId().slice(0, 16);
    const job = { id, guildId: req.guild.id, status: 'running', sent: 0, failed: 0, total: files.length, messages: 0, failures: [], error: null, createdAt: Date.now() };
    jobs.set(id, job);
    res.status(202).json({ jobId: id });

    sendBulk({
      channel, caption, delayMs,
      files: files.map((f) => ({ name: f.originalname, data: f.buffer })),
      onProgress: (p) => { job.sent = p.sent; job.failed = p.failed; },
    }).then((r) => {
      Object.assign(job, { status: 'done', sent: r.sent, failed: r.failed.length, failures: r.failed, messages: r.messages });
    }).catch((err) => {
      Object.assign(job, { status: 'error', error: err.message });
    }).finally(() => {
      req.files = null;
      sendLog(req.guild, infoEmbed('Bulk send', `${req.session.user.username} sent ${job.sent} file(s) to ${channel} from the dashboard.`)).catch(() => {});
    });
  });

  api.get('/guilds/:guildId/bulk/:jobId', (req, res) => {
    const j = jobs.get(req.params.jobId);
    if (!j || j.guildId !== req.guild.id) return res.status(404).json({ error: 'That job no longer exists.' });
    const { id, guildId, createdAt, ...pub } = j;
    res.json(pub);
  });

  // ----- feature routes (all behind the guard above) -----
  require('./routes/announcements')(api, client);
  require('./routes/welcome')(api);
  require('./routes/members')(api);
  require('./routes/config')(api);
  require('./routes/analytics')(api);
  require('./routes/scheduled')(api);
  require('./routes/dashboard')(api);

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // ---------- static frontend ----------
  app.use(express.static(path.join(__dirname, '../../public'), { maxAge: '5m' }));

  // ---------- errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.end();
    if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).json({ error: 'That request is too large.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err instanceof multer.MulterError) {
      const msg = {
        LIMIT_FILE_SIZE: `A file is larger than the ${Math.round(config.bulk.maxFileBytes / 1048576)} MB limit.`,
        LIMIT_FILE_COUNT: `You can send at most ${config.bulk.maxFiles} files at a time.`,
        LIMIT_UNEXPECTED_FILE: `You can send at most ${config.bulk.maxFiles} files at a time.`,
      }[err.code] || 'The upload was rejected.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
    }
    console.error('[web]', err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createServer };
