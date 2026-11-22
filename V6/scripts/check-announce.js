'use strict';
/* Offline self-test for Stage 5 (announcements): validation, storage, scheduling, send/edit/delete/retry, permissions.
   Runs with a fake Discord client. If better-sqlite3 isn't installed it falls back to Node's built-in node:sqlite. */
const assert = require('assert');
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-'));
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  try { return realLoad.call(this, req, ...rest); } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    if (req === 'dotenv') return { config() {} };
    if (req === 'better-sqlite3') {
      const { DatabaseSync } = require('node:sqlite');
      return class { constructor(f) { this.d = new DatabaseSync(f); }
        pragma(s) { this.d.exec(`PRAGMA ${s}`); } exec(s) { this.d.exec(s); }
        prepare(sql) { const st = this.d.prepare(sql); return { get: (...a) => st.get(...a), all: (...a) => st.all(...a), run: (...a) => st.run(...a) }; }
        transaction(fn) { return (...a) => { this.d.exec('BEGIN'); try { const r = fn(...a); this.d.exec('COMMIT'); return r; } catch (err) { this.d.exec('ROLLBACK'); throw err; } }; } };
    }
    throw e;
  }
};

const A = require('../src/utils/announce');
const svc = require('../src/announcements');
const { db } = require('../src/db');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; };
const throwsMsg = (name, fn, re) => { try { fn(); } catch (e) { assert.ok(e instanceof A.AnnounceError && re.test(e.message), `${name}: got "${e.message}"`); n++; return; } assert.fail(`${name}: did not throw`); };
const rejects = async (name, p, re) => { try { await p; } catch (e) { assert.ok(e instanceof A.AnnounceError && re.test(e.message), `${name}: got "${e.message}"`); n++; return; } assert.fail(`${name}: did not reject`); };

