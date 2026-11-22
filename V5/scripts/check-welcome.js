'use strict';
/* Offline self-test for Stage 6: variables, config sanitizing, message/image layout, join/leave automation, audit + event logs.
   Uses a fake Discord client (and stubs discord.js / better-sqlite3 only when they are not installed). Does NOT touch real Discord. */
const assert = require('assert');
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wel-'));
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  try { return realLoad.call(this, req, ...rest); } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    if (req === 'dotenv') return { config() {} };
    if (req === '@napi-rs/canvas') throw e;
    if (req === 'discord.js') {
      class Chain { constructor() { this.d = {}; } }
      for (const m of ['setColor', 'setTitle', 'setDescription', 'setFooter', 'setTimestamp', 'addFields']) Chain.prototype[m] = function () { return this; };
      return { EmbedBuilder: Chain, AttachmentBuilder: class { constructor(b, o) { this.attachment = b; this.name = o?.name; } },
        PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, EmbedLinks: 4n, AttachFiles: 8n, ManageRoles: 16n, KickMembers: 32n, ModerateMembers: 64n } };
    }
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

const F = require('../src/utils/welcomefmt');
const { getSettings, saveSettings, sanitizeSettings } = require('../src/settings');
const W = require('../src/welcome');
const { db } = require('../src/db');
const P = require('discord.js').PermissionFlagsBits;

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); n++; };

