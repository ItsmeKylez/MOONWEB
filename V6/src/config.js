require('dotenv').config({ quiet: true });
const path = require('path');

const port = Number(process.env.PORT) || 3000;

const baseUrl = (
  process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)
).replace(/\/+$/, '');

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  devGuildId: process.env.DEV_GUILD_ID || null,
  port,
  baseUrl,
  secureCookies: baseUrl.startsWith('https://'),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  audit: {
    // 0 = keep audit entries forever. Otherwise entries older than this many days are deleted daily.
    retentionDays: Math.max(0, Number(process.env.AUDIT_RETENTION_DAYS) || 0),
    // Most entries imported from Discord's history the first time a server is synced (Discord keeps 45 days).
    backfillLimit: Math.min(5000, Math.max(100, Number(process.env.AUDIT_BACKFILL_LIMIT) || 1000)),
    // How long to wait for the bot's own case to be written before linking its audit entry to it.
    linkDelayMs: 2500,
  },
  bulk: {
    // Per-file limit. Discord's default upload limit is 10 MB; boosted servers allow more.
    maxFileBytes: (Number(process.env.BULK_MAX_FILE_MB) || 10) * 1024 * 1024,
    // Files accepted per dashboard bulk job (kept in memory while sending).
    maxFiles: Number(process.env.BULK_MAX_FILES) || 25,
    // Pause between messages so Discord rate limits are respected.
    defaultDelayMs: Math.max(0, Number(process.env.BULK_DELAY_MS) || 1500),
  },
};
