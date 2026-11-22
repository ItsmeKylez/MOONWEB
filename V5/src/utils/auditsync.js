'use strict';
/* Reads Discord's audit log into the database: live via the gateway, plus a catch-up on startup,
   when joining a server, and every 15 minutes (covers downtime and permission changes). */
const { Events } = require('discord.js');
const config = require('../config');
const store = require('../db');
const bus = require('./logbus');
const { normalizeEntry } = require('./audit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canRead = (guild) => !!guild.members?.me?.permissions?.has('ViewAuditLog');
const syncing = new Set();

/** Gateway entries often arrive without cached users, so look them up. */
async function resolveUsers(client, entry) {
  const out = {};
  if (entry.executorId) {
    out.executor = entry.executor ?? client.users.cache.get(entry.executorId) ?? (await client.users.fetch(entry.executorId).catch(() => null));
  }
  if (entry.targetType === 'User' && entry.targetId) {
    out.target = entry.target?.username ? entry.target : client.users.cache.get(entry.targetId) ?? (await client.users.fetch(entry.targetId).catch(() => null));
  }
  return out;
}

async function handleLive(client, guild, entry) {
  const row = normalizeEntry(entry, { botId: client.user.id, ...(await resolveUsers(client, entry)) });
  // Actions the bot performed itself already have a case; give that case time to be written so the two can be linked.
  if (row.is_self) await sleep(config.audit.linkDelayMs);
  const res = store.insertAudit(guild.id, row);
  if (res.inserted && !res.linked) bus.emit('activity', { guildId: guild.id, kind: 'audit', id: res.id });
}

/** Fetch audit entries newer than the newest stored one (or, the first time, up to the backfill limit). */
async function syncGuild(client, guild) {
  if (syncing.has(guild.id)) return;
  syncing.add(guild.id);
  try {
    if (!canRead(guild)) { store.setSyncState(guild.id, 'missing_permission'); return; }
    const last = store.lastAuditEntryId(guild.id);
    const entries = [];
    let before;
    let reachedKnown = false;
    while (!reachedKnown && entries.length < config.audit.backfillLimit) {
      const logs = await guild.fetchAuditLogs({ limit: 100, ...(before ? { before } : {}) });
      const batch = [...logs.entries.values()]; // newest first
      if (!batch.length) break;
      for (const e of batch) {
        if (last && BigInt(e.id) <= BigInt(last)) { reachedKnown = true; break; }
        entries.push(e);
      }
      if (batch.length < 100) break;
      before = batch[batch.length - 1].id;
      await sleep(500);
    }
    for (const e of entries.reverse()) {
      store.insertAudit(guild.id, normalizeEntry(e, { botId: client.user.id }), { imported: true });
    }
    store.setSyncState(guild.id, null);
    if (entries.length) console.log(`[audit] ${guild.name}: stored ${entries.length} audit-log entr${entries.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.warn(`[audit] sync failed for ${guild.id}: ${err.message}`);
    store.setSyncState(guild.id, String(err.message).slice(0, 200));
  } finally {
    syncing.delete(guild.id);
  }
}

async function syncAll(client) {
  for (const guild of client.guilds.cache.values()) await syncGuild(client, guild);
}

function startAuditSync(client) {
  syncAll(client).catch((e) => console.error('[audit]', e));
  client.on(Events.GuildCreate, (g) => { syncGuild(client, g).catch(() => {}); });
  setInterval(() => syncAll(client).catch(() => {}), 15 * 60_000).unref();
  if (config.audit.retentionDays > 0) {
    const prune = () => {
      const n = store.pruneAudit(config.audit.retentionDays);
      if (n) console.log(`[audit] pruned ${n} entries older than ${config.audit.retentionDays} days`);
    };
    prune();
    setInterval(prune, 24 * 3600_000).unref();
  }
}

module.exports = { handleLive, syncGuild, startAuditSync, resolveUsers };
