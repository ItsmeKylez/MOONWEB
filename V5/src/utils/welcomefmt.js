'use strict';
/* Stage 6 pure helpers (no Discord / DB access): variables, config defaults + sanitizing, message building, image layout. */

const SNOWFLAKE = /^\d{17,20}$/;
const VARIABLES = [
  ['{user}', 'Mentions the member (shown as plain name in titles/footers/images)'],
  ['{username}', 'The member’s username'],
  ['{userid}', 'The member’s Discord ID'],
  ['{server}', 'Server name'],
  ['{membercount}', 'Member count (alias: {count})'],
  ['{createdate}', 'Date the account was created'],
  ['{joineddate}', 'Date the member joined (“unknown” if Discord has no record)'],
];
const IMAGE_TEMPLATES = {
  classic: { label: 'Classic (centered)', align: 'center' },
  banner: { label: 'Banner (avatar left)', align: 'left' },
  minimal: { label: 'Minimal (text only)', align: 'center' },
};
const LIMITS = { message: 1000, title: 256, description: 2000, footer: 200, randomMax: 10, imageText: 80 };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown';
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** ctx: { id, username, createdAt, joinedAt, guildName, memberCount } -> string. plain=true: no <@id> mentions (titles, footers, images). */
function render(template, ctx, { plain = false } = {}) {
  const map = {
    '{user}': plain ? ctx.username : `<@${ctx.id}>`,
    '{username}': ctx.username,
    '{userid}': ctx.id,
    '{server}': ctx.guildName,
    '{membercount}': String(ctx.memberCount),
    '{count}': String(ctx.memberCount), // legacy alias, keep working
    '{createdate}': fmtDate(ctx.createdAt),
    '{joineddate}': fmtDate(ctx.joinedAt),
  };
  return String(template ?? '').replace(/\{(user|username|userid|server|membercount|count|createdate|joineddate)\}/g, (m) => map[m]);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const str = (v, d, len) => (typeof v === 'string' ? v.slice(0, len) : d);
const snow = (v, d) => (v === null || v === '' ? null : typeof v === 'string' && SNOWFLAKE.test(v) ? v : d);
const hexc = (v, d) => (typeof v === 'string' && HEX.test(v) ? v : d);
const int = (v, d, min, max) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : d; };
const oneOf = (v, d, list) => (list.includes(v) ? v : d);

const DEFAULT_EMBED = { title: '', description: '', color: '#8B5CF6', footer: '', timestamp: true, avatarThumbnail: true, useImage: false };
const DEFAULT_IMAGE = { enabled: false, template: 'classic', title: 'Welcome {username}', subtitle: 'to {server} · member #{membercount}', bgColor: '#1E1B4B', bgColor2: '#4C1D95', textColor: '#FFFFFF', accentColor: '#A78BFA', align: 'center', offsetY: 0, hasBackground: false };

const DEFAULT_WELCOME = {
  enabled: false, channelId: null,
  message: 'Welcome {user} to **{server}**! You are member #{count}.',
  type: 'text', // text | embed | both
  embed: { ...DEFAULT_EMBED, title: 'Welcome, {username}!', description: 'Glad to have you in **{server}**. You are member #{membercount}.' },
  random: false, randomMessages: [],
  dm: { enabled: false, message: 'Welcome to **{server}**, {username}! Have a look around.' },
  image: { ...DEFAULT_IMAGE },
};
const DEFAULT_GOODBYE = {
  enabled: false, channelId: null,
  message: '**{username}** has left **{server}**. We are now {membercount} members.',
  type: 'text',
  embed: { ...DEFAULT_EMBED, color: '#64748B', title: 'Goodbye, {username}', description: '{username} joined on {joineddate} and has left **{server}**.', avatarThumbnail: true },
};
const DEFAULT_JOIN_AUTOMATION = {
  verificationRoleId: null, // given INSTEAD of the auto role to flagged (new) accounts
  newAccount: { enabled: false, days: 7, action: 'warn' }, // warn = log only, kick = also kick (needs Kick Members)
  logJoinLeave: true,
};

