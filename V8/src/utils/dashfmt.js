'use strict';
/* Pure helpers for dashboard analytics: range parsing and time bucketing in the viewer's time zone.
   No discord.js or database imports, so everything here is easy to test offline. */

const HOUR = 3600000;
const DAY = 86400000;

const RANGES = {
  '24h': { unit: 'hour', count: 24, buckets: ['hour'] },
  '7d': { unit: 'day', count: 7, buckets: ['day'] },
  '30d': { unit: 'day', count: 30, buckets: ['day', 'week'] },
  '90d': { unit: 'day', count: 90, buckets: ['day', 'week', 'month'] },
};

const parseRange = (r) => (Object.prototype.hasOwnProperty.call(RANGES, r) ? r : '7d');
/** Browser UTC offset in minutes, clamped to the real-world range. */
const parseTz = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(840, Math.max(-720, n)) : 0; };
/** Bucket size allowed for the range; falls back to the range's finest bucket. */
function parseBucket(range, b) {
  const allowed = RANGES[parseRange(range)].buckets;
  return allowed.includes(b) ? b : allowed[0];
}

/**
 * Time layout for a range. `buckets` is the final list (hour/day/week/month) and `slotOfBase(i)` maps a base index
 * (hour or day number in the viewer's time zone, i.e. floor((ts + off) / size)) to a bucket slot (or -1).
 * Weeks start on Monday. Buckets that begin before the range (first week/month) are flagged `partial`.
 */
function layout({ now = Date.now(), range = '7d', bucket, tz = 0 } = {}) {
  range = parseRange(range);
  bucket = parseBucket(range, bucket);
  const def = RANGES[range];
  const size = def.unit === 'hour' ? HOUR : DAY;
  const off = tz * 60000;
  const lastIdx = Math.floor((now + off) / size);
  const firstIdx = lastIdx - (def.count - 1);
  const from = firstIdx * size - off;

  const base = [];
  for (let i = firstIdx; i <= lastIdx; i++) base.push(i);

  let groups; // [{ key, idxs[], natStart }]
  if (bucket === 'week') {
    groups = groupBy(base, (d) => Math.floor((d + 3) / 7), (key) => (key * 7 - 3) * DAY);
  } else if (bucket === 'month') {
    const monthKey = (d) => { const t = new Date(d * DAY); return t.getUTCFullYear() * 12 + t.getUTCMonth(); };
    groups = groupBy(base, monthKey, (key) => Date.UTC(Math.floor(key / 12), key % 12, 1) / 1);
    // natStart for months is already epoch ms of the (UTC-shifted) first day; convert to the same day-number space below.
    for (const g of groups) g.natStart = Math.floor(g.natStart / DAY) * DAY;
  } else {
    groups = base.map((i) => ({ key: i, idxs: [i], natStart: i * size }));
  }

  const slot = new Map();
  const buckets = groups.map((g, n) => {
    for (const i of g.idxs) slot.set(i, n);
    const first = g.idxs[0];
    const last = g.idxs[g.idxs.length - 1];
    return {
      start: first * size - off,
      end: Math.min((last + 1) * size - off, now + 1),
      current: last === lastIdx,
      partial: bucket === 'day' || bucket === 'hour' ? false : g.natStart < first * size,
    };
  });
  return { range, bucket, unit: def.unit, size, off, firstIdx, lastIdx, from, to: now, buckets, slotOfBase: (i) => (slot.has(i) ? slot.get(i) : -1) };
}

function groupBy(base, keyOf, natStartOf) {
  const out = [];
  for (const d of base) {
    const k = keyOf(d);
    const last = out[out.length - 1];
    if (last && last.key === k) last.idxs.push(d);
    else out.push({ key: k, idxs: [d], natStart: natStartOf(k) });
  }
  return out;
}

/** % change from `prev` to `cur`; null when there is no previous value to compare with. */
const pctChange = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

/** Keep at most `max` evenly spaced points (always keeps the last one). */
function downsample(rows, max = 200) {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

/** One-line summary of audit "changes" for the events feed: "Changed: name, color". */
function summarizeChanges(changesJson) {
  let c;
  try { c = changesJson ? JSON.parse(changesJson) : null; } catch { return null; }
  if (!Array.isArray(c) || !c.length) return null;
  const keys = [...new Set(c.map((x) => x && x.key).filter((k) => typeof k === 'string'))].slice(0, 5);
  return keys.length ? `Changed: ${keys.map((k) => k.replace(/_/g, ' ')).join(', ')}` : null;
}

/** Strip the " (dashboard)" / " (AutoMod)" markers the bot adds to moderator tags. */
const cleanTag = (t) => (t ? String(t).replace(/\s\((dashboard|AutoMod)\)$/, '') : t);

module.exports = { HOUR, DAY, RANGES, parseRange, parseTz, parseBucket, layout, pctChange, downsample, summarizeChanges, cleanTag };