(async () => {
  // ---------- variables ----------
  const ctx = { id: '111111111111111111', username: 'luna', createdAt: Date.UTC(2020, 0, 5), joinedAt: Date.UTC(2026, 10, 23), guildName: 'Moon HQ', memberCount: 42 };
  eq('all variables', F.render('{user}|{username}|{userid}|{server}|{membercount}|{createdate}|{joineddate}', ctx), '<@111111111111111111>|luna|111111111111111111|Moon HQ|42|5 Jan 2020|23 Nov 2026');
  eq('legacy {count} alias', F.render('#{count}', ctx), '#42');
  eq('plain mode has no mention', F.render('{user}', ctx, { plain: true }), 'luna');
  eq('unknown joined date', F.render('{joineddate}', { ...ctx, joinedAt: null }), 'unknown');
  eq('unknown variables untouched', F.render('{nope} {user}x', ctx, { plain: true }), '{nope} lunax');
  eq('variable reference list', F.VARIABLES.map((v) => v[0]), ['{user}', '{username}', '{userid}', '{server}', '{membercount}', '{createdate}', '{joineddate}']);

  // ---------- sanitizing ----------
  const dw = F.DEFAULT_WELCOME;
  let w = F.sanitizeWelcome({ enabled: true, channelId: 'abc', message: 'x'.repeat(5000), type: 'bogus', embed: { color: 'red', title: 't' }, randomMessages: Array(30).fill('hi').concat(['  ', 5]), image: { template: 'nope', bgColor: '#zzzzzz', offsetY: 999, hasBackground: true } }, dw);
  ok('enabled kept', w.enabled === true); ok('bad channel keeps old', w.channelId === null); ok('message capped', w.message.length === 1000);
  ok('bad type keeps default', w.type === 'text'); ok('bad color rejected', w.embed.color === '#8B5CF6'); ok('title applied', w.embed.title === 't');
  ok('random templates capped to 10', w.randomMessages.length === 10); ok('bad image template rejected', w.image.template === 'classic');
  ok('bad hex rejected', w.image.bgColor === dw.image.bgColor); ok('offset clamped', w.image.offsetY === 30); ok('hasBackground cannot be set by client', w.image.hasBackground === false);
  const a = F.sanitizeJoinAutomation({ verificationRoleId: '222222222222222222', newAccount: { enabled: true, days: 9999, action: 'ban' } }, F.DEFAULT_JOIN_AUTOMATION);
  ok('days clamped', a.newAccount.days === 365); ok('bad action rejected', a.newAccount.action === 'warn'); ok('role kept', a.verificationRoleId === '222222222222222222');

  // ---------- messages ----------
  const wt = { ...dw, type: 'both', embed: { ...dw.embed, useImage: true }, random: true, randomMessages: ['A {user}', 'B {user}'] };
  const m1 = F.buildMessage(wt, ctx, { hasImage: true, avatarUrl: 'https://x/a.png', rnd: () => 0.9 });
  ok('random picks template', m1.content === 'B <@111111111111111111>'); ok('embed title plain', m1.embeds[0].title === 'Welcome, luna!');
  ok('thumbnail = avatar', m1.embeds[0].thumbnail.url === 'https://x/a.png'); ok('embed uses attached image', m1.embeds[0].image.url === 'attachment://welcome.png');
  ok('only the new member can be pinged', m1.allowedMentions.users.length === 1 && m1.allowedMentions.users[0] === ctx.id && !m1.allowedMentions.parse);
  const m2 = F.buildMessage({ ...dw, type: 'text' }, ctx, { hasImage: true });
  ok('text mode + image => attach as file', m2.imageAsFile === true && !m2.embeds);
  ok('legacy default message renders', F.buildMessage(dw, ctx).content === 'Welcome <@111111111111111111> to **Moon HQ**! You are member #42.');

  // ---------- image layout ----------
  const L1 = F.imageLayout({ ...dw.image, template: 'classic', align: 'center', offsetY: 0 });
  ok('classic centered', L1.textAlign === 'center' && L1.avatar.x === 500);
  const L2 = F.imageLayout({ ...dw.image, template: 'banner', offsetY: 0 });
  ok('banner left', L2.textAlign === 'left' && L2.avatar.x < L2.textX);
  const L3 = F.imageLayout({ ...dw.image, template: 'minimal', align: 'center', offsetY: 10 });
  ok('minimal has no avatar', L3.avatar === null); ok('offset moves text down', L3.titleY > F.imageLayout({ ...dw.image, template: 'minimal', offsetY: 0 }).titleY);

  // ---------- settings persistence ----------
  const G = '900000000000000001';
  db.prepare('INSERT OR REPLACE INTO settings (guild_id, data) VALUES (?, ?)').run(G, JSON.stringify({ welcome: { enabled: true, channelId: '300000000000000001', message: 'old {count}' } }));
  const old = getSettings(G);
  ok('old stored settings still load', old.welcome.enabled && old.welcome.message === 'old {count}' && old.goodbye.enabled === false && old.joinAutomation.newAccount.days === 7);
  const next = sanitizeSettings({ automod: { raid: { action: 'timeout' } }, goodbye: { enabled: true } }, old);
  ok('raid timeout accepted', next.automod.raid.action === 'timeout'); ok('welcome preserved when omitted', next.welcome.message === 'old {count}' && next.goodbye.enabled === true);
  saveSettings(G, next); ok('persisted', getSettings(G).goodbye.enabled === true);

  // ---------- fake Discord ----------
  const perms = (list) => ({ has: (p) => list === 'all' || list.includes(p) });
  const mkChannel = (id, name, list = 'all') => { const sent = []; return { id, name, sent, isTextBased: () => true, permissionsFor: () => perms(list), send: async (p) => { sent.push(p); } }; };
  const mkGuild = (id, { botPerms = 'all', botPos = 10 } = {}) => {
    const g = { id, name: 'Moon HQ', memberCount: 10, channels: { cache: new Map() }, roles: { cache: new Map() }, members: { me: { permissions: perms(botPerms), roles: { highest: { position: botPos } } } } };
    return g;
  };
  const addRole = (g, id, name, position, managed = false) => g.roles.cache.set(id, { id, name, position, managed });
  const mkMember = (g, id, name, { ageDays = 400, dmFails = false, kickable = true } = {}) => {
    const calls = { roles: [], kicked: null, timeout: null, dms: [] };
    return { id, guild: g, joinedTimestamp: Date.now(), calls, kickable, moderatable: kickable, toString: () => `<@${id}>`,
      user: { id, username: name, createdTimestamp: Date.now() - ageDays * 86400000, displayAvatarURL: () => 'https://cdn/a.png' },
      roles: { add: async (r) => { calls.roles.push(r); } },
      send: async (p) => { if (dmFails) throw new Error('closed'); calls.dms.push(p); },
      kick: async (r) => { calls.kicked = r; }, timeout: async (ms) => { calls.timeout = ms; } };
  };
  const g = mkGuild(G);
  const wch = mkChannel('300000000000000001', 'welcome'); const gch = mkChannel('300000000000000002', 'goodbye'); const lch = mkChannel('300000000000000003', 'logs');
  [wch, gch, lch].forEach((c) => g.channels.cache.set(c.id, c));
  addRole(g, '400000000000000001', 'Member', 5); addRole(g, '400000000000000002', 'Unverified', 4); addRole(g, '400000000000000003', 'Admin', 20);
  const cfg = () => getSettings(G);
  const setCfg = (fn) => { const s = cfg(); fn(s); saveSettings(G, s); };
  setCfg((s) => { s.welcome = { ...s.welcome, enabled: true, channelId: wch.id, type: 'both', message: 'Welcome {user} to {server}', dm: { enabled: true, message: 'Hi {username} from {server}' } }; s.goodbye = { ...s.goodbye, enabled: true, channelId: gch.id }; s.autoRoleId = '400000000000000001'; s.logChannelId = lch.id; });

  // ---------- join ----------
  const m = mkMember(g, '500000000000000001', 'alice');
  await W.handleJoin(m);
  ok('welcome sent to channel', wch.sent.length === 1 && wch.sent[0].content.includes('<@500000000000000001>') && wch.sent[0].embeds[0].title === 'Welcome, alice!');
  ok('auto role assigned', m.calls.roles[0] === '400000000000000001');
  ok('DM sent with variables', m.calls.dms[0].content === 'Hi alice from Moon HQ');
  ok('join event logged', W.listEvents(G, { type: 'join' }).rows[0].user_id === '500000000000000001');
  ok('audit trail has role + welcome + dm', ['role', 'welcome', 'dm'].every((k) => W.listAudit(G).rows.some((r) => r.kind === k && r.ok === 1)));

  const m2x = mkMember(g, '500000000000000002', 'bob', { dmFails: true });
  await W.handleJoin(m2x);
  ok('closed DM audited as failure, join continues', W.listAudit(G).rows.some((r) => r.kind === 'dm' && r.ok === 0) && wch.sent.length === 2);

  // role hierarchy problem
  setCfg((s) => { s.autoRoleId = '400000000000000003'; });
  const m3 = mkMember(g, '500000000000000003', 'carol'); await W.handleJoin(m3);
  ok('role above bot is NOT assigned and audited', m3.calls.roles.length === 0 && W.listAudit(G).rows.some((r) => r.kind === 'role' && r.ok === 0 && /highest role must be above/.test(r.detail)));
  ok('welcome still sent despite role failure', wch.sent.length === 3);

  // new account + verification role
  setCfg((s) => { s.autoRoleId = '400000000000000001'; s.joinAutomation = { ...s.joinAutomation, verificationRoleId: '400000000000000002', newAccount: { enabled: true, days: 7, action: 'warn' } }; });
  const young = mkMember(g, '500000000000000004', 'newbie', { ageDays: 2 }); await W.handleJoin(young);
  ok('new account gets verification role instead of auto role', young.calls.roles.length === 1 && young.calls.roles[0] === '400000000000000002');
  ok('new-account warning posted to log channel + audited', lch.sent.length >= 1 && W.listAudit(G).rows.some((r) => r.kind === 'newaccount'));
  const old1 = mkMember(g, '500000000000000005', 'vet', { ageDays: 900 }); await W.handleJoin(old1);
  ok('old account gets the normal auto role', old1.calls.roles[0] === '400000000000000001');
  setCfg((s) => { s.joinAutomation.newAccount.action = 'kick'; });
  const k1 = mkMember(g, '500000000000000006', 'kickme', { ageDays: 1 }); const before = wch.sent.length; await W.handleJoin(k1);
  ok('new-account kick applied, no welcome', k1.calls.kicked && wch.sent.length === before);
  const k2 = mkMember(g, '500000000000000007', 'unkickable', { ageDays: 1, kickable: false }); await W.handleJoin(k2);
  ok('kick skipped safely when not kickable (audited)', !k2.calls.kicked && W.listAudit(G).rows.some((r) => /Kick skipped/.test(r.detail) && r.ok === 0));

  // ---------- raid actions ----------
  const r1 = mkMember(g, '500000000000000008', 'raid1');
  ok('raid kick works', (await W.applyRaidAction(r1, 'kick')) === true && !!r1.calls.kicked);
  const r2 = mkMember(g, '500000000000000009', 'raid2'); ok('raid timeout = 10 min', (await W.applyRaidAction(r2, 'timeout')) && r2.calls.timeout === 600000);
  const r3 = mkMember(g, '500000000000000010', 'raid3', { kickable: false }); ok('raid action refused when unmanageable, audited', (await W.applyRaidAction(r3, 'kick')) === false && W.listAudit(G).rows.some((r) => r.kind === 'raid' && r.ok === 0));
  ok('alert-only does nothing', (await W.applyRaidAction(mkMember(g, '500000000000000011', 'x'), 'alert')) === false);
  const gNoPerm = mkGuild('900000000000000009', { botPerms: [P.ViewChannel] }); const r4 = mkMember(gNoPerm, '500000000000000012', 'y');
  ok('raid kick without Kick Members permission fails safely', (await W.applyRaidAction(r4, 'kick')) === false && !r4.calls.kicked);

  // ---------- leave / goodbye ----------
  const leaver = mkMember(g, '500000000000000001', 'alice'); await W.handleLeave(leaver);
  ok('goodbye posted', gch.sent.length === 1 && gch.sent[0].content.includes('alice'));
  ok('leave event logged', W.listEvents(G, { type: 'leave' }).rows[0].user_id === '500000000000000001');
  setCfg((s) => { s.goodbye.enabled = false; }); await W.handleLeave(mkMember(g, '500000000000000013', 'z'));
  ok('goodbye disabled => nothing sent but leave still logged', gch.sent.length === 1 && W.listEvents(G, { type: 'leave' }).total === 2);
  setCfg((s) => { s.joinAutomation.logJoinLeave = false; }); const tot = W.listEvents(G).total; await W.handleLeave(mkMember(g, '500000000000000014', 'q'));
  ok('event logging can be switched off', W.listEvents(G).total === tot); setCfg((s) => { s.joinAutomation.logJoinLeave = true; });

  // ---------- test messages + permission failures ----------
  const staff = mkMember(g, '600000000000000001', 'staffer'); const sb = wch.sent.length;
  await W.sendTest(g, staff, 'welcome'); ok('test welcome posts to channel and is audited as test', wch.sent.length === sb + 1 && W.listAudit(G).rows.some((r) => r.kind === 'test'));
  setCfg((s) => { s.goodbye.enabled = true; }); await W.sendTest(g, staff, 'goodbye'); ok('test goodbye posts', gch.sent.length === 2);
  let err; try { await W.sendTest(g, staff, 'nope'); } catch (e) { err = e; } ok('unknown kind rejected', err instanceof W.WelcomeError);
  const noSend = mkChannel('300000000000000004', 'locked', [P.ViewChannel]); g.channels.cache.set(noSend.id, noSend);
  setCfg((s) => { s.welcome.channelId = noSend.id; }); err = null; try { await W.sendTest(g, staff, 'welcome'); } catch (e) { err = e; }
  ok('missing channel permission gives clear error and sends nothing', err instanceof W.WelcomeError && /missing SendMessages/.test(err.message) && noSend.sent.length === 0);
  setCfg((s) => { s.welcome.channelId = null; }); err = null; try { await W.sendTest(g, staff, 'welcome'); } catch (e) { err = e; } ok('no channel selected', /no channel/.test(err?.message));
  setCfg((s) => { s.welcome.channelId = wch.id; });

  // image enabled but renderer unavailable: message still goes out, failure audited, nothing faked
  if (!W.image.available()) {
    setCfg((s) => { s.welcome.image.enabled = true; }); const sb2 = wch.sent.length; await W.handleJoin(mkMember(g, '500000000000000020', 'imgtest', { ageDays: 900 }));
    ok('no renderer: welcome sent without fake image + failure audited', wch.sent.length === sb2 + 1 && !wch.sent[wch.sent.length - 1].files && W.listAudit(G).rows.some((r) => r.kind === 'image' && r.ok === 0));
    let e2; try { await W.previewImage(g, staff); } catch (e) { e2 = e; } ok('preview refuses without renderer', !!e2);
    setCfg((s) => { s.welcome.image.enabled = false; });
  }

  // ---------- warnings ----------
  const warn = W.configWarnings(g, (() => { const s = cfg(); s.autoRoleId = '400000000000000003'; s.welcome.channelId = noSend.id; return s; })());
  ok('warnings: role hierarchy + channel perms', warn.some((x) => /Auto role/.test(x)) && warn.some((x) => /Welcome channel.*SendMessages/.test(x)));
  ok('warnings: none for a healthy config', W.configWarnings(g, (() => { const s = cfg(); s.joinAutomation.newAccount.action = 'warn'; s.autoRoleId = '400000000000000001'; s.joinAutomation.verificationRoleId = '400000000000000002'; return s; })()).length === 0);
  ok('diffKeys detects changes', W.diffKeys({ welcome: 1, goodbye: 1 }, { welcome: 2, goodbye: 1 }).join() === 'welcome');

  // ---------- background upload validation ----------
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  W.saveBackground(G, png); ok('png background stored', W.readBackground(G).equals(png));
  let e3; try { W.saveBackground(G, Buffer.from('<svg onload=alert(1)></svg>aaaaaaaaaaaa')); } catch (e) { e3 = e; } ok('non-image rejected', e3 instanceof W.WelcomeError);
  e3 = null; try { W.saveBackground(G, Buffer.concat([png, Buffer.alloc(2 * 1048576)])); } catch (e) { e3 = e; } ok('oversized rejected', /2 MB/.test(e3?.message));
  W.removeBackground(G); ok('background removed', W.readBackground(G) === null);

  // ---------- guild isolation + paging ----------
  const G2 = '900000000000000002'; const g2 = mkGuild(G2); await W.handleJoin(mkMember(g2, '700000000000000001', 'other'));
  ok('events isolated per guild', W.listEvents(G2).total === 1 && W.listEvents(G, { type: 'join' }).rows.every((r) => r.guild_id === G));
  ok('audit isolated per guild', W.listAudit(G2).rows.every((r) => r.guild_id === G2));
  ok('paging works', W.listEvents(G, { page: 1, limit: 3 }).rows.length === 3 && W.listEvents(G, { page: 2, limit: 3 }).rows[0].id < W.listEvents(G, { page: 1, limit: 3 }).rows[2].id);
  ok('week counters', W.listEvents(G).week.joins >= 5 && W.listEvents(G).week.leaves >= 2);

  console.log(`welcome: ${n} checks passed`);
})().catch((e) => { console.error('FAILED:', e.message); console.error(e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); });
