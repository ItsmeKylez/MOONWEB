const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg)\/[a-z0-9-]+/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hostsIn(content) {
  const hosts = [];
  for (const raw of content.match(URL_RE) ?? []) {
    try {
      const url = new URL(raw.startsWith('www.') ? `https://${raw}` : raw);
      hosts.push(url.hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      /* ignore malformed */
    }
  }
  return hosts;
}

/**
 * Stateless content checks. Returns { rule, reason } for the first rule broken, or null.
 * message: { content: string, mentionCount: number }
 */
function evaluate(message, cfg) {
  const content = message.content ?? '';

  if (cfg.invites.enabled && INVITE_RE.test(content)) {
    return { rule: 'invites', reason: 'Posting server invite links is not allowed' };
  }

  if (cfg.links.enabled) {
    const allow = cfg.links.allowlist;
    const bad = hostsIn(content).find((h) => !allow.some((d) => h === d || h.endsWith(`.${d}`)));
    if (bad) return { rule: 'links', reason: 'Links to that site are not allowed here' };
  }

  if (cfg.badWords.enabled && cfg.badWords.words.length) {
    for (const w of cfg.badWords.words) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, 'iu');
      if (re.test(content)) return { rule: 'badWords', reason: 'Message contained a blocked word' };
    }
  }

  if (cfg.mentions.enabled && message.mentionCount > cfg.mentions.max) {
    return { rule: 'mentions', reason: `Too many mentions (${message.mentionCount})` };
  }

  if (cfg.caps.enabled) {
    const letters = content.replace(/[^\p{L}]/gu, '');
    if (letters.length >= cfg.caps.minLength) {
      const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
      if ((upper / letters.length) * 100 >= cfg.caps.percent) {
        return { rule: 'caps', reason: 'Excessive capital letters' };
      }
    }
  }

  return null;
}

// ---- Spam tracking (in memory) ----
const messageTimes = new Map(); // "guild:user" -> number[]

function trackSpam(guildId, userId, cfg, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const windowMs = cfg.seconds * 1000;
  const times = (messageTimes.get(key) ?? []).filter((t) => now - t < windowMs);
  times.push(now);
  messageTimes.set(key, times);
  return times.length > cfg.maxMessages;
}

function resetSpam(guildId, userId) {
  messageTimes.delete(`${guildId}:${userId}`);
}

// ---- Raid tracking (in memory) ----
const joinTimes = new Map(); // guildId -> number[]
const raidUntil = new Map(); // guildId -> timestamp

/** Returns { raid: boolean, started: boolean }. */
function trackJoin(guildId, cfg, now = Date.now()) {
  const windowMs = cfg.seconds * 1000;
  const times = (joinTimes.get(guildId) ?? []).filter((t) => now - t < windowMs);
  times.push(now);
  joinTimes.set(guildId, times);

  const active = (raidUntil.get(guildId) ?? 0) > now;
  if (times.length >= cfg.joins) {
    raidUntil.set(guildId, now + 60_000);
    return { raid: true, started: !active };
  }
  return { raid: active, started: false };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of messageTimes) if (!v.length || now - v[v.length - 1] > 120_000) messageTimes.delete(k);
  for (const [k, v] of joinTimes) if (!v.length || now - v[v.length - 1] > 300_000) joinTimes.delete(k);
  for (const [k, v] of raidUntil) if (v < now) raidUntil.delete(k);
}, 300_000).unref();

module.exports = { evaluate, trackSpam, resetSpam, trackJoin, hostsIn };
