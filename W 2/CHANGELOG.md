# Changelog

## UI redesign — dashboard follows the supplied dark glass reference (frontend only)
- Files changed: `web/static/style.css`, `web/static/app.js`, `web/static/index.html`. No backend, API, database or bot file was touched; the ticket system (bot and dashboard pages) keeps its logic.
- Design system: near-black canvas with faint grid, grey-to-white gradient headings, glass cards (20px radius), white pill primary buttons, dark pill secondary buttons, badge pills, chrome four-point stars, outlined wordmark footer. Inter font. Dark only.
- Reusable components in `app.js`: icons, badge, head, empty state, skeleton, search field, `dataTable`, `confirmDialog`, dropdown menus, toasts, sidebar, floating header, footer.
- Responsive: sidebar becomes a drawer at 900px; tables become stacked cards at 720px.
- Native `confirm()` replaced by the styled dialog (warning removal, unsaved changes). Fixed: cancelling "leave page" asked twice.
- Tested with a mocked API in headless Chromium at 1440/1180/820/390px (no JS errors, no horizontal overflow). Not tested against a live bot/Discord.

## Stage 4B — Feature 02: Separate Configurable Logging Channels

**Added**
- 15 log subcategories (`config.LOG_SUBCATEGORIES`) under the existing 8 categories, e.g. `mensajes_borrados`,
  `mensajes_editados`, `entradas_salidas`, `cambios_miembros`, `canales`, `roles`, `emojis_stickers`, `invitaciones`,
  `ajustes_servidor`, `bans`, `casos_gestion`, `antispam`, `antiraid`, `antinuke`, `automod`.
- `/canaleslog ver | asignar | quitar | silenciar` (admin): give a subcategory its own channel, make it inherit
  the parent category's channel again, or mute it. `ver` shows the effective destination of everything.
- **Backward compatible:** a subcategory with no own channel uses its parent category's channel, so servers
  configured before this update keep receiving everything where they always did. If a subcategory's own channel is
  deleted or the bot loses permission there, delivery falls back to the parent channel.
- Existing events (`cogs/logs.py`, anti-spam/raid/nuke, purge, escalation, case edits, warning expiry, and the
  Feature 4B-01 events) now send to the matching subcategory. Ticket logs and case/sanction logs (`moderacion`,
  `apelaciones`, `tickets`, `voz`) are unchanged.
- No migration: subcategories are stored in the existing `log_channels` table. `/setup`, `/config logs` and the
  dashboard keep working with the original 8 categories only.
- Tests: `tests/test_logrouting.py`; two earlier tests updated for the new category of warning-expiry / case-edit logs.

**Modified files:** `config.py`, `utils/helpers.py` (send_log), `cogs/logs.py`, `cogs/antispam.py`, `cogs/antiraid.py`,
`cogs/antinuke.py`, `cogs/moderation.py` (purge log), `cogs/eventlogs.py`, `utils/eventtrack.py`, `utils/escalation.py`,
`utils/casemgmt.py`, `utils/warnexpiry.py`, `web/server.py` (set-count only counts main categories), `bot.py`,
`cogs/utility.py`, tests.
**New files:** `cogs/logrouting.py`, `utils/logrouting.py`, `tests/test_logrouting.py`.
Ticket system untouched.

## Stage 4B — Feature 01: Expanded Event Tracking

**Added** (new events; the existing ones in `cogs/logs.py` are untouched and not duplicated)
- Threads renamed / archived / locked / slowmode changed; thread members joining/leaving (off by default).
- Stage started / edited / ended.
- Scheduled events created / edited / deleted.
- AutoMod rules created / edited / deleted (with who, via audit log) and AutoMod actions executed.
- Reactions cleared in bulk from a message; channel pins updated.
- Server mute/deafen applied by a moderator in voice (with who); screen share / camera (off by default).
- Server boosts started / stopped; timeouts removed (with who when the audit log has it).
- Each event goes to an EXISTING log category (mensajes / miembros / servidor / voz / moderacion / seguridad), so
  it respects the channels already configured; no channel -> nothing is sent.
- `/eventos listar` (staff), `/eventos activar|desactivar evento` (admin): per-server toggle. Only deviations from
  the default are stored (`event_toggles`). Ignored channels/users/roles (existing ignore list) are respected.
