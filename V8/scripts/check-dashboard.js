'use strict';
/* Offline self-test for Feature 1 (dashboard analytics): bucketing, growth, moderation analytics, staff leaderboard,
   announcement stats, recent events, live stats (fake guild), guild isolation. Fake Discord objects; stubs discord.js /
   better-sqlite3 only when they are not installed. Does NOT touch real Discord. */
const assert = require('assert');
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  try { return realLoad.call(this, req, ...rest); } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    if (req === 'dotenv') return { config() {} };
    if (req === '@napi-rs/canvas') throw e;
    if (req === 'discord.js') {
      class Chain { constructor() { this.d = {}; } }
      for (const m of ['setColor', 'setTitle', 'setDescription', 'setFooter', 'setTimestamp', 'addFields']) Chain.prototype[m] = function () { return this; };
      return { EmbedBuilder: Chain, AttachmentBuilder: class {}, PermissionFlagsBits: { ViewChannel: 1n, SendMessages: 2n, EmbedLinks: 4n, AttachFiles: 8n, ManageRoles: 16n, KickMembers: 32n, ModerateMembers: 64n } };
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

const dash = require('../src/utils/dashfmt');
const store = require('../src/db');
const { db } = store;
const svc = require('../src/dashboard');
const config = require('../src/config');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name); n++; };

const G = '111111111111111111';
const OTHER = '222222222222222222';
const MOD1 = '333333333333333331';
const MOD2 = '333333333333333332';
const BOT = '444444444444444444';
const HOUR = 3600000, DAY = 86400000;
// Fixed "now": Wed 2026-06-17 12:30 UTC
const NOW = Date.UTC(2026, 5, 17, 12, 30);

