'use strict';
/* Announcement payload validation + Discord message building. Pure (no discord.js, no database) so it is unit-testable.
   A "payload" is what the editor produces:
   { content, embeds: [embed], buttons: [{label,url}], mentions: {everyone, roles, users} } */

const LIMITS = {
  content: 2000, embeds: 10, embedTotal: 6000, title: 256, description: 4096, authorName: 256, footerText: 2048,
  fields: 25, fieldName: 256, fieldValue: 1024, buttons: 10, buttonLabel: 80, url: 2000, channels: 10, templateName: 80,
};
const CATEGORIES = ['General', 'Events', 'Updates', 'Rules', 'Giveaways', 'Custom'];

class AnnounceError extends Error {}
const fail = (msg) => { throw new AnnounceError(msg); };

const SNOWFLAKE = /^\d{17,20}$/;
const str = (v, max, label, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) fail(`${label} is required.`); return undefined; }
  if (typeof v !== 'string') fail(`${label} must be text.`);
  if (v.length > max) fail(`${label} is too long (${v.length}/${max}).`);
  return v;
};
function url(v, label) {
  const s = str(v, LIMITS.url, label);
  if (!s) return undefined;
  let u;
  try { u = new URL(s); } catch { fail(`${label} is not a valid URL.`); }
  if (!['http:', 'https:'].includes(u.protocol)) fail(`${label} must start with http:// or https://.`);
  return u.toString();
}
function color(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) return v;
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v)) return parseInt(v.replace('#', ''), 16);
  return fail('Embed color must be a hex color like #8B5CF6.');
}

function sanitizeEmbed(e, i) {
  const n = `Embed ${i + 1}`;
  if (!e || typeof e !== 'object') fail(`${n} is invalid.`);
  const out = {};
  const title = str(e.title, LIMITS.title, `${n} title`); if (title) out.title = title;
  const description = str(e.description, LIMITS.description, `${n} description`); if (description) out.description = description;
  const tUrl = url(e.url, `${n} title link`); if (tUrl) out.url = tUrl;
  const c = color(e.color); if (c !== undefined) out.color = c;
  if (e.timestamp === true) out.timestamp = true;
  if (e.author && typeof e.author === 'object') {
    const name = str(e.author.name, LIMITS.authorName, `${n} author name`);
    const icon = url(e.author.icon_url, `${n} author icon`);
    const link = url(e.author.url, `${n} author link`);
    if (name) out.author = { name, ...(icon && { icon_url: icon }), ...(link && { url: link }) };
    else if (icon || link) fail(`${n}: an author name is required when an author icon or link is set.`);
  }
  if (e.footer && typeof e.footer === 'object') {
    const text = str(e.footer.text, LIMITS.footerText, `${n} footer`);
    const icon = url(e.footer.icon_url, `${n} footer icon`);
    if (text) out.footer = { text, ...(icon && { icon_url: icon }) };
    else if (icon) fail(`${n}: footer text is required when a footer icon is set.`);
  }
  const thumb = url(e.thumbnail, `${n} thumbnail`); if (thumb) out.thumbnail = thumb;
  const image = url(e.image, `${n} image`); if (image) out.image = image;
  if (e.fields !== undefined) {
    if (!Array.isArray(e.fields)) fail(`${n} fields are invalid.`);
    if (e.fields.length > LIMITS.fields) fail(`${n} can have at most ${LIMITS.fields} fields.`);
    out.fields = e.fields.map((f, j) => {
      if (!f || typeof f !== 'object') fail(`${n} field ${j + 1} is invalid.`);
      const name = str(f.name, LIMITS.fieldName, `${n} field ${j + 1} name`, { required: true });
      const value = str(f.value, LIMITS.fieldValue, `${n} field ${j + 1} value`, { required: true });
      return { name, value, inline: f.inline === true };
    });
    if (!out.fields.length) delete out.fields;
  }
  if (!out.title && !out.description && !out.fields && !out.image && !out.thumbnail && !out.author && !out.footer) {
    fail(`${n} is empty. Add a title, description, field or image — or remove it.`);
  }
  return out;
}