- Duplicate-delivery protection (TTL deduper); a failing listener never propagates.
- Tests: `tests/test_eventtrack.py`.

**Modified files:** `database/schema.sql`, `bot.py`, `cogs/utility.py`.
**New files:** `cogs/eventlogs.py`, `utils/eventtrack.py`, `tests/test_eventtrack.py`.
Ticket system untouched. No new intents or env vars required.

## Stage 4A — Feature 06: Improved Case History and Management

**Added**
- `/casos lista [usuario] [moderador] [accion] [estado] [dias]` (staff): filtered, paginated case list.
- `/casos buscar texto [estado]` (staff): search in the reason (wildcards are escaped, parameterized SQL).
- `/casos editar numero motivo` (staff): edit a reason - admins any case, other staff only their own. The old
  text is kept.
- `/casos anular numero motivo` / `/casos restaurar numero` (admin): void / restore a case. Voiding is
  administrative only: the case is not deleted and the punishment is NOT undone.
- `/casos auditoria numero` (staff): who changed what and when (edit / void / restore, before and after).
- Every change is also posted to the moderation log channel.
- `/caso` now shows voided state, edited marker and appeal status; `/historial` marks voided cases (struck
  through), edited cases, and shows active / voided counts; `/userinfo` counts only non-voided cases.
- Safe migration: `cases` gets `voided_at`, `voided_by`, `void_reason`, `edited_at` via `ALTER TABLE` only if
  missing; new table `case_audit`. Existing cases are untouched. Changes are serialized (no double void).
- Tests: `tests/test_casemgmt.py`.

**Modified files:** `database/db.py`, `database/schema.sql`, `bot.py`, `cogs/moderation.py`, `cogs/utility.py`.
**New files:** `cogs/casemgmt.py`, `utils/casemgmt.py`, `tests/test_casemgmt.py`.
Ticket system untouched.

## Stage 4A — Feature 05: Configurable Warning Expiration

**Added**
- `/expiracion configurar dias [notificar]` (admin): warnings expire after N days (1-3650); `0` = never (default,
  so nothing expires until an admin enables it). Reports how many existing warnings already exceed the new period.
- `/expiracion estado` (staff): current setting and how many warnings are pending expiry.
- `/expiracion ahora` (admin): run the expiry pass immediately. A background task also runs it every 10 min.
- Expired warnings are **kept, not deleted**: marked `expired_at`, shown as "caducado" in `/warns` (with active /
  expired counts), and no longer counted by escalation, `/userinfo`, `/warn` totals or the dashboard total.
  `/warn` shows when the new warning will expire. Dashboard warning list now exposes `expired_at`.
- Expiring never punishes or reverses anything; escalation re-arms on the user's next `/warn` as before.
- Optional log embed in the moderation log channel per pass (toggle with `notificar`).
- Safe migration: `warns.expired_at` added with `ALTER TABLE` only if missing (+ index); new table
  `warn_expiry_config`. Existing warnings stay active.
- Tests: `tests/test_warnexpiry.py`.

**Modified files:** `database/db.py`, `database/schema.sql`, `bot.py`, `cogs/moderation.py`, `cogs/utility.py`,
`utils/escalation.py`, `web/server.py`.
**New files:** `cogs/warnexpiry.py`, `utils/warnexpiry.py`, `tests/test_warnexpiry.py`.
Ticket system untouched.

## Stage 4A — Feature 04: Moderator Activity Reports

**Added**
- `/modreporte resumen [dias]` (admin): totals (sanctions / reversals / other), breakdown by action type,
  appeals received / accepted / denied / pending, top moderators, bot-automated actions, and staff-role members
  with no activity in the period.
- `/modreporte moderador usuario [dias]` (staff; admins can view anyone, others only themselves): totals,
  sanctions per day, per-action breakdown, appeals resolved, evidence uploaded, first/last action, latest cases.
- `/modreporte exportar [dias]` (admin): CSV per moderator (formula-injection safe, Excel-friendly UTF-8 BOM).
- Period 1-365 days (default 30). Actions by the bot itself (anti-spam, anti-nuke, anti-raid, escalation) are
  reported separately so they do not distort the human ranking.
- Read-only: no new tables, no schema change. `/modstats` is unchanged.
- Tests: `tests/test_modreports.py`.

**Modified files:** `bot.py`, `cogs/utility.py` (help text).
**New files:** `cogs/modreports.py`, `utils/modreports.py`, `tests/test_modreports.py`.
Ticket system untouched.

