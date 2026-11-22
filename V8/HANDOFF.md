# MOONWEB — HANDOFF

Read this first. Verify against the source — don't assume anything here still works.

## Project status
- Codebase: `V7/`. Node 20+, discord.js 14, Express 5, better-sqlite3, plain-JS frontend (no build step).
- Stages 1–4: already in the code (moderation, automod, logs, bulk send, dashboard basics). Not modified except where listed below.
- **Stage 5 (Announcements): implemented.** Last completed task: Stage 5 backend + UI + tests.
- **Stage 6 (Welcome & Goodbye): implemented, offline-tested only** (see "Stage 6" section). Stage 5 was approved by the user to move on, but it was still never run against real Discord.
- Stages 7–10: NOT started. Members page is still a "coming soon" placeholder.
- Do not start Stage 7 without the user's approval.

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

## Stage 6 — Welcome & Goodbye (implemented this session)
**Features:** welcome + goodbye messages (plain text / embed / both), channel pickers, test buttons (post a real message for the staff member into the configured channel after a confirm dialog), variables `{user} {username} {userid} {server} {membercount} {createdate} {joineddate}` (+ legacy `{count}`) with a reference panel and live preview, random welcome templates (up to 10), optional welcome DM, welcome image (templates classic/banner/minimal, gradient or uploaded PNG/JPEG background ≤2 MB, avatar, username/server text, alignment + vertical offset, server-rendered preview), auto role, **verification role** (given *instead of* the auto role to flagged new accounts), new-account detection (warn in log channel, optional kick), anti-raid action now `alert | timeout (10 min) | kick` (existing raid detector reused; only runs while AutoMod is enabled), join/leave event log, automation audit log (welcome/goodbye/role/DM/new-account/raid/image/test/config changes), permission/hierarchy warnings after saving.
**Decisions:** non-blocking warnings (not errors) for missing channel/role permissions, because the bot's permissions can be fixed after saving; runtime failures are written to the audit log, never faked as success. Raid kick/timeout and new-account kick are skipped safely (and audited) if the bot lacks permission or the member is above the bot. Join/leave events are stored from now on (needed for Stage 7 charts) — there is no backfill. Join-rate *alerts* are the existing raid alert (log channel + audit); there is no separate alert channel.
**New files:** `src/welcome.js` (tables `member_events`, `member_audit`, handlers, tests, warnings), `src/utils/welcomefmt.js` (pure: variables, sanitizing, message building, image layout), `src/utils/welcomeimage.js` (canvas renderer), `src/web/routes/welcome.js`, `public/js/welcome.js`, `scripts/check-welcome.js`.
**Modified:** `src/settings.js` (new `welcome`/`goodbye`/`joinAutomation` defaults + sanitizers; raid action accepts `timeout`; old stored settings still load), `src/events.js` (join/leave now call `welcome.handleJoin/handleLeave`; old inline welcome/auto-role code removed), `src/web/server.js` (settings PUT now audits changed sections and returns `warnings`; mounts welcome routes; 413 handler from earlier), `public/js/pages.js` (old welcomePage removed; raid dropdown gets "timeout"), `public/js/ui.js` (**bug fix:** after saving, `state.data.settings` was replaced by a new object so forms kept editing a stale one and a second save lost edits — now `syncInto()` updates in place; save shows permission warnings), `public/index.html`, `public/style.css`, `package.json`.
**API (under `/api/guilds/:guildId/welcome`, Manage Server):** `GET /meta`, `POST /test {kind}`, `POST /image-preview {image}`, `POST|DELETE /background`, `GET /events?type&page`, `GET /audit?page`. Config is saved through the existing `PUT /settings`.
**Dependencies:** `@napi-rs/canvas` added under **optionalDependencies** (image rendering). `package-lock.json` was NOT regenerated (no network) — run `npm install` (not `npm ci`) and commit the new lockfile. Without the package everything else works; the image feature shows an explicit "needs @napi-rs/canvas" message and welcome messages go out without an image (audited).
**DB:** `member_events`, `member_audit` created at startup (IF NOT EXISTS); background images stored in `DATA_DIR/welcome-bg/<guildId>.img` (on Railway keep DATA_DIR on the volume).

