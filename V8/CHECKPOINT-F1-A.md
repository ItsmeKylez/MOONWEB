# MOONWEB V7 — Feature 1 (Advanced Dashboard) — 50% CHECKPOINT

Status: **Stage A delivered. Stage B is waiting for the owner's approval. Do not start Feature 2.**

## What is done (all of the backend, about half of the UI)
Backend — complete for every Feature 1 section:
- `src/dashboard.js` (new): live stats (cached 30 s, one shared computation per server), member-count snapshots (hourly, table `member_snapshots`), join/leave growth, moderation analytics, staff leaderboard, announcement delivery stats, recent-events feed, summary.
- `src/utils/dashfmt.js` (new, pure): range/bucket parsing and time bucketing in the viewer's time zone (hour/day/week(Mon)/month).
- `src/db.js`: appended `moderationBuckets`, `moderationCounts`, `staffBreakdown`, `recentEvents`, `auditChanges`, built on the existing merged activity feed (cases + audit entries not already covered by a case).
- `src/web/routes/dashboard.js` (new), mounted in `server.js` behind the existing per-request guard (session, bot in server, Manage Server).
- `src/config.js` + `src/index.js`: opt-in `ENABLE_PRESENCE_INTENT=true` adds the privileged Presence intent.
Frontend — done: live stat cards (total/online/offline/humans/bots/net growth), join/leave chart with 24h/7d/30d/90d filters and hourly/daily/weekly/monthly buckets, moderation analytics chart + trend, auto-refresh poller, live indicator, loading/empty/error states.

## Still to do (Stage B)
1. Announcement delivery card (API `/dashboard/announcements` already exists and is tested).
2. Recent server events feed with category filter + incremental refresh (API `/dashboard/events` exists).
3. Staff leaderboard card (API `/dashboard/staff` exists).
4. Member-count-over-time line (API already returns `snapshots`).
5. Refresh the new cards from the poller; final responsive/UI pass; README + HANDOFF final text.
6. Final verification report (implemented / tested / not tested / blocked).

## New API (all under `/api/guilds/:guildId/dashboard`, Manage Server required)
`GET summary` · `GET growth?range=24h|7d|30d|90d&bucket=hour|day|week|month&tz=<minutes>` · `GET moderation?...` · `GET staff?range` · `GET announcements?...` · `GET events?category&after&limit`
Invalid ranges/buckets fall back to safe defaults; no id from the client is ever used to pick a server.

## Database changes
One new table, created at startup with `IF NOT EXISTS` (no migration step): `member_snapshots(guild_id, ts, total, online, humans, bots)` + index. Existing tables are only read.

## Decisions to know
- Join/leave history is only what `member_events` recorded (Stage 6, setting "Log joins/leaves"). Nothing is back-filled: buckets before recording began are returned with `covered:false` and `null` counts and drawn as "no data", never as zero.
- Online/offline: with `ENABLE_PRESENCE_INTENT=true` (and the Presence Intent enabled in the Developer Portal) counts come exactly from the gateway. Without it the dashboard uses Discord's *approximate* online count (REST, labelled "Approximate"); if neither is available the cards show "—" with the reason. A real 0 is shown as 0.
- Human/bot split needs the full member list; the bot fetches it once (retry no more than every 2 minutes), and skips servers over 25,000 members (shown as unavailable).
- Moderation numbers use the same merged feed as the Logs page, so bans/kicks/timeouts made in Discord's own UI count once audit-log sync has them (and never double-count bot actions).
- Auto-refresh is polling (summary 30 s, charts 120 s), paused while the tab is hidden and stopped when leaving the page. The existing SSE stream only carries moderation rows, so it was not reused.
- `package.json` was not touched (per instructions), so `npm run check` does not include the new suite. Run it with `node scripts/check-dashboard.js`.

## Tests performed
- `node scripts/check-dashboard.js` — 123 checks pass (fake Discord objects, node:sqlite instead of better-sqlite3).
- `check-announce.js` 78/78 and `check-welcome.js` 75/75 still pass. `node --check` on every JS file passes.
- Headless Chromium against a **mock API** (throwaway script, not in the repo): live cards, in-place updates, filters, bucket picker, empty/unavailable/error states, no horizontal overflow at 1280 px and 390 px, polling stops after leaving the page, no JS errors.
## Not tested
- Express route layer (express is not installed in the build environment), `npm run check` as a whole (`check.js`, `check-logs.js` need the real dependencies), real Discord (presence counts, member fetch, approximate count, audit sync), real better-sqlite3.
## Blocked by external configuration
- Exact online counts need the Presence Intent in the Developer Portal + `ENABLE_PRESENCE_INTENT=true`.
## Known issues
- `approximatePresenceCount` behaviour without the Presence intent has not been verified against live Discord.
- Old `casesChartCard()` in `pages.js` is now unused (kept, not removed).
