# ModBot — Discord moderation bot + web dashboard

A Node.js moderation bot for Discord with a web dashboard, ready to deploy on Railway.

**Moderation commands** `/ban` (permanent or timed) · `/unban` · `/kick` · `/timeout` · `/untimeout` · `/warn` · `/warnings` · `/clearwarnings` · `/case` · `/history` · `/purge` · `/slowmode` · `/lock` · `/unlock` · `/userinfo` · `/serverinfo` · `/config` · `/dashboard`

**Auto-moderation** spam, invite links, link allowlist, word filter, mass mentions, excess caps, raid protection, plus escalation (every N warnings → timeout / kick / ban).

**Logging** every action becomes a numbered case in a database and is posted to your log channel, along with message edits/deletes, joins, leaves and outside bans.

**Moderation logs** the dashboard's *Moderation Logs* page merges bot cases with Discord's own audit log (bans, kicks, timeouts, role/channel/message/server changes made directly in Discord). Entries are stored permanently (Discord only keeps 45 days), attributed to the real moderator (including actions done through the bot or dashboard), filterable by category, type, moderator, source, user and date, and new entries appear live. Needs the **View Audit Log** permission.

**Bulk send** `/bulksend` (up to 10 files per command) and a dashboard page (up to 25 files per job) that send images, videos and files to a channel, split into messages of 10 attachments with a pause between them to respect Discord's rate limits.

**Dashboard** log in with Discord, then manage settings, browse cases, run moderation actions and bulk-send files. You only see servers where you have *Manage Server*, and this is re-checked on every request.

---

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **General Information**: copy the **Application ID** → this is `CLIENT_ID`.
3. **Bot** tab:
   - **Reset Token** → copy it → this is `DISCORD_TOKEN`.
   - Under **Privileged Gateway Intents**, turn on **Server Members Intent** and **Message Content Intent**. The bot will not start without them.
4. **OAuth2** tab: copy the **Client Secret** → this is `CLIENT_SECRET`. You'll add the redirect URL in step 3 below.

## 2. Deploy on Railway

1. Push this folder to a GitHub repository (the `.gitignore` keeps `.env` and `data/` out).
2. In Railway: **New Project → Deploy from GitHub repo** → pick it.
3. **Variables** tab → add `DISCORD_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`.
4. **Settings → Networking → Generate Domain**. Railway then sets `RAILWAY_PUBLIC_DOMAIN`, and the app uses it automatically. (Custom domain? Set `BASE_URL=https://your.domain`.)
5. **Add a Volume** (right-click the service → *Attach Volume*), mount path `/data`, and add the variable `DATA_DIR=/data`.
   **Do not skip this**: without a volume the SQLite database (settings, cases, sessions) is erased on every redeploy.
6. Back in the Developer Portal → **OAuth2 → Redirects** → add
   `https://YOUR-DOMAIN/auth/callback` (exactly, including `https://`).

Once deployed, the logs should show `Logged in as …` and `Registered 19 global commands`. Global commands can take a few minutes to appear. For instant commands while testing, set `DEV_GUILD_ID` to your server's ID.

## 3. Invite the bot

Open the dashboard, log in, and click a server without the bot to get the invite link, or build one yourself with scopes `bot applications.commands`. Required permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages, Manage Channels, Manage Roles, Kick Members, Ban Members, Moderate Members, **View Audit Log** (for the Moderation Logs page; servers that already have the bot need it re-invited or the permission added to its role).

**Important:** drag the bot's role **above** the roles it should moderate (and above any auto-role). Discord won't let a bot act on members whose role is higher than its own.

## 4. First-time setup in your server

```
/config logchannel #mod-logs
/config automod enabled:true
/dashboard
```

Then fine-tune everything in the dashboard.

---

## Bulk send notes

- Discord allows **10 attachments per message** and a per-file size limit (10 MB by default; boosted servers allow more). Set `BULK_MAX_FILE_MB` to match your server's limit (e.g. 50 or 100).
- Files are held in memory while sending, so keep `BULK_MAX_FILES × BULK_MAX_FILE_MB` comfortably below your Railway plan's RAM.
- The pause between messages (`BULK_DELAY_MS`, default 1500 ms) keeps you inside Discord's rate limits. Don't set it to 0 for big batches.
- Both the person using it and the bot must be able to view the channel, send messages and attach files there. Every bulk send is also written to the log channel.
- Only use it in servers you run. Mass-posting into other people's servers is spam and a quick way to get a bot banned.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token |
| `CLIENT_ID` | yes | Application ID |
| `CLIENT_SECRET` | for dashboard | OAuth2 client secret |
| `DATA_DIR` | recommended | Folder for the SQLite DB (`/data` on Railway with a volume) |
| `BASE_URL` | custom domain only | Public URL of the dashboard |
| `DEV_GUILD_ID` | optional | Register commands in one server for instant updates |
| `BULK_MAX_FILE_MB` / `BULK_MAX_FILES` / `BULK_DELAY_MS` | optional | Bulk send limits |
| `AUDIT_RETENTION_DAYS` | optional | Delete audit-log entries older than N days (default: keep forever) |
| `AUDIT_BACKFILL_LIMIT` | optional | Max entries imported on a server's first sync (default 1000) |
| `PORT` | set by Railway | HTTP port |

## Run locally

```bash
cp .env.example .env     # fill it in; add http://localhost:3000/auth/callback as a redirect
npm install
npm start
npm run check            # offline self-test, no token needed
```

## Project layout

```
src/index.js          startup (bot + dashboard)
src/events.js         auto-mod, logging, welcome, raid, scheduled unbans
src/commands/         slash commands (moderation, utility, bulk)
src/utils/mod.js      shared action logic used by commands AND dashboard (permissions, role hierarchy, DMs, cases)
src/utils/automod.js  rule checks
src/utils/bulk.js     file batching/sending
src/utils/audit.js    audit-log mapping, moderator attribution, filter parsing (pure, unit-tested)
src/utils/auditsync.js reads Discord's audit log live + catch-up sync into the database
src/utils/logbus.js   live event bus feeding the dashboard stream
src/web/server.js     Discord OAuth login + JSON API
public/               dashboard frontend (plain HTML/CSS/JS, no build step); public/js/logs.js is the Moderation Logs page
```

## Security notes

- Dashboard sessions are random IDs stored server-side; cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on https.
- Write requests require a custom header and a same-origin `Origin`, blocking cross-site requests.
- Moderation actions from the dashboard follow the same role-hierarchy checks as slash commands.
- Keep your token and client secret private. If either leaks, reset it in the Developer Portal.
