// Offline self-test: `npm run check`. Needs no Discord token and uses a throwaway database.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'modbot-check-'));
process.env.CLIENT_ID = '111111111111111111';
process.env.CLIENT_SECRET = 'secret';
process.env.BASE_URL = 'http://localhost:0';

const { parseDuration, formatDuration } = require('../src/utils/duration');
const { evaluate, trackSpam, trackJoin } = require('../src/utils/automod');
const { makeBatches, safeName } = require('../src/utils/bulk');
const { getSettings, saveSettings, sanitizeSettings, DEFAULTS } = require('../src/settings');
const store = require('../src/db');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

(async () => {
  console.log('Logic');
  ok('duration parsing', () => {
    assert.strictEqual(parseDuration('10m'), 600000);
    assert.strictEqual(parseDuration('1d12h'), 129600000);
    assert.strictEqual(parseDuration('abc'), null);
    assert.strictEqual(parseDuration('10'), null);
    assert.strictEqual(formatDuration(129600000), '1d 12h');
  });

  const cfg = getSettings('1').automod;
  ok('invite filter', () => {
    assert.strictEqual(evaluate({ content: 'join discord.gg/abc123', mentionCount: 0 }, cfg)?.rule, 'invites');
    assert.strictEqual(evaluate({ content: 'hello there', mentionCount: 0 }, cfg), null);
  });
  ok('link allowlist', () => {
    const c = { ...cfg, links: { enabled: true, allowlist: ['youtube.com'] } };
    assert.strictEqual(evaluate({ content: 'see https://www.youtube.com/watch?v=1', mentionCount: 0 }, c), null);
    assert.strictEqual(evaluate({ content: 'see https://evil.example/x', mentionCount: 0 }, c)?.rule, 'links');
    assert.strictEqual(evaluate({ content: 'see https://notyoutube.com/x', mentionCount: 0 }, c)?.rule, 'links');
  });
  ok('word filter uses whole words', () => {
    const c = { ...cfg, badWords: { enabled: true, words: ['bad'] } };
    assert.strictEqual(evaluate({ content: 'this is BAD!', mentionCount: 0 }, c)?.rule, 'badWords');
    assert.strictEqual(evaluate({ content: 'badminton is fun', mentionCount: 0 }, c), null);
  });
  ok('mentions + caps', () => {
    assert.strictEqual(evaluate({ content: 'hi', mentionCount: 9 }, cfg)?.rule, 'mentions');
    const c = { ...cfg, caps: { enabled: true, minLength: 10, percent: 70 } };
    assert.strictEqual(evaluate({ content: 'STOP SHOUTING AT EVERYONE', mentionCount: 0 }, c)?.rule, 'caps');
    assert.strictEqual(evaluate({ content: 'Normal sentence here ok', mentionCount: 0 }, c), null);
  });
  ok('spam window', () => {
    const rule = { maxMessages: 3, seconds: 5 };
    const t = 1_000_000;
    assert.strictEqual(trackSpam('g', 'u', rule, t), false);
    assert.strictEqual(trackSpam('g', 'u', rule, t + 100), false);
    assert.strictEqual(trackSpam('g', 'u', rule, t + 200), false);
    assert.strictEqual(trackSpam('g', 'u', rule, t + 300), true);
    assert.strictEqual(trackSpam('g', 'u', rule, t + 20_000), false);
  });
  ok('raid detection', () => {
    const rule = { joins: 3, seconds: 10 };
    const t = 5_000_000;
    assert.strictEqual(trackJoin('r', rule, t).raid, false);
    assert.strictEqual(trackJoin('r', rule, t + 1).raid, false);
    const r = trackJoin('r', rule, t + 2);
    assert.ok(r.raid && r.started);
    assert.ok(trackJoin('r', rule, t + 3).raid && !trackJoin('r', rule, t + 4).started);
  });
  ok('bulk batching (10 files / size cap)', () => {
    const mk = (n, size) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(size) }));
    assert.deepStrictEqual(makeBatches(mk(25, 10), 1000).batches.map((b) => b.length), [10, 10, 5]);
    assert.deepStrictEqual(makeBatches(mk(5, 400), 1000).batches.map((b) => b.length), [2, 2, 1]);
    const { batches, tooBig } = makeBatches([...mk(1, 2000), ...mk(2, 10)], 1000);
    assert.strictEqual(tooBig.length, 1);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(safeName('../../etc/pass wd.png', 'x'), 'pass wd.png');
  });
  ok('settings validation rejects junk', () => {
    const cur = getSettings('2');
    const out = sanitizeSettings(
      { logChannelId: 'not-an-id', automod: { enabled: true, spam: { maxMessages: 9999 }, strikes: { action: 'nuke' }, exemptRoleIds: ['123456789012345678', 'x'] }, evil: 1 },
      cur,
    );
    assert.strictEqual(out.logChannelId, null);
    assert.strictEqual(out.automod.enabled, true);
    assert.strictEqual(out.automod.spam.maxMessages, 30);
    assert.strictEqual(out.automod.strikes.action, 'timeout');
    assert.deepStrictEqual(out.automod.exemptRoleIds, ['123456789012345678']);
    assert.ok(!('evil' in out));
  });
  ok('settings persist with defaults merged', () => {
    const s = getSettings('3');
    s.logChannelId = '123456789012345678';
    saveSettings('3', s);
    assert.strictEqual(getSettings('3').logChannelId, '123456789012345678');
    assert.deepStrictEqual(getSettings('3').automod.spam, DEFAULTS.automod.spam);
  });
  ok('cases: numbering, warns, clearing', () => {
    const base = { guildId: 'g1', userId: 'u1', moderatorId: 'm1', reason: 'r' };
    assert.strictEqual(store.createCase({ ...base, type: 'warn' }).case_number, 1);
    assert.strictEqual(store.createCase({ ...base, type: 'warn' }).case_number, 2);
    assert.strictEqual(store.createCase({ ...base, guildId: 'g2', type: 'warn' }).case_number, 1);
    assert.strictEqual(store.activeWarnCount('g1', 'u1'), 2);
    assert.strictEqual(store.clearWarns('g1', 'u1'), 2);
    assert.strictEqual(store.activeWarnCount('g1', 'u1'), 0);
    assert.strictEqual(store.listCases('g1', { userId: 'u1' }).total, 2);
  });

  console.log('Commands');
  ok('all slash commands build valid JSON', () => {
    const names = new Set();
    for (const f of fs.readdirSync(path.join(__dirname, '../src/commands'))) {
      for (const c of require(path.join(__dirname, '../src/commands', f))) {
        const json = c.data.toJSON();
        assert.ok(!names.has(json.name), `duplicate ${json.name}`);
        names.add(json.name);
        assert.strictEqual(typeof c.execute, 'function');
      }
    }
    console.log(`    ${names.size} commands: ${[...names].join(', ')}`);
  });

  console.log('Dashboard server');
  const { createServer } = require('../src/web/server');
  const fakeClient = { isReady: () => true, guilds: { cache: new Map() } };
  const server = createServer(fakeClient).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, opts) => fetch(base + p, { redirect: 'manual', ...opts });

  let r = await get('/health');
  assert.strictEqual(r.status, 200); passed++; console.log('  ✓ /health');
  r = await get('/');
  assert.ok((await r.text()).includes('MOONWEB')); passed++; console.log('  ✓ static page served');
  assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'")); passed++; console.log('  ✓ CSP header');
  r = await get('/api/me', { headers: { 'X-Requested-With': 'modbot' } });
  assert.strictEqual(r.status, 401); passed++; console.log('  ✓ API requires login');
  r = await get('/api/guilds/123456789012345678/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403); passed++; console.log('  ✓ cross-site write blocked');
  r = await get('/auth/login');
  assert.strictEqual(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.strictEqual(loc.hostname, 'discord.com');
  assert.strictEqual(loc.searchParams.get('scope'), 'identify guilds'); passed++; console.log('  ✓ OAuth redirect');
  r = await get('/auth/callback?code=x&state=y');
  assert.strictEqual(r.status, 400); passed++; console.log('  ✓ OAuth state check');

  // Logged-in flows with a fake session + fake guild
  const { PermissionFlagsBits } = require('discord.js');
  store.saveSession('testsid', { user: { id: '222222222222222222', name: 'T', username: 't', avatar: null }, guilds: [{ id: '333333333333333333', name: 'G', icon: null, owner: false, permissions: String(PermissionFlagsBits.ManageGuild) }] }, Date.now() + 60000);
  const guild = {
    id: '333333333333333333', name: 'G', icon: null, memberCount: 5,
    members: { fetch: async () => ({ id: '222222222222222222', permissions: { has: () => true } }) },
    channels: { cache: new Map() },
    roles: { cache: new Map() },
  };
  guild.channels.cache.filter = () => ({ sort: () => ({ map: () => [] }) });
  guild.roles.cache.filter = () => ({ sort: () => ({ map: () => [] }) });
  fakeClient.guilds.cache.set(guild.id, guild);
  fakeClient.guilds.cache.has = Map.prototype.has;
  const hdr = { Cookie: 'sid=testsid', 'X-Requested-With': 'modbot', 'Content-Type': 'application/json' };

  r = await get('/api/me', { headers: hdr });
  const me = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(me.guilds[0].botPresent, true); passed++; console.log('  ✓ /api/me lists manageable servers');
  r = await get('/api/guilds/333333333333333333', { headers: hdr });
  assert.strictEqual(r.status, 200);
  assert.ok((await r.json()).settings.automod); passed++; console.log('  ✓ guild overview');
  r = await get('/api/guilds/333333333333333333/settings', { method: 'PUT', headers: hdr, body: JSON.stringify({ automod: { enabled: true } }) });
  assert.strictEqual((await r.json()).settings.automod.enabled, true); passed++; console.log('  ✓ settings save');
  r = await get('/api/guilds/333333333333333333/cases?page=1', { headers: hdr });
  assert.strictEqual((await r.json()).page, 1); passed++; console.log('  ✓ cases list');
  r = await get('/api/guilds/333333333333333333/activity?page=1&category=moderation&type=ban%27--', { headers: hdr });
  const act = await r.json();
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(act.rows) && act.page === 1); passed++; console.log('  ✓ activity feed (bad filters ignored)');
  r = await get('/api/guilds/333333333333333333/activity/status', { headers: hdr });
  const st = await r.json();
  assert.strictEqual(st.categories.length, 6);
  assert.strictEqual(st.audit.permission, false); passed++; console.log('  ✓ activity status reports missing View Audit Log');
  r = await get('/api/guilds/333333333333333333/activity/moderators', { headers: hdr });
  assert.ok(Array.isArray((await r.json()).moderators)); passed++; console.log('  ✓ activity moderators');
  r = await get('/api/guilds/333333333333333333/activity/audit/999999', { headers: hdr });
  assert.strictEqual(r.status, 404); passed++; console.log('  ✓ unknown log entry -> 404');
  const ac = new AbortController();
  r = await fetch(`${base}/api/guilds/333333333333333333/activity/stream`, { headers: hdr, signal: ac.signal });
  assert.ok((r.headers.get('content-type') || '').startsWith('text/event-stream'));
  ac.abort(); passed++; console.log('  ✓ live stream opens');
  r = await get('/api/guilds/333333333333333333/actions', { method: 'POST', headers: hdr, body: JSON.stringify({ action: 'ban', userId: 'abc' }) });
  assert.strictEqual(r.status, 400); passed++; console.log('  ✓ action input validated');
  r = await get('/api/guilds/999999999999999999', { headers: hdr });
  assert.strictEqual(r.status, 404); passed++; console.log('  ✓ unknown server -> 404');
  const fd = new FormData();
  fd.append('channelId', '1');
  r = await get('/api/guilds/333333333333333333/bulk', { method: 'POST', headers: { Cookie: 'sid=testsid', 'X-Requested-With': 'modbot' }, body: fd });
  assert.strictEqual(r.status, 400); passed++; console.log('  ✓ bulk send needs files');

  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((err) => {
  console.error('\nCHECK FAILED:', err);
  process.exit(1);
});