function embedChars(e) {
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.author?.name.length ?? 0) + (e.footer?.text.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/** Validate untrusted editor input and return a clean payload. Throws AnnounceError with a user-readable message. */
function sanitizePayload(input) {
  if (!input || typeof input !== 'object') fail('Nothing to send.');
  const content = str(input.content, LIMITS.content, 'Message text') ?? '';
  const embedsIn = input.embeds === undefined ? [] : input.embeds;
  if (!Array.isArray(embedsIn)) fail('Embeds are invalid.');
  if (embedsIn.length > LIMITS.embeds) fail(`An announcement can have at most ${LIMITS.embeds} embeds.`);
  const embeds = embedsIn.map(sanitizeEmbed);
  const total = embeds.reduce((n, e) => n + embedChars(e), 0);
  if (total > LIMITS.embedTotal) fail(`All embeds together can hold at most ${LIMITS.embedTotal} characters (you have ${total}).`);

  const buttonsIn = input.buttons === undefined ? [] : input.buttons;
  if (!Array.isArray(buttonsIn)) fail('Buttons are invalid.');
  if (buttonsIn.length > LIMITS.buttons) fail(`At most ${LIMITS.buttons} buttons are allowed.`);
  const buttons = buttonsIn.map((b, i) => {
    if (!b || typeof b !== 'object') fail(`Button ${i + 1} is invalid.`);
    const label = str(b.label, LIMITS.buttonLabel, `Button ${i + 1} label`, { required: true });
    const link = url(b.url, `Button ${i + 1} link`);
    if (!link) fail(`Button ${i + 1} needs a link.`);
    return { label, url: link };
  });

  const m = input.mentions && typeof input.mentions === 'object' ? input.mentions : {};
  const mentions = { everyone: m.everyone === true, roles: m.roles !== false, users: m.users !== false };

  if (!content.trim() && !embeds.length) fail('Add some message text or at least one embed.');
  return { content, embeds, buttons, mentions };
}

/** Character usage, for the editor's counters and the server-side preview check. */
function stats(payload) {
  return {
    content: payload.content?.length ?? 0,
    embedTotal: (payload.embeds ?? []).reduce((n, e) => n + embedChars(sanitizeLoose(e)), 0),
  };
}
function sanitizeLoose(e) { return { title: e?.title, description: e?.description, author: e?.author?.name ? { name: e.author.name } : undefined, footer: e?.footer?.text ? { text: e.footer.text } : undefined, fields: (e?.fields ?? []).filter((f) => f?.name && f?.value) }; }

const ids = (text, re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];

/** Turn a clean payload into options for channel.send()/message.edit(). `test` suppresses all pings. */
function buildMessage(payload, { test = false } = {}) {
  const roleIds = ids(payload.content, /<@&(\d{17,20})>/g);
  const userIds = ids(payload.content, /<@!?(\d{17,20})>/g);
  const allowedMentions = test
    ? { parse: [] }
    : { parse: payload.mentions.everyone ? ['everyone'] : [], roles: payload.mentions.roles ? roleIds : [], users: payload.mentions.users ? userIds : [] };
  const msg = { content: payload.content || null, allowedMentions };
  msg.embeds = payload.embeds.map((e) => {
    const { thumbnail, image, timestamp, ...rest } = e;
    return { ...rest, ...(thumbnail && { thumbnail: { url: thumbnail } }), ...(image && { image: { url: image } }), ...(timestamp && { timestamp: new Date().toISOString() }) };
  });
  msg.components = [];
  for (let i = 0; i < payload.buttons.length; i += 5) {
    msg.components.push({ type: 1, components: payload.buttons.slice(i, i + 5).map((b) => ({ type: 2, style: 5, label: b.label, url: b.url })) });
  }
  return msg;
}

/** Permissions the sender needs in a channel. */
function neededPermissions(payload) {
  const need = ['ViewChannel', 'SendMessages'];
  if (payload.embeds.length) need.push('EmbedLinks');
  return need;
}

const BUILTIN_TEMPLATES = [
  { id: 'builtin:general', name: 'General announcement', category: 'General', payload: { content: '', embeds: [{ title: '📢 Announcement', description: 'Write your announcement here.', color: 0x8b5cf6, timestamp: true, footer: { text: 'Server team' } }], buttons: [], mentions: { everyone: false, roles: true, users: true } } },
  { id: 'builtin:event', name: 'Event', category: 'Events', payload: { content: '', embeds: [{ title: '🎉 Upcoming event', description: 'Tell members what is happening.', color: 0x22c55e, fields: [{ name: 'When', value: 'Date and time', inline: true }, { name: 'Where', value: '#channel or place', inline: true }, { name: 'How to join', value: 'Details here', inline: false }], timestamp: true }], buttons: [], mentions: { everyone: false, roles: true, users: true } } },
  { id: 'builtin:update', name: 'Server update', category: 'Updates', payload: { content: '', embeds: [{ title: '🛠️ Server update', description: 'What changed:\n• Change one\n• Change two', color: 0x3b82f6, timestamp: true }], buttons: [], mentions: { everyone: false, roles: true, users: true } } },
  { id: 'builtin:rules', name: 'Rules reminder', category: 'Rules', payload: { content: '', embeds: [{ title: '📜 Reminder: server rules', description: '1. Be respectful\n2. No spam or advertising\n3. Follow Discord’s Terms of Service', color: 0xf59e0b }], buttons: [], mentions: { everyone: false, roles: true, users: true } } },
  { id: 'builtin:giveaway', name: 'Giveaway', category: 'Giveaways', payload: { content: '', embeds: [{ title: '🎁 Giveaway', description: 'Prize: **Prize name**\nHow to enter: describe it here.', color: 0xec4899, fields: [{ name: 'Ends', value: 'Date and time', inline: true }], timestamp: true }], buttons: [], mentions: { everyone: false, roles: true, users: true } } },
];

module.exports = { LIMITS, CATEGORIES, AnnounceError, SNOWFLAKE, sanitizePayload, buildMessage, neededPermissions, stats, BUILTIN_TEMPLATES };
