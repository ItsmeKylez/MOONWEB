# HANDOFF

## Completed
- Stage 4A / Feature 01 — Automatic Punishment Escalation.
- Stage 4A / Feature 02 — Evidence attachments for moderation cases.
- Stage 4A / Feature 03 — Moderation appeal system.
- Stage 4A / Feature 04 — Moderator activity reports.
- Stage 4A / Feature 05 — Configurable warning expiration.
- Stage 4A / Feature 06 — Improved case history and management. (Stage 4A COMPLETE.)
- Stage 4B / Feature 01 — Expanded event tracking.
- Stage 4B / Feature 02 — Separate configurable logging channels (see CHANGELOG.md).

## Stage 4B Feature 02 tests
- py_compile on all files: pass. `python tests/test_logrouting.py`: 42/42 pass; all earlier suites still pass
  (40/33/33/38/36/57/34). Covers subcategory definitions, candidate resolution (own / inherit / muted / fallback),
  describe output, DB assignment, channel-permission check, real `send_log` with stub channels (inherit, own channel,
  deleted channel, no permission, muted, restored), and a scan that every literal `send_log` category is valid.
- NOT tested (needs live Discord): `/canaleslog` interactions and pagination, real channel permissions, which real
  gateway events reach which subcategory, command sync.
- Limitations: the web dashboard still edits only the 8 main categories (subcategories are Discord-only).
  `/setup` still creates one channel per main category. Muting only works for subcategories, not main ones (use
  `/config logs canal` with no channel to disable a main category). Logs from `tickets`, `apelaciones`, `voz` and
  case sanctions (`moderacion`) have no subcategories. No per-role/channel filters yet (Feature 4B-03).

## Stage 4B Feature 01 tests
- py_compile on all files: pass. `python tests/test_eventtrack.py`: 34/34 pass; earlier suites still 40/33/33/38/36/57.
  Covers event registry vs config.LOG_CATEGORIES, per-guild toggles (defaults, overrides, reset), emit routing and
  ignore handling, deduper, pure diff helpers (threads, scheduled events, voice server/stream).
- Static AST check: all listener names are valid discord.py events, none duplicated.
- NOT tested (needs live Discord): the listeners themselves (the cog is not importable with the discord stubs), real
  gateway payload shapes, audit-log attribution, `/eventos` interactions, command sync, embed rendering.
- Notes/limitations: AutoMod execution events are only delivered if the bot has Manage Server permission. Pins can
  not be told apart from unpins (Discord only sends the last pin time). Thread/scheduled-event edits compare
  before/after only when discord.py has them cached. Reaction add/remove individually are intentionally not logged
  (volume). Events are not stored anywhere searchable yet (Feature 4B-06). Still one shared channel per category
  (separate channels = Feature 4B-02).

## Feature 06 tests
- py_compile on all files: pass. `python tests/test_casemgmt.py`: 57/57 pass; Features 01-05 still 40/33/33/38/36.
  Real utils/casemgmt.py + db.py + schema.sql, stubbed discord.py/aiosqlite. Covers validation, migration of an old
  database, filters/pagination/server isolation, LIKE-wildcard and SQL-injection safety, edit permissions, audit trail,
  void/restore (admin only, double-void, concurrent voids -> one), log embed and log failure tolerance.
- Static AST check: describe/choices keys match command params.
- NOT tested (needs live Discord): `/casos` interactions, permission gating, embeds/pagination as rendered,
  updated `/caso` and `/historial` output, command sync.
- Limitations: voiding does not undo the punishment or delete a linked warn. Voided cases are still counted by
  `/modstats`, `/modreporte`, the dashboard and appeals (only `/userinfo`, `/historial` footer and `/casos` filters
  know about voiding). Only the reason is editable (not user/action/duration). Anti-spam/escalation cases can only be
  edited by admins. `/casos lista` shows the 200 most recent matches. No dashboard page.

## Feature 05 tests
- py_compile on all files: pass. `python tests/test_warnexpiry.py`: 36/36 pass; Features 01-04 still 40/33/33/38.
  Real utils/warnexpiry.py + utils/escalation.py + db.py + schema.sql, stubbed discord.py/aiosqlite. Covers
  validation, migration of an old database (column added, old warning intact/active, idempotent reconnect),
  off by default, expiry pass (per-user counts, per-server isolation, nothing deleted, idempotent), concurrent passes
  (each warning reported once), changing/disabling the period, escalation ignoring expired warnings (no punishment
  from expiry), log embed on/off, sweep_all without a cached guild.
- Static AST check: describe keys match command params.
- NOT tested (needs live Discord): `/expiracion` interactions and permission gating, `/warns` and `/warn` embeds as
  rendered (Discord timestamps), the 10-min task running in the real bot, log channel delivery, dashboard UI.