## Stage 4A — Feature 03: Moderation Appeal System

**Added**
- DM of a ban / temp ban / timeout / warning now carries an **"Apelar este caso"** button (persistent
  `DynamicItem`, works after restarts and for banned users who can no longer use commands). It opens a modal.
- `/apelar caso razon` for members still in the server.
- Staff: `/apelacion lista [estado]`, `ver`, `aceptar [nota]`, `denegar [nota]`. Admin: `/apelacion config
  [estado] [dias]`.
- **Accepting undoes the sanction**: unban (and clears the temp-ban timer), removes the timeout, or deletes the
  warning linked to that case; a normal case (unban / untimeout / unwarn) is created with the reviewer as moderator.
  Denying is final. The user gets a DM with the decision and optional staff note.
- New log category `apelaciones` (falls back to the `moderacion` channel if unset; dashboard picks it up automatically).
- Rules: off by default; one appeal per case; only the punished user can appeal; configurable window (default
  30 days, 0 = unlimited); max 3 pending per user; nobody can resolve their own appeal; decisions are
  serialized so a double click cannot resolve twice.
- New tables `appeal_config`, `appeals` (idempotent; nothing existing altered). Tests: `tests/test_appeals.py`.

**Modified files:** `utils/modlog.py` (button in the punishment DM), `config.py` (log category), `database/db.py`,
`database/schema.sql`, `bot.py`, `cogs/utility.py`.
**New files:** `cogs/appeals.py`, `utils/appeals.py`, `tests/test_appeals.py`.
Ticket system untouched.

## Stage 4A — Feature 02: Evidence Attachments for Moderation Cases

**Added**
- `/evidencia agregar caso archivo [nota]`, `/evidencia ver caso`, `/evidencia quitar id_evidencia` (staff).
- Optional `evidencia` attachment on `/warn`, `/ban`, `/kick` and `/timeout`: the file is saved to the case
  that command creates. A failed upload never undoes the punishment; the reply just says it was not saved.
- `/caso` now shows how many evidence files a case has.
- Files are downloaded and stored in `data/evidence/<guild>/` (Discord CDN links expire); limits: 8 MB per
  file, 10 per case, note up to 200 chars. Filenames are sanitized and paths are confined to `data/evidence/`.
- Adding / removing evidence is posted to the moderation log channel. Only the uploader or an administrator
  can remove a file.
- New table `case_evidence` (idempotent, no existing table altered). Tests: `tests/test_evidence.py`;
  shared stubs in `tests/stubs.py`.

**Modified files:** `bot.py`, `cogs/moderation.py`, `cogs/utility.py`, `database/schema.sql`.
**New files:** `cogs/evidence.py`, `utils/evidence.py`, `tests/test_evidence.py`, `tests/stubs.py`.
Ticket system untouched.

## Stage 4A — Feature 01: Automatic Punishment Escalation

**Added**
- `/escalada` command group (administrators): `activar`, `agregar`, `quitar`;
  staff: `lista`, `historial`.
- Configurable thresholds: "at N warnings -> timeout / kick / ban", with a
  duration for timeouts (required, max 28d) and temp bans (optional).
- `/warn` now evaluates escalation after saving the warning and reports the
  outcome in its reply.
- Escalation history (`escalation_history`) and a moderation-log embed for every
  applied or failed escalation; applied escalations also create a normal case
  (moderator = the bot), visible in `/caso` and `/historial`.
- New tables `escalation_config`, `escalation_rules`, `escalation_history`
  (created by the existing idempotent `schema.sql`; no existing table altered).
- `tests/test_escalation.py`.

**Behavior**
- Disabled by default; no hardcoded thresholds exist. Nothing happens until an
  admin defines rules and runs `/escalada activar on`.
- Only the highest reached threshold applies, once, until the user drops below it
  (via `/delwarn`, `/clearwarns` or the dashboard), which re-arms it.
- Per-user lock + partial unique index prevent duplicate punishments.

**Modified files:** `bot.py`, `cogs/moderation.py` (`/warn`), `cogs/utility.py`
(help text), `database/db.py` (config table list), `database/schema.sql`.
**New files:** `cogs/escalation.py`, `utils/escalation.py`, `tests/test_escalation.py`.
Ticket system untouched.