function sanitizeEmbed(i, c) {
  i = i && typeof i === 'object' ? i : {};
  return {
    title: str(i.title, c.title, LIMITS.title), description: str(i.description, c.description, LIMITS.description),
    color: hexc(i.color, c.color), footer: str(i.footer, c.footer, LIMITS.footer),
    timestamp: bool(i.timestamp, c.timestamp), avatarThumbnail: bool(i.avatarThumbnail, c.avatarThumbnail), useImage: bool(i.useImage, c.useImage),
  };
}
function sanitizeImage(i, c) {
  i = i && typeof i === 'object' ? i : {};
  return {
    enabled: bool(i.enabled, c.enabled), template: oneOf(i.template, c.template, Object.keys(IMAGE_TEMPLATES)),
    title: str(i.title, c.title, LIMITS.imageText), subtitle: str(i.subtitle, c.subtitle, LIMITS.imageText),
    bgColor: hexc(i.bgColor, c.bgColor), bgColor2: hexc(i.bgColor2, c.bgColor2), textColor: hexc(i.textColor, c.textColor), accentColor: hexc(i.accentColor, c.accentColor),
    align: oneOf(i.align, c.align, ['left', 'center']), offsetY: int(i.offsetY, c.offsetY, -30, 30),
    hasBackground: c.hasBackground, // only changed by the upload / remove endpoints
  };
}
function sanitizeWelcome(i, c) {
  i = i && typeof i === 'object' ? i : {};
  return {
    enabled: bool(i.enabled, c.enabled), channelId: snow(i.channelId, c.channelId),
    message: str(i.message, c.message, LIMITS.message), type: oneOf(i.type, c.type, ['text', 'embed', 'both']),
    embed: sanitizeEmbed(i.embed, c.embed),
    random: bool(i.random, c.random),
    randomMessages: Array.isArray(i.randomMessages) ? i.randomMessages.map((x) => String(x).trim().slice(0, LIMITS.message)).filter(Boolean).slice(0, LIMITS.randomMax) : c.randomMessages,
    dm: { enabled: bool(i.dm?.enabled, c.dm.enabled), message: str(i.dm?.message, c.dm.message, LIMITS.message) },
    image: sanitizeImage(i.image, c.image),
  };
}
function sanitizeGoodbye(i, c) {
  i = i && typeof i === 'object' ? i : {};
  return { enabled: bool(i.enabled, c.enabled), channelId: snow(i.channelId, c.channelId), message: str(i.message, c.message, LIMITS.message),
    type: oneOf(i.type, c.type, ['text', 'embed', 'both']), embed: sanitizeEmbed(i.embed, c.embed) };
}
function sanitizeJoinAutomation(i, c) {
  i = i && typeof i === 'object' ? i : {};
  const n = i.newAccount && typeof i.newAccount === 'object' ? i.newAccount : {};
  return { verificationRoleId: snow(i.verificationRoleId, c.verificationRoleId),
    newAccount: { enabled: bool(n.enabled, c.newAccount.enabled), days: int(n.days, c.newAccount.days, 1, 365), action: oneOf(n.action, c.newAccount.action, ['warn', 'kick']) },
    logJoinLeave: bool(i.logJoinLeave, c.logJoinLeave) };
}

/** Pick the welcome text (random templates when enabled and available). */
function pickMessage(cfg, rnd = Math.random) {
  if (cfg.random && cfg.randomMessages?.length) return cfg.randomMessages[Math.floor(rnd() * cfg.randomMessages.length)];
  return cfg.message;
}

/** Build the Discord message options for welcome/goodbye. hasImage: an attachment named welcome.png will be sent. */
function buildMessage(cfg, ctx, { hasImage = false, avatarUrl = null, rnd = Math.random, isWelcome = true } = {}) {
  const out = { allowedMentions: { users: [ctx.id] } };
  const wantText = cfg.type === 'text' || cfg.type === 'both';
  const wantEmbed = cfg.type === 'embed' || cfg.type === 'both';
  const text = isWelcome ? pickMessage(cfg, rnd) : cfg.message;
  if (wantText && text) out.content = render(text, ctx).slice(0, 2000);
  if (wantEmbed) {
    const e = cfg.embed;
    const embed = { color: parseInt(e.color.slice(1), 16) };
    if (e.title) embed.title = render(e.title, ctx, { plain: true }).slice(0, 256);
    if (e.description) embed.description = render(e.description, ctx).slice(0, 4096);
    if (e.footer) embed.footer = { text: render(e.footer, ctx, { plain: true }).slice(0, 2048) };
    if (e.timestamp) embed.timestamp = new Date().toISOString();
    if (e.avatarThumbnail && avatarUrl) embed.thumbnail = { url: avatarUrl };
    if (hasImage && e.useImage) embed.image = { url: 'attachment://welcome.png' };
    if (embed.title || embed.description || embed.image) out.embeds = [embed];
  }
  if (hasImage && !out.embeds?.[0]?.image) out.imageAsFile = true; // caller attaches the PNG as a plain file
  if (!out.content && !out.embeds) out.content = render(cfg.message || 'Hello {user}', ctx).slice(0, 2000);
  return out;
}

/** Layout of the welcome image (1000x360 canvas) as plain numbers, so it can be tested and drawn by any renderer. */
function imageLayout(img) {
  const W = 1000; const H = 360;
  const left = img.template === 'banner' || img.align === 'left'; // banner always left; others follow "align"
  const hasAvatar = img.template !== 'minimal';
  const r = 90;
  const dy = (img.offsetY / 100) * H; // text/avatar block moves up (-) or down (+)
  const avatar = hasAvatar ? (left ? { x: 60 + r, y: H / 2 + dy, r } : { x: W / 2, y: 130 + dy, r }) : null;
  const textX = left ? (hasAvatar ? 60 + r * 2 + 50 : 60) : W / 2;
  const titleY = (left || !hasAvatar ? H / 2 - 10 : 130 + r + 70) + dy;
  return { W, H, avatar, textX, textAlign: left ? 'left' : 'center', titleY, subtitleY: titleY + 52, maxTextWidth: left ? W - textX - 40 : W - 120 };
}

module.exports = { SNOWFLAKE, VARIABLES, IMAGE_TEMPLATES, LIMITS, DEFAULT_WELCOME, DEFAULT_GOODBYE, DEFAULT_JOIN_AUTOMATION, fmtDate, render,
  sanitizeWelcome, sanitizeGoodbye, sanitizeJoinAutomation, pickMessage, buildMessage, imageLayout };