- Limitations: the period is global per server and applies retroactively to existing warnings (the command says how
  many are affected). Expiry is computed from the warning's creation date; there is no per-warning override.
  Expired warnings are still removed by `/clearwarns` / `/delwarn`. Anti-spam warns that create no `warns` row are
  unaffected (as before). Expiry creates no moderation case (only the optional log embed). Appeals that accept a
  warn case may still delete an already-expired warning. The dashboard JS does not yet display `expired_at`.

## Feature 04 tests
- py_compile on all files: pass. `python tests/test_modreports.py`: 38/38 pass; Features 01-03 still 40/33/33.
  Real utils/modreports.py + db.py + schema.sql, stubbed discord.py/aiosqlite. Covers period boundaries (1/30/365d),
  per-server isolation, bot-vs-human separation, appeals/evidence attribution, ranking, inactive staff, empty data,
  CSV structure and formula-injection escaping.
- Static AST check: describe keys match command params.
- NOT tested (needs live Discord): the embeds as rendered, `/modreporte` interactions and permission gating,
  CSV attachment upload, `role.members` for the inactive-staff list (needs the Members intent, already enabled).
- Limitations: counts come from the cases table, so punishments that never create a case (e.g. `/purge`, role
  commands) are not included; warns deleted later still count via their case. Inactive-staff list needs
  `/config staff` set and only considers members holding that role. Embed shows the top 10; the CSV has everyone.
  No dashboard page.

## Feature 03 tests
- py_compile on all files: pass. `python tests/test_appeals.py`: 33/33 pass; Features 01 (40) and 02 (33) still pass.
  Real utils/appeals.py, modlog.py, db.py, schema.sql with stubbed discord.py/aiosqlite. Covers validation, window,
  limits, ownership, duplicate/concurrent submit and resolve, accept->unban/untimeout/unwarn, deny, Forbidden/NotFound,
  DM button only on appealable actions when enabled, old-database migration.
- Static AST check: all describe/choices keys match command params.
- NOT tested (needs live Discord): the DM button -> modal -> submit flow, DynamicItem registration/persistence after
  restart, command sync, real unban/untimeout, DMs. The DM button relies on the same DynamicItem pattern as the
  existing ticket buttons.
- Limitations: warn-undo matches the warning by user + moderator + creation time (+-120s) because warns are not
  linked to case numbers; if none matches, the appeal is still accepted and says so. Appeals created before enabling
  have no button (use /apelar). Kicks/softbans are not appealable. No dashboard page. Escalation cases appear
  appealable like any other case.

## Feature 02 tests
- py_compile on all files: pass. `python tests/test_evidence.py`: 33/33 pass (real utils/evidence.py,
  db.py, schema.sql; stubbed discord.py/aiosqlite). `tests/test_escalation.py` still 40/40.
- Static AST check: every `describe/choices` key matches a real command parameter.
- NOT tested (needs live Discord): real attachment upload/download, `/evidencia` interactions,
  command sync with the new optional `evidencia` option, discord.File re-upload in `/evidencia ver`.
- Limits: evidence lives on the bot's disk. On Railway the filesystem is ephemeral unless a volume is
  mounted on `data/`, so evidence is lost on redeploy without one (same applies to the existing bot.db).
- Not yet: evidence on /softban, /unban, escalation cases, or in the web dashboard.

## Feature 01 tests (earlier)
## Tests performed (sandbox had NO network, NO discord.py, NO aiosqlite)
- `python -m py_compile` on every .py file: pass.
- `python tests/test_escalation.py`: 40/40 pass. It runs the REAL `utils/escalation.py`,
  `utils/modlog.py`, `database/db.py` and `schema.sql`, but with stubbed discord.py
  and a sqlite3-backed aiosqlite shim. Covers rule validation, threshold selection,
  no-duplicate application, concurrency, re-arming, failures (hierarchy, Forbidden,
  owner), kick, tempban -> temp_actions, and migration of an old database.
- NOT tested (needs a live Discord server + real discord.py): slash command
  registration/sync, the `/escalada` interaction flow, real timeout/kick/ban calls,
  log-channel embeds, DMs, dashboard.

## Known limitations
- Only `/warn` triggers escalation. Anti-spam "warn" actions create cases but not
  `warns` rows (existing behavior), so they do not count.
- A FAILED escalation (e.g. bot role too low) is not retried at the same threshold
  until the user drops below it and re-arms, or reaches a higher threshold.
- Escalation re-arms lazily, on the user's next `/warn`.
- Dashboard has no escalation page yet (commands only).

## Next feature (do NOT start without approval)
Stage 4B — Feature 03: Logging filters by role and channel.
