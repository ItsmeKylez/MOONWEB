const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/** Parse "30m", "2h", "1d12h", "1w" into milliseconds. Returns null if invalid. */
function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  const re = /(\d+)([smhdw])/g;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(text))) {
    total += Number(m[1]) * UNITS[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== text.length || total <= 0) return null;
  return total;
}

function formatDuration(ms) {
  if (!ms) return '—';
  const parts = [];
  let rest = ms;
  for (const [label, size] of [['w', UNITS.w], ['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]]) {
    const n = Math.floor(rest / size);
    if (n) { parts.push(`${n}${label}`); rest -= n * size; }
  }
  return parts.join(' ') || '0s';
}

module.exports = { parseDuration, formatDuration, MAX_TIMEOUT_MS: 28 * UNITS.d };