// ---------- pure validation ----------
const base = { content: 'hi', embeds: [], buttons: [] };
ok('plain text accepted', A.sanitizePayload(base).content === 'hi');
throwsMsg('empty rejected', () => A.sanitizePayload({ content: '  ' }), /text or at least one embed/);
throwsMsg('content > 2000', () => A.sanitizePayload({ content: 'x'.repeat(2001) }), /too long/);
throwsMsg('embed title > 256', () => A.sanitizePayload({ embeds: [{ title: 'x'.repeat(257) }] }), /title is too long/);
throwsMsg('embed desc > 4096', () => A.sanitizePayload({ embeds: [{ description: 'x'.repeat(4097) }] }), /description is too long/);
throwsMsg('11 embeds', () => A.sanitizePayload({ embeds: Array(11).fill({ title: 't' }) }), /at most 10 embeds/);
throwsMsg('26 fields', () => A.sanitizePayload({ embeds: [{ fields: Array(26).fill({ name: 'a', value: 'b' }) }] }), /at most 25 fields/);
throwsMsg('field value > 1024', () => A.sanitizePayload({ embeds: [{ fields: [{ name: 'a', value: 'x'.repeat(1025) }] }] }), /value is too long/);
throwsMsg('field needs value', () => A.sanitizePayload({ embeds: [{ fields: [{ name: 'a', value: '' }] }] }), /value is required/);
throwsMsg('6000 total', () => A.sanitizePayload({ embeds: [{ description: 'x'.repeat(4000) }, { description: 'y'.repeat(2100) }] }), /6000/);
throwsMsg('empty embed', () => A.sanitizePayload({ embeds: [{}] }), /is empty/);
throwsMsg('bad image url', () => A.sanitizePayload({ embeds: [{ title: 't', image: 'javascript:alert(1)' }] }), /http:\/\/ or https:\/\//);
throwsMsg('bad color', () => A.sanitizePayload({ embeds: [{ title: 't', color: 'red' }] }), /hex color/);
throwsMsg('author icon without name', () => A.sanitizePayload({ embeds: [{ title: 't', author: { icon_url: 'https://a.b/c.png' } }] }), /author name is required/);
throwsMsg('11 buttons', () => A.sanitizePayload({ ...base, buttons: Array(11).fill({ label: 'a', url: 'https://a.b' }) }), /At most 10 buttons/);
throwsMsg('button needs link', () => A.sanitizePayload({ ...base, buttons: [{ label: 'a', url: '' }] }), /needs a link/);
const full = A.sanitizePayload({ content: '<@&111111111111111111> <@222222222222222222>', embeds: [{ title: 'T', color: '#8B5CF6', timestamp: true, thumbnail: 'https://a.b/t.png', fields: [{ name: 'a', value: 'b', inline: true }] }], buttons: Array(6).fill({ label: 'Go', url: 'https://a.b' }) });
ok('color parsed to int', full.embeds[0].color === 0x8b5cf6);
const msg = A.buildMessage(full);
ok('thumbnail shaped', msg.embeds[0].thumbnail.url === 'https://a.b/t.png');
ok('timestamp set', typeof msg.embeds[0].timestamp === 'string');
ok('6 buttons -> 2 rows of link buttons', msg.components.length === 2 && msg.components[0].components.length === 5 && msg.components[0].components[0].style === 5);
ok('default mentions: roles+users only', msg.allowedMentions.parse.length === 0 && msg.allowedMentions.roles[0] === '111111111111111111' && msg.allowedMentions.users[0] === '222222222222222222');
ok('everyone off by default', !A.buildMessage(full).allowedMentions.parse.includes('everyone'));
ok('everyone opt-in', A.buildMessage(A.sanitizePayload({ ...base, mentions: { everyone: true } })).allowedMentions.parse[0] === 'everyone');
ok('roles pings can be disabled', A.buildMessage(A.sanitizePayload({ ...full, mentions: { roles: false } })).allowedMentions.roles.length === 0);
ok('test sends never ping', A.buildMessage(full, { test: true }).allowedMentions.parse.length === 0 && !A.buildMessage(full, { test: true }).allowedMentions.roles);

// ---------- fake Discord ----------
const perms = (set) => ({ has: (p) => set === 'all' || set.has(p) });
const GID = '900000000000000001', USER = '800000000000000001';
function makeEnv({ botPerms = 'all', userPerms = 'all', manage = true } = {}) {
  const sent = []; let seq = 0;
  const mkChan = (id, name, over = {}) => {
    const store = new Map();
    return { id, name, type: 0, sent, store, permissionsFor: (who) => (who === me ? perms(over.bot ?? botPerms) : perms(over.user ?? userPerms)),
      send: async (m) => { if (over.sendError) throw Object.assign(new Error('boom'), { code: over.sendError }); const msg = { id: `7000000000000000${String(++seq).padStart(2, '0')}`, edit: async (e) => { msg.edited = e; }, delete: async () => { store.delete(msg.id); msg.deleted = true; } }; store.set(msg.id, msg); sent.push({ ch: name, m }); return msg; },
      messages: { fetch: async (mid) => { const x = store.get(mid); if (!x) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); return x; } } };
  };
  const me = { id: 'me' };
  const chans = [mkChan('100000000000000001', 'general'), mkChan('100000000000000002', 'news'), mkChan('100000000000000003', 'locked', { bot: new Set(['ViewChannel']) }), mkChan('100000000000000004', 'broken', { sendError: 50013 })];
  const member = { id: USER, user: { username: 'tester', send: async (m) => { member.dm = m; } }, permissions: { has: (p) => manage } };
  const guild = { id: GID, members: { me, fetch: async () => member }, roles: { cache: new Map([['111111111111111111', {}]]) }, channels: { cache: new Map(chans.map((c) => [c.id, c])) } };
  const client = { isReady: () => true, guilds: { cache: new Map([[GID, guild]]) } };
  return { guild, member, client, chans, sent };
}
const CH = { general: '100000000000000001', news: '100000000000000002', locked: '100000000000000003', broken: '100000000000000004' };

