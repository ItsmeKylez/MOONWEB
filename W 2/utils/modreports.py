"""Informes de actividad de moderadores.

Solo lee datos que ya existen: casos (cases), apelaciones resueltas
(appeals.reviewed_by) y evidencias subidas (case_evidence.added_by). No crea
tablas ni escribe nada.

Las sanciones automaticas (anti-spam, anti-nuke, anti-raid, escalada) las
registra el propio bot como moderador: se separan en "automatico" para que no
distorsionen el ranking del staff humano.
"""

from __future__ import annotations

import csv
import io
import time

SANCTIONS = frozenset({"ban", "tempban", "softban", "kick", "timeout", "warn",
                       "quarantine", "strip"})
REVERSALS = frozenset({"unban", "untimeout", "unwarn"})
MIN_DAYS, MAX_DAYS = 1, 365


def kind_of(action: str) -> str:
    if action in SANCTIONS:
        return "sanctions"
    if action in REVERSALS:
        return "reversals"
    return "other"


def since_ts(days: int, now: int | None = None) -> int:
    days = max(MIN_DAYS, min(MAX_DAYS, int(days)))
    return int(now if now is not None else time.time()) - days * 86400


def _blank() -> dict:
    return {"sanctions": 0, "reversals": 0, "other": 0, "total": 0, "by_action": {},
            "first": None, "last": None, "appeals_accepted": 0, "appeals_denied": 0,
            "evidence": 0}


async def gather(bot, guild_id: int, since: int, bot_id: int | None = None) -> dict:
    """Agrega la actividad del servidor desde `since` (timestamp unix)."""
    db = bot.db
    moderators: dict[int, dict] = {}
    totals = {"sanctions": 0, "reversals": 0, "other": 0, "total": 0}
    by_action: dict[str, int] = {}

    def entry(mid: int) -> dict:
        return moderators.setdefault(mid, _blank())

    rows = await db.fetchall(
        "SELECT moderator_id, action, COUNT(*) AS n FROM cases "
        "WHERE guild_id=? AND created_at>=? GROUP BY moderator_id, action", (guild_id, since))
    for r in rows:
        kind, n = kind_of(r["action"]), r["n"]
        e = entry(r["moderator_id"])
        e[kind] += n
        e["total"] += n
        e["by_action"][r["action"]] = e["by_action"].get(r["action"], 0) + n
        totals[kind] += n
        totals["total"] += n
        by_action[r["action"]] = by_action.get(r["action"], 0) + n

    for r in await db.fetchall(
            "SELECT moderator_id, MIN(created_at) AS a, MAX(created_at) AS b FROM cases "
            "WHERE guild_id=? AND created_at>=? GROUP BY moderator_id", (guild_id, since)):
        e = entry(r["moderator_id"])
        e["first"], e["last"] = r["a"], r["b"]

    for r in await db.fetchall(
            "SELECT reviewed_by, status, COUNT(*) AS n FROM appeals "
            "WHERE guild_id=? AND reviewed_at>=? AND reviewed_by IS NOT NULL "
            "GROUP BY reviewed_by, status", (guild_id, since)):
        key = "appeals_accepted" if r["status"] == "accepted" else "appeals_denied"
        entry(r["reviewed_by"])[key] += r["n"]

    for r in await db.fetchall(
            "SELECT added_by, COUNT(*) AS n FROM case_evidence "
            "WHERE guild_id=? AND added_at>=? GROUP BY added_by", (guild_id, since)):
        entry(r["added_by"])["evidence"] += r["n"]

    appeals = {
        "submitted": await db.fetchval(
            "SELECT COUNT(*) FROM appeals WHERE guild_id=? AND created_at>=?",
            (guild_id, since), 0),
        "pending_now": await db.fetchval(
            "SELECT COUNT(*) FROM appeals WHERE guild_id=? AND status='pending'",
            (guild_id,), 0),
        "accepted": await db.fetchval(
            "SELECT COUNT(*) FROM appeals WHERE guild_id=? AND status='accepted' "
            "AND reviewed_at>=?", (guild_id, since), 0),
        "denied": await db.fetchval(
            "SELECT COUNT(*) FROM appeals WHERE guild_id=? AND status='denied' "
            "AND reviewed_at>=?", (guild_id, since), 0),
    }

    automated = moderators.pop(bot_id, None) if bot_id is not None else None
    return {"since": since, "totals": totals, "by_action": by_action,
            "moderators": moderators, "automated": automated, "appeals": appeals}


def ranking(data: dict, limit: int = 15) -> list[tuple[int, dict]]:
    """Moderadores humanos ordenados por sanciones, luego por actividad total."""
    items = sorted(
        data["moderators"].items(),
        key=lambda kv: (kv[1]["sanctions"],
                        kv[1]["total"] + kv[1]["appeals_accepted"] + kv[1]["appeals_denied"]
                        + kv[1]["evidence"]),
        reverse=True)
    return items[:limit]


def inactive(staff_ids: list[int], data: dict) -> list[int]:
    """Miembros del staff sin NINGUNA actividad registrada en el periodo."""
    active = set(data["moderators"])
    return [i for i in staff_ids if i not in active]


async def recent_cases(bot, guild_id: int, moderator_id: int, since: int,
                       limit: int = 8) -> list[dict]:
    return await bot.db.fetchall(
        "SELECT number, action, user_id, created_at FROM cases "
        "WHERE guild_id=? AND moderator_id=? AND created_at>=? ORDER BY number DESC LIMIT ?",
        (guild_id, moderator_id, since, limit))


def _csv_safe(text: str) -> str:
    """Evita la inyeccion de formulas al abrir el CSV en Excel/Sheets."""
    return "'" + text if text and text[0] in "=+-@\t\r" else text


def to_csv(data: dict, names: dict[int, str]) -> str:
    actions = sorted(data["by_action"])
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["moderator_id", "moderator_name", "sanctions", "reversals", "other_actions",
                *[f"action_{a}" for a in actions], "appeals_accepted", "appeals_denied",
                "evidence_added", "first_action_unix", "last_action_unix"])

    def row(mid, name, e):
        w.writerow([mid, _csv_safe(name), e["sanctions"], e["reversals"], e["other"],
                    *[e["by_action"].get(a, 0) for a in actions], e["appeals_accepted"],
                    e["appeals_denied"], e["evidence"], e["first"] or "", e["last"] or ""])

    for mid, e in ranking(data, limit=10_000):
        row(mid, names.get(mid, ""), e)
    if data["automated"]:
        row("automatic", "Automatico (bot)", data["automated"])
    return out.getvalue()
