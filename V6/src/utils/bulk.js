const path = require('path');
const config = require('../config');

const MAX_FILES_PER_MESSAGE = 10; // Discord limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeName(name, fallback) {
  const base = path.basename(String(name || '')).replace(/[^\w.\- ()]+/g, '_').slice(0, 100);
  return base && base !== '.' && base !== '..' ? base : fallback;
}

/** Group files into messages: max 10 files and max `maxBytes` total per message. */
function makeBatches(files, maxBytes = config.bulk.maxFileBytes) {
  const batches = [];
  const tooBig = [];
  let current = [];
  let size = 0;
  for (const f of files) {
    if (f.data.length > maxBytes) {
      tooBig.push(f);
      continue;
    }
    if (current.length && (current.length >= MAX_FILES_PER_MESSAGE || size + f.data.length > maxBytes)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.data.length;
  }
  if (current.length) batches.push(current);
  return { batches, tooBig };
}

/**
 * Send many files to a channel, spread over as few messages as Discord allows.
 * files: [{ name, data: Buffer }]
 * onProgress({ sent, total, failed }) is called after every message.
 */
async function sendBulk({ channel, files, caption = '', delayMs = config.bulk.defaultDelayMs, onProgress = () => {}, maxBytes }) {
  const used = new Set();
  const named = files.map((f, i) => {
    let name = safeName(f.name, `file-${i + 1}`);
    while (used.has(name)) name = `${i + 1}-${name}`;
    used.add(name);
    return { name, data: f.data };
  });

  const { batches, tooBig } = makeBatches(named, maxBytes);
  const failed = tooBig.map((f) => ({ name: f.name, reason: 'larger than the per-message upload limit' }));
  let sent = 0;
  let first = true;
  onProgress({ sent, total: named.length, failed: failed.length });

  for (const batch of batches) {
    try {
      await channel.send({
        content: first && caption ? caption.slice(0, 2000) : undefined,
        files: batch.map((f) => ({ attachment: f.data, name: f.name })),
        allowedMentions: { parse: [] },
      });
      sent += batch.length;
    } catch (err) {
      for (const f of batch) failed.push({ name: f.name, reason: err.message });
    }
    first = false;
    onProgress({ sent, total: named.length, failed: failed.length });
    if (delayMs) await sleep(delayMs);
  }
  return { sent, failed, messages: batches.length };
}

module.exports = { sendBulk, makeBatches, safeName, MAX_FILES_PER_MESSAGE };