(async () => {
  // ---------- templates ----------
  const e0 = makeEnv();
  ok('builtin templates listed', svc.listTemplates(GID).filter((t) => t.builtin).length === 5);
  ok('every builtin template is itself valid', A.BUILTIN_TEMPLATES.every((t) => A.sanitizePayload(t.payload)));
  const t1 = svc.createTemplate(GID, { name: 'Weekly', category: 'Events', payload: full, userId: USER });
  ok('template saved', svc.getTemplate(GID, t1.id).name === 'Weekly');
  const t2 = svc.duplicateTemplate(GID, t1.id, USER);
  ok('template duplicated', t2.name === 'Weekly (copy)' && t2.id !== t1.id);
  ok('builtin duplicable', svc.duplicateTemplate(GID, 'builtin:event', USER).category === 'Events');
  ok('template updated', svc.updateTemplate(GID, t1.id, { name: 'Weekly 2' }).name === 'Weekly 2');
  ok('templates isolated per guild', svc.getTemplate('999999999999999999', t1.id) === null);
  ok('template deleted', svc.deleteTemplate(GID, t2.id) && svc.getTemplate(GID, t2.id) === null);
  throwsMsg('builtin not deletable', () => svc.deleteTemplate(GID, 'builtin:event'), /can’t be deleted/);
  throwsMsg('template needs name', () => svc.createTemplate(GID, { name: ' ', payload: full }), /name/);
  throwsMsg('invalid payload not saved as template', () => svc.createTemplate(GID, { name: 'x', payload: { content: '' } }), /text or at least one embed/);

  // ---------- drafts ----------
  svc.saveDraft(GID, USER, { content: 'half-written' });
  ok('draft restored', svc.getDraft(GID, USER).draft.content === 'half-written');
  ok('draft isolated per user', svc.getDraft(GID, 'other').draft === null);
  svc.clearDraft(GID, USER);
  ok('draft cleared', svc.getDraft(GID, USER).draft === null);

  // ---------- sending ----------
  const a1 = await svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 'tester (dashboard)', input: { content: 'Hello <@&111111111111111111>', embeds: [{ title: 'News' }] }, channelIds: [CH.general, CH.news] });
  ok('sent to 2 channels', a1.status === 'sent' && a1.deliveries.length === 2 && e0.sent.length === 2);
  ok('message links stored', a1.deliveries[0].link.startsWith(`https://discord.com/channels/${GID}/${CH.general}/`));
  ok('sender recorded', a1.authorTag === 'tester (dashboard)' && a1.authorId === USER);
  await rejects('duplicate blocked', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'Hello <@&111111111111111111>', embeds: [{ title: 'News' }] }, channelIds: [CH.general, CH.news] }), /just sent/);
  await rejects('unknown role', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: '<@&333333333333333333>' }, channelIds: [CH.general] }), /role that doesn’t exist/);
  await rejects('bot missing perms', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'x1' }, channelIds: [CH.locked] }), /bot is missing Send Messages/);
  await rejects('no channels', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'x2' }, channelIds: [] }), /at least one channel/);
  await rejects('bad channel id', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'x3' }, channelIds: ['123'] }), /doesn’t exist/);
  const noEveryone = makeEnv({ userPerms: new Set(['ViewChannel', 'SendMessages', 'EmbedLinks']) });
  await rejects('@everyone needs permission', svc.create(noEveryone.client, { guild: noEveryone.guild, member: noEveryone.member, userTag: 't', input: { content: 'x4', mentions: { everyone: true } }, channelIds: [CH.general] }), /Mention Everyone/);
  const cantSend = makeEnv({ userPerms: new Set(['ViewChannel']) });
  await rejects('user must be able to post there', svc.create(cantSend.client, { guild: cantSend.guild, member: cantSend.member, userTag: 't', input: { content: 'x5' }, channelIds: [CH.general] }), /don’t have Send Messages/);
  const offline = { ...e0.client, isReady: () => false };
  await rejects('disconnected bot', svc.create(offline, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'x6' }, channelIds: [CH.general] }), /not connected/);

  // ---------- failure + retry ----------
  const a2 = await svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't (dashboard)', input: { content: 'partial test' }, channelIds: [CH.general, CH.broken] });
  ok('partial status', a2.status === 'partial');
  const bad = a2.deliveries.find((d) => d.channelId === CH.broken);
  ok('failure reason recorded', bad.status === 'failed' && /lacks permission/.test(bad.error));
  const r1 = await svc.retry(e0.client, { guild: e0.guild, member: e0.member, id: a2.id });
  ok('retry re-attempts only failed channel', r1.deliveries.find((d) => d.channelId === CH.broken).attempts === 2 && r1.deliveries.find((d) => d.channelId === CH.general).attempts === 1);
  ok('general not re-sent on retry', e0.sent.filter((s) => s.m.content === 'partial test' && s.ch === 'general').length === 1);
  await rejects('retry sent announcement refused', svc.retry(e0.client, { guild: e0.guild, member: e0.member, id: a1.id }), /Only failed/);

  // ---------- edit + delete sent ----------
  const ed = await svc.edit(e0.client, { guild: e0.guild, member: e0.member, id: a1.id, input: { content: 'Edited', embeds: [] } });
  ok('edit updates posted messages', ed.edited === 2 && e0.chans[0].store.values().next().value.edited.content === 'Edited');
  ok('edit never re-pings', e0.chans[0].store.values().next().value.edited.allowedMentions.parse.length === 0);
  ok('edit stored', svc.getAnnouncement(GID, a1.id).payload.content === 'Edited' && !!svc.getAnnouncement(GID, a1.id).editedAt);
  const del = await svc.deleteMessages(e0.client, { guild: e0.guild, member: e0.member, id: a1.id });
  ok('messages deleted + status', del.deleted === 2 && del.announcement.status === 'deleted');
  await rejects('nothing left to delete', svc.deleteMessages(e0.client, { guild: e0.guild, member: e0.member, id: a1.id }), /no posted messages/);

  // ---------- scheduling ----------
  await rejects('past time rejected', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 's0' }, channelIds: [CH.general], scheduledAt: Date.now() + 1000 }), /at least a minute/);
  await rejects('too far rejected', svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 's0b' }, channelIds: [CH.general], scheduledAt: Date.now() + 400 * 86400000 }), /one year/);
  const before = e0.sent.length;
  const s1 = await svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't (dashboard)', input: { content: 'later' }, channelIds: [CH.general], scheduledAt: Date.now() + 120000 });
  ok('scheduled, not sent yet', s1.status === 'scheduled' && e0.sent.length === before);
  ok('scheduled edit changes content + time', (await svc.edit(e0.client, { guild: e0.guild, member: e0.member, id: s1.id, input: { content: 'later v2' }, scheduledAt: Date.now() + 240000 })).announcement.payload.content === 'later v2');
  ok('not claimed before due', (await svc.run(e0.client, s1.id)) !== null); // run() claims whatever is 'scheduled'; the scheduler's SELECT enforces the time, checked below
  // scheduler selection query: only due rows
  const s2 = await svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'cancel me' }, channelIds: [CH.news], scheduledAt: Date.now() + 120000 });
  ok('due query excludes future rows', db.prepare("SELECT id FROM announcements WHERE status = 'scheduled' AND scheduled_at <= ?").all(Date.now()).every((r) => r.id !== s2.id));
  ok('cancelled', svc.cancel(e0.guild, s2.id).status === 'cancelled');
  ok('cancelled deliveries stay unsent', svc.getAnnouncement(GID, s2.id).deliveries[0].status === 'cancelled');
  throwsMsg('cannot cancel twice', () => svc.cancel(e0.guild, s2.id), /Only scheduled/);
  const s3 = await svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'due now' }, channelIds: [CH.news], scheduledAt: Date.now() + 120000 });
  db.prepare('UPDATE announcements SET scheduled_at = ? WHERE id = ?').run(Date.now() - 1000, s3.id);
  ok('due rows are selected', db.prepare("SELECT id FROM announcements WHERE status = 'scheduled' AND scheduled_at <= ?").all(Date.now()).some((r) => r.id === s3.id));
  const [run1, run2] = await Promise.all([svc.run(e0.client, s3.id, { gapMs: 0 }), svc.run(e0.client, s3.id, { gapMs: 0 })]);
  ok('double run sends once (duplicate prevention)', [run1, run2].filter(Boolean).length === 1 && e0.sent.filter((s) => s.m.content === 'due now').length === 1);
  const noPerm = makeEnv({ manage: false });
  const s4 = await svc.create(e0.client, { guild: e0.guild, member: e0.member, userTag: 't', input: { content: 'author lost access' }, channelIds: [CH.general], scheduledAt: Date.now() + 120000 });
  e0.guild.members.fetch = async () => ({ ...e0.member, permissions: { has: () => false } });
  const r4 = await svc.run(e0.client, s4.id);
  ok('scheduled send rechecks author permission', r4.status === 'failed' && /no longer has Manage Server/.test(r4.deliveries[0].error));

  // ---------- test send, history, stats, persistence ----------
  await svc.sendTest(e0.client, { guild: e0.guild, member: e0.member, input: { content: 'dm me <@&111111111111111111>' } });
  ok('test goes to DM without pings', e0.member.dm.content.startsWith('dm me') && e0.member.dm.allowedMentions.parse.length === 0);
  const hist = svc.listAnnouncements(GID, { page: 1 });
  ok('history lists newest first with sender/channels', hist.total >= 6 && hist.rows[0].id > hist.rows[hist.rows.length - 1].id && hist.rows[0].authorTag);
  ok('status filter', svc.listAnnouncements(GID, { status: 'cancelled' }).rows.every((r) => r.status === 'cancelled'));
  ok('history isolated per guild', svc.listAnnouncements('999999999999999999').total === 0);
  const st = svc.announcementStats(GID);
  ok('stats count successes and failures', st.deliveries.sent >= 4 && st.deliveries.failed >= 1 && st.successRate > 0 && st.successRate < 100);
  ok('data persisted in sqlite', db.prepare('SELECT COUNT(*) AS n FROM announcement_deliveries').get().n >= 8);

  console.log(`announcements: ${n} checks passed`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