(async () => {
  // ---------- pure helpers ----------
  eq('parseRange default', dash.parseRange('nope'), '7d');
  eq('parseRange ok', dash.parseRange('90d'), '90d');
  eq('parseBucket invalid for 7d', dash.parseBucket('7d', 'month'), 'day');
  eq('parseBucket week ok for 30d', dash.parseBucket('30d', 'week'), 'week');
  eq('parseBucket 24h forced hour', dash.parseBucket('24h', 'day'), 'hour');
  eq('parseTz clamps', dash.parseTz('99999'), 840);
  eq('parseTz garbage', dash.parseTz('abc'), 0);
  let L = dash.layout({ now: NOW, range: '24h' });
  eq('24h has 24 buckets', L.buckets.length, 24);
  ok('24h last bucket is current + contains now', L.buckets[23].current && L.buckets[23].start <= NOW && L.buckets[23].end > NOW - 1);
  L = dash.layout({ now: NOW, range: '7d' });
  eq('7d has 7 buckets', L.buckets.length, 7);
  ok('7d buckets are contiguous days', L.buckets.every((b, i) => i === 0 || b.start === L.buckets[i - 1].start + DAY));
  L = dash.layout({ now: NOW, range: '30d', bucket: 'week' });
  ok('weeks cover 30 days in 5-6 buckets', L.buckets.length >= 5 && L.buckets.length <= 6);
  ok('first week flagged partial (30d does not start on Monday)', L.buckets[0].partial || new Date(L.buckets[0].start).getUTCDay() === 1);
  ok('weeks start on Monday (UTC)', L.buckets.slice(1).every((b) => new Date(b.start).getUTCDay() === 1));
  L = dash.layout({ now: NOW, range: '90d', bucket: 'month' });
  eq('90d month buckets (Mar 19..Jun 17 => Mar,Apr,May,Jun)', L.buckets.length, 4);
  ok('month buckets after first start on the 1st', L.buckets.slice(1).every((b) => new Date(b.start).getUTCDate() === 1));
  const tzL = dash.layout({ now: NOW, range: '7d', tz: 420 }); // UTC+7: local midnight = 17:00 UTC
  eq('tz shifts day boundaries', new Date(tzL.buckets[0].start).getUTCHours(), 17);
  eq('pctChange null without baseline', dash.pctChange(5, 0), null);
  eq('pctChange up', dash.pctChange(15, 10), 50);
  eq('pctChange down', dash.pctChange(5, 10), -50);
  eq('downsample keeps last', dash.downsample(Array.from({ length: 1000 }, (_, i) => i), 100).slice(-1)[0], 999);
  eq('summarizeChanges', dash.summarizeChanges(JSON.stringify([{ key: 'name' }, { key: 'permissions' }, { key: 'name' }])), 'Changed: name, permissions');
  eq('summarizeChanges garbage', dash.summarizeChanges('{not json'), null);
  eq('cleanTag', dash.cleanTag('Alice (dashboard)'), 'Alice');

  // ---------- growth: no history is not zero history ----------
  let g = svc.memberGrowth(G, { range: '7d', now: NOW });
  eq('no events: hasData false', g.coverage.hasData, false);
  ok('no events: every bucket uncovered with null counts', g.buckets.every((b) => !b.covered && b.joins === null));
  eq('no events: totals zero', g.totals.joins, 0);

  const insEv = db.prepare('INSERT INTO member_events (guild_id, user_id, user_tag, type, account_created, joined_at, created_at) VALUES (?,?,?,?,?,?,?)');
  // tracking started 3 days ago (2026-06-14 12:30); joins/leaves after that
  const t0 = NOW - 3 * DAY;
  insEv.run(G, '1', 'a', 'join', null, null, t0);
  insEv.run(G, '2', 'b', 'join', null, null, t0 + HOUR);
  insEv.run(G, '3', 'c', 'leave', null, null, t0 + 2 * HOUR);
  insEv.run(G, '4', 'd', 'join', null, null, NOW - 2 * HOUR);
  insEv.run(G, '5', 'e', 'join', null, null, NOW - 30 * 60000);
  insEv.run(OTHER, '9', 'z', 'join', null, null, NOW - 30 * 60000); // other server must never leak
  g = svc.memberGrowth(G, { range: '7d', now: NOW });
  eq('growth totals', g.totals, { joins: 4, leaves: 1, net: 3 });
  eq('hasData', g.coverage.hasData, true);
  ok('7d range is partial because tracking began 3 days ago', g.coverage.partial);
  eq('trackingSince', g.coverage.trackingSince, t0);
  const covered = g.buckets.filter((b) => b.covered);
  ok('days before tracking are uncovered (null), not zero', g.buckets[0].covered === false && g.buckets[0].joins === null);
  ok('days after tracking have numbers', covered.length >= 3 && covered.every((b) => typeof b.joins === 'number'));
  eq('sum of bucket nets equals total net', covered.reduce((a, b) => a + b.net, 0), 3);
  const g24 = svc.memberGrowth(G, { range: '24h', now: NOW });
  eq('24h totals (hourly)', g24.totals, { joins: 2, leaves: 0, net: 2 });
  eq('24h hourly buckets', g24.buckets.length, 24);
  const gO = svc.memberGrowth(OTHER, { range: '24h', now: NOW });
  eq('other guild isolated', gO.totals.joins, 1);
  const g90w = svc.memberGrowth(G, { range: '90d', bucket: 'week', now: NOW });
  eq('weekly aggregate keeps totals', g90w.totals, { joins: 4, leaves: 1, net: 3 });
  const g90m = svc.memberGrowth(G, { range: '90d', bucket: 'month', now: NOW });
  eq('monthly aggregate keeps totals', g90m.totals, { joins: 4, leaves: 1, net: 3 });
  const sm = svc.growthSummary(G, NOW);
  eq('summary 24h', [sm.last24h.joins, sm.last24h.leaves, sm.last24h.net], [2, 0, 2]);
  eq('summary 7d', [sm.last7d.joins, sm.last7d.leaves], [4, 1]);
  ok('summary 30d marked partial', sm.last30d.partial === true && sm.last24h.partial === false);
  eq('trackingEnabled default true', g.coverage.trackingEnabled, true);

  // ---------- snapshots ----------
  svc.recordSnapshot(G, { total: 100, presence: { available: true, online: 40 }, composition: { available: true, humans: 90, bots: 10 } }, NOW - DAY);
  svc.recordSnapshot(G, { total: 104, presence: { available: false }, composition: { available: false } }, NOW - HOUR);
  g = svc.memberGrowth(G, { range: '7d', now: NOW });
  eq('snapshots returned', g.snapshots.map((s) => [s.total, s.online]), [[100, 40], [104, null]]);
  eq('snapshots isolated', svc.memberGrowth(OTHER, { range: '7d', now: NOW }).snapshots.length, 0);

  // ---------- moderation analytics ----------
  const mk = (type, user, mod, modTag, at, guild = G) => {
    const c = db.prepare('SELECT COALESCE(MAX(case_number),0)+1 AS n FROM cases WHERE guild_id = ?').get(guild).n;
    db.prepare('INSERT INTO cases (guild_id, case_number, type, user_id, user_tag, moderator_id, moderator_tag, reason, duration_ms, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)')
      .run(guild, c, type, user, `u${user}`, mod, modTag, 'r', null, at);
  };
  mk('ban', '501', MOD1, 'Alice (dashboard)', NOW - 2 * HOUR);
  mk('warn', '502', MOD1, 'Alice', NOW - 3 * HOUR);
  mk('warn', '503', MOD1, 'Alice', NOW - 2 * DAY);
  mk('kick', '504', MOD2, 'Bob', NOW - 5 * DAY);
  mk('timeout', '505', MOD2, 'Bob', NOW - 9 * DAY); // previous 7d window
  mk('warn', '506', BOT, 'MoonBot (AutoMod)', NOW - HOUR); // automated
  mk('unban', '507', BOT, 'MoonBot', NOW - 20 * DAY);
  mk('ban', '999', OTHER, 'Eve', NOW - HOUR, OTHER); // other server
  // native Discord audit entry (ban made in Discord's UI) + one already linked to a case (must not double count)
  const insA = (id, type, cat, mod, modTag, target, at, extra = {}) => db.prepare(`INSERT INTO audit_log (guild_id, entry_id, action_type, type, category, target_id, target_name, target_type, executor_id, executor_tag, executor_avatar,
      moderator_id, moderator_tag, source, is_self, reason, changes, extra, case_id, created_at, imported) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,NULL,?,?,0)`)
    .run(extra.guild || G, String(id), 22, type, cat, target, `t${target}`, 'user', mod, modTag, extra.avatar || null, mod, modTag, 'discord', extra.reason || null, extra.changes || null, extra.caseId ?? null, at);
  insA(1, 'ban', 'moderation', MOD2, 'Bob', '601', NOW - 4 * HOUR, { avatar: 'bobhash' });
  insA(2, 'ban', 'moderation', MOD1, 'Alice', '501', NOW - 2 * HOUR, { caseId: 1 }); // linked: excluded from the merged feed
  insA(3, 'role_create', 'roles', MOD1, 'Alice', '700', NOW - 6 * HOUR, { changes: JSON.stringify([{ key: 'name', old: null, new: 'VIP' }, { key: 'color' }]) });
  insA(4, 'channel_delete', 'channels', MOD2, 'Bob', '800', NOW - 7 * HOUR);
  insA(5, 'guild_update', 'server', MOD1, 'Alice', null, NOW - 8 * HOUR);
  insA(6, 'message_delete', 'messages', MOD1, 'Alice', '900', NOW - 8 * HOUR); // not an event we list
  insA(7, 'ban', 'moderation', OTHER, 'Eve', '602', NOW - HOUR, { guild: OTHER });

  let m = svc.moderationAnalytics(G, { range: '7d', now: NOW });
  eq('mod 7d byType (cases + native audit, linked audit not double counted)', m.byType, { ban: 2, warn: 3, kick: 1 });
  eq('mod inRange', m.totals.inRange, 6);
  eq('mod previous 7d window', m.totals.previous, 1);
  eq('mod change %', m.totals.change, 500);
  eq('mod last24h', m.totals.last24h, 4);
  eq('mod all time (7 cases + 1 native audit ban)', m.totals.allTime, 8);
  eq('mod all-time byType', m.allTimeByType, { ban: 2, warn: 3, kick: 1, timeout: 1, unban: 1 });
  eq('mod buckets sum to inRange', m.buckets.reduce((a, b) => a + b.total, 0), 6);
  ok('mod last bucket has todays actions', m.buckets[6].total >= 4);
  m = svc.moderationAnalytics(G, { range: '24h', now: NOW });
  eq('mod 24h hourly buckets', m.buckets.length, 24);
  eq('mod 24h total', m.totals.inRange, 4);
  m = svc.moderationAnalytics(OTHER, { range: '7d', now: NOW });
  eq('mod other guild isolated', m.totals.inRange, 2);
  m = svc.moderationAnalytics('555555555555555555', { range: '7d', now: NOW });
  eq('mod empty guild', [m.totals.inRange, m.totals.change, m.totals.allTime], [0, null, 0]);

  // ---------- staff leaderboard ----------
  const members = new Map([[MOD1, { id: MOD1, displayName: 'Alice A.', user: { username: 'alice', globalName: 'Alice', avatar: 'alicehash' } }]]);
  const guild = {
    id: G, name: 'Test', icon: null, memberCount: 3,
    members: { cache: Object.assign(new Map(members), {}), fetch: async () => {} },
    client: { user: { id: BOT }, users: { cache: new Map() } },
  };
  let staff = await svc.staffLeaderboard(guild, { range: '30d', now: NOW });
  eq('leaderboard order', staff.staff.map((s) => s.id), [MOD1, MOD2]);
  eq('leaderboard totals', staff.staff.map((s) => s.total), [3, 3]);
  eq('leaderboard alice breakdown', staff.staff[0].breakdown, { ban: 1, warn: 2 });
  eq('leaderboard bob breakdown', staff.staff[1].breakdown, { kick: 1, ban: 1, timeout: 1 });
  eq('leaderboard names from cache', staff.staff[0].name, 'Alice A.');
  eq('leaderboard avatar from cache', staff.staff[0].avatar, 'alicehash');
  eq('leaderboard avatar fallback to audit hash', staff.staff[1].avatar, 'bobhash');
  eq('leaderboard bot excluded, counted as automated', staff.automated, 2);
  ok('leaderboard lastAt set', staff.staff[0].lastAt === NOW - 2 * HOUR && staff.staff[0].lastType === 'ban');
  eq('leaderboard isolated', (await svc.staffLeaderboard({ ...guild, id: OTHER }, { range: '30d', now: NOW })).staff.map((s) => s.id), [OTHER]);

  // ---------- announcements ----------
  const insAnn = db.prepare('INSERT INTO announcements (guild_id, author_id, author_tag, payload, status, scheduled_at, created_at, sent_at) VALUES (?,?,?,?,?,?,?,?)');
  const insDel = db.prepare('INSERT INTO announcement_deliveries (announcement_id, guild_id, channel_id, channel_name, status, attempts, updated_at) VALUES (?,?,?,?,?,1,?)');
  const a1 = Number(insAnn.run(G, MOD1, 'Alice', JSON.stringify({ content: 'Hello world' }), 'sent', NOW - DAY, NOW - DAY, NOW - DAY).lastInsertRowid);
  insDel.run(a1, G, '1', 'general', 'sent', NOW - DAY); insDel.run(a1, G, '2', 'news', 'sent', NOW - DAY);
  const a2 = Number(insAnn.run(G, MOD2, 'Bob', JSON.stringify({ embeds: [{ title: 'Big news' }] }), 'partial', NOW - 2 * HOUR, NOW - 2 * HOUR, NOW - 2 * HOUR).lastInsertRowid);
  insDel.run(a2, G, '1', 'general', 'sent', NOW - 2 * HOUR); insDel.run(a2, G, '3', 'locked', 'failed', NOW - 2 * HOUR);
  const a3 = Number(insAnn.run(G, MOD1, 'Alice', JSON.stringify({ content: 'Later' }), 'scheduled', NOW + DAY, NOW - HOUR, null).lastInsertRowid);
  insDel.run(a3, G, '1', 'general', 'pending', NOW - HOUR);
  const a4 = Number(insAnn.run(G, MOD1, 'Alice', JSON.stringify({ content: 'Nope' }), 'failed', NOW - HOUR, NOW - HOUR, null).lastInsertRowid);
  insDel.run(a4, G, '3', 'locked', 'failed', NOW - HOUR);
  const o1 = Number(insAnn.run(OTHER, MOD1, 'Alice', JSON.stringify({ content: 'other' }), 'sent', NOW - HOUR, NOW - HOUR, NOW - HOUR).lastInsertRowid);
  insDel.run(o1, OTHER, '1', 'x', 'sent', NOW - HOUR);
  db.prepare("INSERT INTO scheduled (guild_id, user_id, action, run_at, channel_id, message, frequency) VALUES (?,?,?,?,?,?,?)").run(G, MOD1, 'announce', NOW + HOUR, '1', 'legacy', 'once');
  db.prepare("INSERT INTO scheduled (guild_id, user_id, action, run_at) VALUES (?,?,?,?)").run(G, '9', 'unban', NOW + HOUR);

  let an = svc.announcementStats(G, { range: '7d', now: NOW });
  eq('ann total', an.totals.announcements, 4);
  eq('ann delivered/failed', [an.deliveries.delivered, an.deliveries.failed, an.deliveries.pending], [3, 2, 1]);
  eq('ann success rate', an.deliveries.successRate, 60);
  eq('ann pending scheduled (+legacy announce rows only, not temp-ban unbans)', [an.pending.scheduled, an.pending.legacyScheduledMessages, an.pending.total], [1, 1, 2]);
  eq('ann next scheduled preview', an.pending.next[0].preview, 'Later');
  ok('ann recent newest first, no scheduled', an.recent.length === 3 && !an.recent.some((r) => r.status === 'scheduled') && an.recent[0].at >= an.recent[1].at);
  eq('ann recent embed preview', an.recent.find((r) => r.id === a2).preview, 'Big news');
  eq('ann trend sums', [an.buckets.reduce((a, b) => a + b.announcements, 0), an.buckets.reduce((a, b) => a + b.delivered, 0), an.buckets.reduce((a, b) => a + b.failed, 0)], [3, 3, 2]);
  eq('ann inRange', an.totals.inRange, 3);
  an = svc.announcementStats('555555555555555555', { range: '7d', now: NOW });
  eq('ann empty guild: success rate null not 0', [an.totals.announcements, an.deliveries.successRate, an.pending.total], [0, null, 0]);
  eq('ann isolated', svc.announcementStats(OTHER, { range: '7d', now: NOW }).totals.announcements, 1);

  // ---------- recent events ----------
  db.prepare("INSERT INTO member_audit (guild_id, kind, user_id, actor, detail, ok, created_at) VALUES (?,?,?,?,?,1,?)").run(G, 'config', null, 'alice (dashboard)', 'Changed: welcome', NOW - 90 * 60000);
  db.prepare("INSERT INTO member_audit (guild_id, kind, user_id, actor, detail, ok, created_at) VALUES (?,?,?,?,?,1,?)").run(G, 'dm', '1', 'system', 'Welcome DM sent', NOW - 60000);
  let ev = svc.recentServerEvents(G, { limit: 50 });
  const types = new Set(ev.map((e) => e.type));
  for (const t of ['join', 'leave', 'ban', 'kick', 'timeout', 'warn', 'role_create', 'channel_delete', 'guild_update', 'announcement_sent', 'announcement_partial', 'announcement_failed', 'config_change']) ok(`events include ${t}`, types.has(t));
  ok('events exclude unlisted audit types and non-config welcome audit', !types.has('message_delete') && !types.has('dm'));
  ok('events newest first', ev.every((e, i) => i === 0 || ev[i - 1].at >= e.at));
  eq('linked audit ban not duplicated', ev.filter((e) => e.type === 'ban' && e.target?.id === '501').length, 1);
  const role = ev.find((e) => e.type === 'role_create');
  eq('role event detail from changes', role.detail, 'Changed: name, color');
  eq('role event actor', role.actor.name, 'Alice');
  eq('config event actor cleaned', ev.find((e) => e.type === 'config_change').actor.name, 'alice');
  eq('announcement detail', ev.find((e) => e.type === 'announcement_partial').detail, '1 of 2 channel(s) delivered');
  ok('no other-guild rows', !ev.some((e) => e.target?.id === '999' || e.target?.id === '602' || e.target?.id === '9'));
  eq('category filter', [...new Set(svc.recentServerEvents(G, { category: 'roles', limit: 50 }).map((e) => e.category))], ['roles']);
  eq('bad category ignored (falls back to all)', svc.recentServerEvents(G, { category: "x' OR 1=1 --", limit: 50 }).length, ev.length);
  eq('limit clamp min', svc.recentServerEvents(G, { limit: 0 }).length, 20 > ev.length ? ev.length : 20);
  eq('limit applies', svc.recentServerEvents(G, { limit: 3 }).length, 3);
  const newest = ev[0].at;
  eq('after cursor returns only newer', svc.recentServerEvents(G, { after: newest, limit: 50 }).length, 0);
  ok('after cursor partial', svc.recentServerEvents(G, { after: ev[3].at, limit: 50 }).every((e) => e.at > ev[3].at));
  eq('events isolated: empty guild', svc.recentServerEvents('555555555555555555', {}).length, 0);

  // ---------- live stats ----------
  const mkMember = (id, bot, status) => [id, { id, user: { bot }, presence: status ? { status } : null }];
  const mkGuild = (id, memberCount, list, extra = {}) => ({
    id, name: 'G', icon: null, memberCount,
    members: { cache: new Map(list), fetch: extra.fetch || (async function () { for (const [k, v] of extra.fetched || []) this.cache.set(k, v); }) },
    client: { guilds: { fetch: extra.guildFetch || (async () => ({ approximatePresenceCount: 7 })) } },
  });
  // no presence intent: composition from a complete cache, online from Discord's approximate count
  config.presenceIntent = false;
  let calls = 0;
  const g1 = mkGuild('600000000000000001', 4, [mkMember('1', false), mkMember('2', false, 'online'), mkMember('3', true), mkMember('4', false, 'idle')], { guildFetch: async () => { calls++; return { approximatePresenceCount: 2 }; } });
  let lv = await svc.getLiveStats(g1);
  eq('live total', lv.total, 4);
  eq('live composition from complete cache', [lv.composition.available, lv.composition.humans, lv.composition.bots], [true, 3, 1]);
  eq('live presence approximate source', [lv.presence.available, lv.presence.source, lv.presence.online, lv.presence.offline], [true, 'approximate', 2, 2]);
  await svc.getLiveStats(g1); await svc.getLiveStats(g1);
  eq('live stats cached: Discord asked once', calls, 1);
  const pending = await Promise.all([svc.getLiveStats(g1, { force: true }), svc.getLiveStats(g1, { force: true })]);
  ok('concurrent forced calls share one result', pending[0] === pending[1]);
  // approximate count unavailable and no intent => unavailable (NOT zero)
  const g2 = mkGuild('600000000000000002', 2, [mkMember('1', false), mkMember('2', true)], { guildFetch: async () => { throw new Error('boom'); } });
  lv = await svc.getLiveStats(g2);
  eq('presence unavailable is null, not 0', [lv.presence.available, lv.presence.online, lv.presence.offline, lv.presence.reason], [false, null, null, 'intent_disabled']);
  // presence intent: exact from gateway
  config.presenceIntent = true;
  const g3 = mkGuild('600000000000000003', 4, [mkMember('1', false), mkMember('2', false, 'online'), mkMember('3', true, 'dnd'), mkMember('4', false, 'idle')]);
  lv = await svc.getLiveStats(g3);
  eq('gateway presence exact', [lv.presence.source, lv.presence.online, lv.presence.offline, lv.presence.intentEnabled], ['gateway', 3, 1, true]);
  // intent on but a genuine zero online stays a real zero
  const g4 = mkGuild('600000000000000004', 2, [mkMember('1', false), mkMember('2', false)]);
  lv = await svc.getLiveStats(g4);
  eq('real zero online is 0 and available', [lv.presence.available, lv.presence.online], [true, 0]);
  // incomplete cache is completed by one fetch; if it cannot be, composition is unavailable
  const g5 = mkGuild('600000000000000005', 3, [mkMember('1', false)], { fetched: [mkMember('2', true), mkMember('3', false)] });
  lv = await svc.getLiveStats(g5);
  eq('fetch completes cache', [lv.composition.available, lv.composition.humans, lv.composition.bots], [true, 2, 1]);
  let fetches = 0;
  const g6 = mkGuild('600000000000000006', 5, [mkMember('1', false)], { fetch: async () => { fetches++; throw new Error('rate limited'); }, guildFetch: async () => ({ approximatePresenceCount: 3 }) });
  lv = await svc.getLiveStats(g6, { force: true });
  eq('incomplete members -> composition unavailable', [lv.composition.available, lv.composition.humans, lv.composition.reason], [false, null, 'members_incomplete']);
  eq('falls back to approximate when cache incomplete', [lv.presence.source, lv.presence.online], ['approximate', 3]);
  await svc.getLiveStats(g6, { force: true });
  eq('failed full fetch is not hammered', fetches, 1);
  const g7 = mkGuild('600000000000000007', 30000, []);
  lv = await svc.getLiveStats(g7);
  eq('very large server skips full scan', lv.composition.reason, 'too_large');

  // ---------- summary ----------
  const sum = await svc.summary(Object.assign(g1, { id: G, members: Object.assign(g1.members, {}) }), { now: NOW });
  eq('summary moderation last24h', sum.moderation.last24h, 4);
  eq('summary announcements', [sum.announcements.total, sum.announcements.pending, sum.announcements.successRate], [4, 1, 60]);
  ok('summary has growth + live', sum.growth.hasData && sum.live.total === 4);

  console.log(`check-dashboard: ${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); if (e.actual !== undefined) console.error('actual:', JSON.stringify(e.actual), '\nexpected:', JSON.stringify(e.expected)); console.error(e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });
