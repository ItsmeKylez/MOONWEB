// Offline self-test for Stage 3 (moderation logs / audit log). Part of `npm run check`.
// Needs no Discord token or network; uses a throwaway database.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'modbot-logs-'));
process.env.CLIENT_ID = '111111111111111111';

const audit = require('../src/utils/audit');
const bus = require('../src/utils/logbus');
const store = require('../src/db');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const G = '333333333333333333';
const BOT = '111111111111111111';
const ALICE = '222222222222222222';
const USER = '444444444444444444';
let seq = 1000000000000000000n;
const entry = (o = {}) => ({
  id: String((seq += 1n)), action: 22, targetType: 'User', targetId: USER, target: { id: USER, username: 'spammer' },
  executorId: ALICE, executor: { id: ALICE, username: 'alice', avatar: 'abc123' }, reason: 'Spam', changes: [], extra: null,
  createdTimestamp: Date.now(), ...o,
});
const norm = (o) => audit.normalizeEntry(entry(o), { botId: BOT });

console.log('Audit helpers');
ok('event mapping and categories', () => {
  assert.deepStrictEqual([audit.classify(22).type, audit.classify(23).type, audit.classify(20).type], ['ban', 'unban', 'kick']);
  assert.strictEqual(audit.classify(11).category, 'channels');
  assert.strictEqual(audit.classify(31).category, 'roles');
  assert.strictEqual(audit.classify(72).category, 'messages');
  assert.strictEqual(audit.classify(9999).type, 'other');
  const keys = audit.allTypes().map((t) => t.key);
  assert.ok(keys.includes('warn') && keys.includes('timeout') && keys.includes('role_update'));
  assert.strictEqual(new Set(keys).size, keys.length);
});
ok('native Discord action is attributed to the Discord moderator', () => {
  const r = norm();
  assert.strictEqual(r.source, 'discord');
  assert.strictEqual(r.moderator_id, ALICE);
  assert.strictEqual(r.moderator_tag, 'alice');
  assert.strictEqual(r.executor_avatar, 'abc123');
  assert.strictEqual(r.target_name, 'spammer');
  assert.strictEqual(r.is_self, 0);
});
ok('bot-executed actions credit the human named in the reason', () => {
  const dash = norm({ executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: '[alice (dashboard)] Spam links' });
  assert.deepStrictEqual([dash.source, dash.moderator_tag, dash.reason, dash.is_self], ['dashboard', 'alice (dashboard)', 'Spam links', 1]);
  const cmd = norm({ executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: '[bob] Be nice' });
  assert.deepStrictEqual([cmd.source, cmd.moderator_tag], ['bot', 'bob']);
  const am = norm({ executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: '[MoonBot (AutoMod)] [AutoMod: caps] x' });
  assert.deepStrictEqual([am.source, am.moderator_id, am.reason], ['automod', BOT, '[AutoMod: caps] x']);
  const plain = norm({ executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: null });
  assert.deepStrictEqual([plain.source, plain.moderator_tag], ['bot', 'MoonBot']);
  assert.strictEqual(plain.executor_avatar, null);
});
ok('timeouts are recognised from member updates', () => {
  const t0 = Date.now();
  const on = norm({ action: 24, createdTimestamp: t0, changes: [{ key: 'communication_disabled_until', old: null, new: new Date(t0 + 3600000 + 400).toISOString() }] });
  assert.strictEqual(on.type, 'timeout');
  assert.strictEqual(JSON.parse(on.extra).duration_ms, 3600000);
  const off = norm({ action: 24, changes: [{ key: 'communication_disabled_until', old: new Date().toISOString(), new: null }] });
  assert.strictEqual(off.type, 'untimeout');
  assert.strictEqual(norm({ action: 24, changes: [{ key: 'nick', old: 'a', new: 'b' }] }).type, 'member_update');
});
ok('changes are trimmed and credentials dropped', () => {
  const r = norm({ action: 31, targetType: 'Role', changes: [{ key: 'name', old: 'A', new: 'B' }, { key: 'webhook_token', old: null, new: 'sekret' }, { key: 'permissions', old: 8n, new: 'x'.repeat(1000) }] });
  const c = JSON.parse(r.changes);
  assert.strictEqual(c.length, 2);
  assert.ok(!r.changes.includes('sekret'));
  assert.strictEqual(c[1].old, '8');
  assert.ok(c[1].new.length <= 402);
  assert.strictEqual(norm({ action: 22, changes: [] }).changes, null);
});
ok('message deletes keep count and channel', () => {
  const r = norm({ action: 73, targetType: 'User', extra: { count: 12, channel: { id: '555555555555555555' } } });
  assert.deepStrictEqual(JSON.parse(r.extra), { count: 12, channel_id: '555555555555555555' });
  assert.strictEqual(r.category, 'messages');
});
ok('query filters are validated', () => {
  const f = audit.parseFilters({ page: '3', category: 'moderation', type: 'ban; DROP', source: 'nope', moderator: ALICE, user: 'x', from: '5', q: ' hi ' });
  assert.deepStrictEqual([f.page, f.category, f.type, f.source, f.moderatorId, f.userId, f.from, f.q], [3, 'moderation', '', '', ALICE, '', 5, 'hi']);
  assert.strictEqual(audit.parseFilters({}).page, 1);
  assert.strictEqual(audit.parseFilters({ page: '-4' }).page, 1);
  assert.strictEqual(audit.parseFilters({ type: undefined }).type, '');
});

console.log('Log storage');
ok('duplicate audit entries are stored once', () => {
  const r = norm();
  assert.strictEqual(store.insertAudit(G, r).inserted, true);
  assert.strictEqual(store.insertAudit(G, r).inserted, false);
  assert.strictEqual(store.listActivity(G, { type: 'ban' }).total, 1);
  assert.strictEqual(store.lastAuditEntryId(G), r.entry_id);
});
ok('bot actions link to their case and are not shown twice', () => {
  const c = store.createCase({ guildId: G, type: 'kick', userId: USER, userTag: 'spammer', moderatorId: ALICE, moderatorTag: 'alice (dashboard)', reason: 'x' });
  const self = norm({ action: 20, executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: '[alice (dashboard)] x' });
  const res = store.insertAudit(G, self);
  assert.strictEqual(res.linked, true);
  const kicks = store.listActivity(G, { type: 'kick' }).rows;
  assert.strictEqual(kicks.length, 1);
  assert.strictEqual(kicks[0].kind, 'case');
  assert.strictEqual(kicks[0].case.id, c.id);
  assert.strictEqual(kicks[0].source, 'dashboard');
});
ok('an audit entry that arrives before its case is linked when the case is written', () => {
  const U2 = '666666666666666666';
  const self = norm({ action: 22, targetId: U2, target: { id: U2, username: 'late' }, executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: '[bob] late case' });
  const res = store.insertAudit(G, self);
  assert.strictEqual(res.linked, false);
  assert.strictEqual(store.listActivity(G, { userId: U2 }).total, 1);
  store.createCase({ guildId: G, type: 'ban', userId: U2, userTag: 'late', moderatorId: ALICE, moderatorTag: 'bob', reason: 'late case' });
  const rows = store.listActivity(G, { userId: U2 }).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'case');
});
ok('an unmatched bot action is still shown, not hidden', () => {
  const U3 = '777777777777777777';
  store.insertAudit(G, norm({ action: 22, targetId: U3, target: { id: U3, username: 'x' }, executorId: BOT, executor: { id: BOT, username: 'MoonBot' }, reason: '[bob] manual' }));
  assert.strictEqual(store.listActivity(G, { userId: U3 }).rows[0].kind, 'audit');
});
ok('other audit categories are stored and filterable', () => {
  store.insertAudit(G, norm({ action: 12, targetType: 'Channel', targetId: '888888888888888888', target: { id: '888888888888888888', name: 'old-chat' }, reason: null, changes: [{ key: 'name', old: 'old-chat', new: null }] }));
  const ch = store.listActivity(G, { category: 'channels' });
  assert.strictEqual(ch.total, 1);
  assert.strictEqual(ch.rows[0].target_name, 'old-chat');
  const detail = audit.shapeAuditDetail(store.getAuditEntry(G, ch.rows[0].rid));
  assert.strictEqual(detail.changes[0].key, 'name');
  assert.ok(store.listActivity(G, { category: 'moderation' }).rows.every((r) => r.category === 'moderation'));
});
ok('feed filters: moderator, source, text, dates, user, paging', () => {
  const H = '999999999999999999';
  store.createCase({ guildId: H, type: 'warn', userId: USER, userTag: 'spammer', moderatorId: ALICE, moderatorTag: 'alice', reason: '100% rude_user' });
  store.createCase({ guildId: H, type: 'ban', userId: '123456789012345678', userTag: 'other', moderatorId: BOT, moderatorTag: 'MoonBot (AutoMod)', reason: '[AutoMod: spam]' });
  store.createCase({ guildId: H, type: 'unban', userId: '123456789012345678', userTag: 'other', moderatorId: BOT, moderatorTag: 'MoonBot', reason: 'Temporary ban expired' });
  assert.strictEqual(store.listActivity(H, {}).total, 3);
  assert.strictEqual(store.listActivity(H, { moderatorId: ALICE }).total, 1);
  assert.deepStrictEqual(store.listActivity(H, { source: 'automod' }).rows.map((r) => r.type), ['ban']);
  assert.deepStrictEqual(store.listActivity(H, { source: 'scheduled' }).rows.map((r) => r.type), ['unban']);
  assert.strictEqual(store.listActivity(H, { q: '100%' }).total, 1);
  assert.strictEqual(store.listActivity(H, { q: 'rude_u' }).total, 1);
  assert.strictEqual(store.listActivity(H, { q: '%' }).total, 1);
  assert.strictEqual(store.listActivity(H, { userId: USER }).total, 1);
  assert.strictEqual(store.listActivity(H, { from: Date.now() + 60000 }).total, 0);
  assert.strictEqual(store.listActivity(H, { after: Date.now() - 60000 }).total, 3);
  assert.strictEqual(store.listActivity(H, {}, { limit: 2, offset: 2 }).rows.length, 1);
  const mods = store.activityModerators(H);
  assert.ok(mods.some((m) => m.id === ALICE) && mods.some((m) => m.id === BOT));
});
ok('guilds are isolated', () => {
  assert.strictEqual(store.listActivity('100000000000000001', {}).total, 0);
  assert.strictEqual(store.getActivityRow('100000000000000001', 'case', 1), null);
});
ok('new cases announce themselves on the live bus', () => {
  let got = null;
  const on = (e) => { got = e; };
  bus.on('activity', on);
  const c = store.createCase({ guildId: G, type: 'warn', userId: USER, moderatorId: ALICE, reason: 'live' });
  bus.off('activity', on);
  assert.deepStrictEqual(got, { guildId: G, kind: 'case', id: c.id });
  const row = store.getActivityRow(G, 'case', c.id);
  assert.strictEqual(audit.shapeRow(row).key, `case:${c.id}`);
});
ok('status and retention', () => {
  store.setSyncState(G, 'missing_permission');
  const s = store.auditStatus(G);
  assert.ok(s.entries >= 3 && s.error === 'missing_permission' && s.lastSyncAt);
  store.setSyncState(G, null);
  assert.strictEqual(store.auditStatus(G).error, null);
  assert.strictEqual(store.pruneAudit(1), 0);
  const before = store.auditStatus(G).entries;
  store.insertAudit(G, norm({ action: 22, createdTimestamp: Date.now() - 10 * 86400000, targetId: '121212121212121212' }));
  assert.strictEqual(store.pruneAudit(5), 1);
  assert.strictEqual(store.auditStatus(G).entries, before);
});

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\nAll ${passed} log checks passed.`);
