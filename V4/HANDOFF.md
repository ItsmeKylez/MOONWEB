# MOONWEB — HANDOFF

Read this first. Verify against the source — don't assume anything here still works.

## Project status
- Codebase: `V3/` (user confirmed it is the improved V2; no V1/V2 folders were supplied). Node 20+, discord.js 14, Express 5, better-sqlite3, plain-JS frontend (no build step).
- Stages 1–4: already in the code (moderation, automod, logs, bulk send, dashboard basics). Not modified except where listed below.
- **Stage 5 (Announcements): implemented.** Last completed task: Stage 5 backend + UI + tests.
- Stages 6–10: NOT started. Welcome page still has the old basic welcome; Goodbye/Members are "coming soon" placeholders.
- Do not start Stage 6 without the user's approval.

## Stage 5 — completed
Features: embed editor (title, description, author, footer, timestamp, color, thumbnail, image, up to 10 embeds, up to 25 fields with inline, counters), live preview, text-only / embed-only / mixed messages, link buttons (max 10), role/channel/user mention inserters, allowed-mention controls (@everyone off by default, needs Mention Everyone), templates (5 built-in + user templates: create, edit, duplicate, delete, categories), autosaved per-user draft, multi-channel send (max 10), review-before-send dialog, test send to your DMs (no pings), scheduling (browser timezone → epoch ms), edit scheduled or posted messages, delete posted messages, cancel scheduled, per-channel delivery status, retry failed channels, history with sender/channels/message links/timestamps/success stats, mod-log channel entries.

Decisions to know:
- Buttons are **link buttons only**. Custom-id buttons would need interaction handlers that do something; none exist, so they are not offered (no dead buttons).
- Scheduler: polls every 20 s (`startScheduler`), atomic claim (`UPDATE … WHERE status='scheduled'`) prevents double sends; rows stuck in `sending` after a crash are re-queued on startup and only still-pending deliveries are sent. At send time the author's Manage Server and channel permissions are re-checked.
- Test sends go to the sender's DMs (not recorded in history).
- Duplicate protection: identical payload+channels from the same author within 15 s is rejected.

## Technical information
New files: `src/utils/announce.js` (pure validation/message building, built-in templates), `src/announcements.js` (tables, service, scheduler), `src/web/routes/announcements.js`, `public/js/announce.js`, `scripts/check-announce.js`, `HANDOFF.md`.
Modified files (all small): `src/web/server.js` (mount routes before static; CSP `img-src` changed from `'self' https://cdn.discordapp.com data:` to `'self' https: data:` so embed preview images load), `src/index.js` (start scheduler), `public/index.html` (script tag), `public/js/pages.js` (old announcements placeholder removed), `public/style.css` (appended block), `package.json` (check script), `README.md`.
DB (created with IF NOT EXISTS at startup, no migration needed): `announcement_templates`, `announcement_drafts`, `announcements`, `announcement_deliveries`. All rows carry `guild_id`.
API (all under `/api/guilds/:guildId/announcements`, Manage Server required): `GET /meta`, `POST|PUT|DELETE /templates[/:id]`, `POST /templates/:id/duplicate`, `GET|PUT|DELETE /draft`, `POST /validate`, `POST /test`, `POST /` (send/schedule), `GET /` (history), `GET|PUT /:id`, `POST /:id/cancel|retry|delete-messages`.
Dependencies added: none. Config added: none.

## Testing
- `node scripts/check-announce.js` — 78 checks pass: validation limits, templates, drafts, send, permission failures, partial failure + retry, edit, delete, scheduling, cancel, double-run prevention, author permission recheck, history/stats, guild isolation. It runs without installed deps (falls back to `node:sqlite` and a fake Discord client).
- Frontend smoke test in headless Chromium against a mock API (compose, live preview, autosave, review→send, history, templates, no JS errors, no horizontal scroll at 390 px) passed. That test was a throwaway script and is not in the repo.
- **Not run:** the Express route layer and real Discord calls (express/discord.js/better-sqlite3 could not be installed in the build session); the pre-existing `scripts/check.js` and `check-logs.js` (need those deps).
- Manual tests needed after `npm install`: `npm run check`; send to a real channel; schedule 2 min ahead; edit/delete a posted message; missing-permission channel; test DM; mobile layout.
- Known limitations: History doesn't auto-refresh (Refresh button); scheduled sends can be up to ~20 s late; edits to posted messages keep the original timestamp setting as re-computed at edit time.

## Next session
1. `npm install`, run `npm run check`, fix anything the new routes reveal.
2. Manually test the items above against a real Discord server.
3. With approval, start Stage 6 (Welcome & Goodbye): extend `settings.js` (keep `{count}` working as alias of `{membercount}`), add join/leave event tables (needed for Stage 7 charts), replace `welcomePage()` in `pages.js`.

## Stage 5 verification session (results)
Environment limits: the sandbox had **no network**, so `npm install` could not fetch packages and no real Discord credentials were available. Therefore:
- **Done and passing:** `node --check` on all 30 JS files (0 errors); `node scripts/check-announce.js` — 78/78 checks pass (uses `node:sqlite` + a fake Discord client, so it proves logic, **not** real Discord delivery).
- **Done by code review:** announcement route layer (`src/web/routes/announcements.js`) vs `server.js` guard — mounted after the Manage Server/guild guard, CSRF header and rate limit apply, route order (`/meta`, `/draft` before `/:id`) is correct; every frontend call in `public/js/announce.js` matches a backend route, method and response shape.
- **One fix made:** `src/web/server.js` error handler now returns HTTP 413 for oversized JSON bodies (previously a generic 500).
- **NOT run (needs `npm install` + network):** `npm run check` as a whole (`check.js`, `check-logs.js` need express/discord.js/better-sqlite3/dotenv); the Express layer at runtime; real Discord sending/scheduling/edit/delete/retry; Stages 1-4 regression at runtime; mobile layout.
- **Windows install:** `npm install` needs Node 20+; better-sqlite3 normally downloads a prebuilt binary (if it tries to compile, install "Desktop development with C++" build tools). Copy `.env.example` to `.env` and fill DISCORD_TOKEN, CLIENT_ID, CLIENT_SECRET; then `npm start`.
- **Stage 5 is NOT fully verified.** Stage 6 has not been started and awaits user approval.

### Manual checklist for the user
1. `npm install` then `npm run check` (all three scripts must pass).
2. `npm start`, log in, open Announcements; send an embed to a real channel; send to 2 channels.
3. Schedule one 2 minutes ahead; confirm it posts (up to ~20 s late).
4. Edit a posted message; delete posted messages; cancel a scheduled one.
5. Use a channel where the bot lacks Send Messages; confirm failure shows, then grant permission and Retry.
6. Test DM, templates, draft autosave (reload the page), phone-width layout.
7. Quickly click through Stage 1-4 pages (moderation, logs, bulk send) for regressions.