### Stage 6 testing
- `node scripts/check-welcome.js`: 75 checks pass (fake Discord): variables, sanitizing, messages/embeds/random, image layout math, legacy settings migration, join flow (welcome, roles, DM success/failure, role hierarchy refusal, new-account → verification role, kick, unkickable), raid kick/timeout/refusal, goodbye, event + audit logs, test sends, permission errors, warnings, background validation, guild isolation, paging. `check-announce.js` still 78/78; all 30+ JS files pass `node --check`.
- Headless Chromium against a mock API (throwaway script, not in repo): 14/14 UI checks (tabs, live preview, embed switch, dirty bar, save-warning toast, honest image-preview error, test confirm → POST, activity tables, no horizontal scroll at 390 px, no JS exceptions).
- **NOT run (needs network + real Discord):** `npm install`; real `@napi-rs/canvas` drawing (the drawing code is untested); Express route layer for `/welcome/*` (multer upload, error codes); real joins/leaves/DMs/role assignment/kick/timeout; real test messages; avatar loading from Discord CDN inside the canvas.
- **Manual checklist:** (1) `npm install`, `npm run check`. (2) Welcome tab: pick channel, enable, save, "Send test welcome". (3) Embed and text+embed formats; random templates. (4) Image: Preview image, upload background, enable, join with an alt account. (5) Goodbye: leave with an alt account. (6) Automation: auto role (bot role must be above it), verification role + new-account limit with an account younger than the limit. (7) Anti-raid with a low threshold on a test server (kick/timeout). (8) Activity tab shows joins/leaves/audit. (9) Re-check Moderation page raid dropdown and Settings page save.

## Next session (updated)
1. Read this file; `npm install`; `npm run check` (4 scripts); fix anything the unrun layers reveal (Stage 5 + 6 routes, canvas).
2. Manual Discord tests above (Stage 5 list + Stage 6 list).
3. With the user's approval, Stage 7 (dashboard overview). Data available for it: `member_events` (joins/leaves per day), `cases`/`audit_log` (moderation), `announcements`, `member_audit` (welcome/goodbye/failed actions). Do not display anything that isn't real stored or live Discord data.


## V7 repair session (what was wrong, what was fixed)
The V7 upload had been damaged by pasted-in snippets. Fixed:
- `src/web/server.js` was only a snippet ("add this to the existing server.js"), so the real server was missing. **Rebuilt** (OAuth login, server-side sessions, CSRF header + Origin check, rate limit, CSP, per-request Manage Server guard, overview/settings/cases/timeline/actions/activity/stream/bulk routes, 413/400 error handling). `scripts/check.js` (31 checks) passes against it.
- `src/settings.js`: half-merged `botPresence` block (syntax error, never applied anywhere) removed.
- `src/db.js`: corrupted `scheduled` table definition fixed; migration adds `channel_id`, `message`, `frequency` to existing databases.
- `src/events.js`: the scheduler treated every `scheduled` row as a temp-ban unban. It now dispatches on `action` (`unban` / `announce`), handles daily/weekly repeats, and posts scheduled messages with all mentions disabled. The unused `src/scheduler.js` (referenced an undefined `client`) was deleted.
- `src/web/routes/config|analytics|scheduled.js` referenced an undefined `client`; rewritten behind the shared guard with validation (CSV export escapes formulas, import is sanitised, scheduled tasks validate channel/time/permissions). New `routes/members.js` (search + cursor paging).
- `public/js/pages.js`: syntax error and duplicated, React-style members code replaced by a working vanilla-JS Members page. `src/components/MemberSelector.js` (React, no build step, unused) deleted.
- Toast `warning` kind now has an icon/colour.
Verified: `npm run check` (all four suites), ESLint `no-undef` over frontend + backend, headless-Chromium walk through all 9 pages (no JS errors, no phone-width overflow), and an API test of actions, config, CSV, scheduled tasks, scheduler, bulk send and security paths. Still never run against real Discord.


## V8 work — Feature 1 (Advanced Dashboard) — Stage A checkpoint delivered (≈50%)
See `CHECKPOINT-F1-A.md` for the full report. Stage B (announcement card, events feed, staff leaderboard, snapshot line, final pass) needs the owner's approval. Feature 2 (Server Management) has NOT been started and must not start without explicit approval.
