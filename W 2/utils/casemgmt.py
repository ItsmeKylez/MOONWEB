"""Gestion de casos de moderacion (Stage 4A / Feature 06).

  * Busqueda y listado con filtros (usuario, moderador, accion, estado, dias, texto).
  * Editar el motivo: solo un administrador o el moderador que creo el caso.
    El valor anterior se conserva en case_audit.
  * Anular / restaurar: solo administradores. Anular es administrativo: el caso
    NO se borra y la sancion NO se deshace (para eso estan /unban, /untimeout o
    las apelaciones). Los casos anulados se marcan en /caso y /historial.
  * Todo cambio queda en case_audit y se publica en el log de moderacion.
"""

from __future__ import annotations

import asyncio
import logging
import time

import discord

import config
from . import embeds, helpers, modlog

log = logging.getLogger("bot.casemgmt")

MIN_REASON, MAX_REASON, MAX_VOID_REASON = 3, 900, 500
PAGE_SIZE = 8
MAX_DAYS = 3650
STATES = ("active", "voided", "all")

_lock = asyncio.Lock()   # serializa editar / anular / restaurar


def validate_reason(text: str | None, maximum: int = MAX_REASON) -> str | None:
    text = (text or "").strip()
    if len(text) < MIN_REASON:
        return f"El texto debe tener al menos {MIN_REASON} caracteres."
    if len(text) > maximum:
        return f"El texto no puede superar {maximum} caracteres."
    return None


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def search(bot, guild_id: int, *, user_id: int | None = None,
                 moderator_id: int | None = None, action: str | None = None,
                 state: str = "active", days: int | None = None, text: str | None = None,
                 page: int = 1, per_page: int = 200) -> tuple[list[dict], int]:
    """Devuelve (filas, total). `state`: active | voided | all."""
    if state not in STATES:
        state = "active"
    where, params = ["guild_id=?"], [guild_id]
    if user_id is not None:
        where.append("user_id=?"); params.append(user_id)
    if moderator_id is not None:
        where.append("moderator_id=?"); params.append(moderator_id)
    if action:
        where.append("action=?"); params.append(action)
    if state == "active":
        where.append("voided_at IS NULL")
    elif state == "voided":
        where.append("voided_at IS NOT NULL")
    if days:
        days = max(1, min(int(days), MAX_DAYS))
        where.append("created_at>=?"); params.append(int(time.time()) - days * 86400)
    if text:
        where.append("reason LIKE ? ESCAPE '\\'"); params.append(_like(text.strip()[:100]))
    clause = " AND ".join(where)
    total = await bot.db.fetchval(f"SELECT COUNT(*) FROM cases WHERE {clause}", params, 0)
    page = max(1, page)
    rows = await bot.db.fetchall(
        f"SELECT * FROM cases WHERE {clause} ORDER BY number DESC LIMIT ? OFFSET ?",
        (*params, per_page, (page - 1) * per_page))
    return rows, total


async def audit_for_case(bot, guild_id: int, number: int, limit: int = 15) -> list[dict]:
    return await bot.db.fetchall(
        "SELECT * FROM case_audit WHERE guild_id=? AND case_number=? ORDER BY id DESC LIMIT ?",
        (guild_id, number, limit))


async def audit_count(bot, guild_id: int, number: int) -> int:
    return await bot.db.fetchval(
        "SELECT COUNT(*) FROM case_audit WHERE guild_id=? AND case_number=?",
        (guild_id, number), 0)


async def _record(bot, guild_id, number, actor_id, action, old, new) -> None:
    await bot.db.execute(
        "INSERT INTO case_audit (guild_id, case_number, actor_id, action, old_value, "
        "new_value, created_at) VALUES (?,?,?,?,?,?,?)",
        (guild_id, number, actor_id, action, old, new, int(time.time())))


# ---------------------------------------------------------------------------
async def edit_reason(bot, guild: discord.Guild, number: int, actor_id: int,
                      is_admin: bool, new_reason: str) -> tuple[bool, str]:
    problem = validate_reason(new_reason)
    if problem:
        return False, problem
    new_reason = new_reason.strip()
    async with _lock:
        case = await modlog.get_case(bot, guild.id, number)
        if not case:
            return False, "Ese caso no existe."
        if case.get("voided_at"):
            return False, "El caso esta anulado; restauralo antes de editarlo."
        if not is_admin and case["moderator_id"] != actor_id:
            return False, "Solo un administrador o el moderador del caso puede editarlo."
        if (case["reason"] or "") == new_reason:
            return False, "El motivo nuevo es igual al actual."
        await bot.db.execute(
            "UPDATE cases SET reason=?, edited_at=? WHERE guild_id=? AND number=?",
            (new_reason, int(time.time()), guild.id, number))
        await _record(bot, guild.id, number, actor_id, "edit", case["reason"], new_reason)
    await _log(bot, guild, number, actor_id, "Motivo editado", case["reason"], new_reason)
    return True, f"Motivo del caso #{number} actualizado."


async def void_case(bot, guild: discord.Guild, number: int, actor_id: int,
                    is_admin: bool, reason: str) -> tuple[bool, str]:
    if not is_admin:
        return False, "Solo un administrador puede anular casos."
    problem = validate_reason(reason, MAX_VOID_REASON)
    if problem:
        return False, problem
    reason = reason.strip()
    async with _lock:
        case = await modlog.get_case(bot, guild.id, number)
        if not case:
            return False, "Ese caso no existe."
        if case.get("voided_at"):
            return False, "Ese caso ya esta anulado."
        await bot.db.execute(
            "UPDATE cases SET voided_at=?, voided_by=?, void_reason=? WHERE guild_id=? AND number=?",
            (int(time.time()), actor_id, reason, guild.id, number))
        await _record(bot, guild.id, number, actor_id, "void", None, reason)
    await _log(bot, guild, number, actor_id, "Caso anulado", None, reason)
    return True, (f"Caso #{number} anulado. La sancion en si **no se ha deshecho**; "
                  f"si hace falta, revierte la sancion aparte.")


async def restore_case(bot, guild: discord.Guild, number: int, actor_id: int,
                       is_admin: bool) -> tuple[bool, str]:
    if not is_admin:
        return False, "Solo un administrador puede restaurar casos."
    async with _lock:
        case = await modlog.get_case(bot, guild.id, number)
        if not case:
            return False, "Ese caso no existe."
        if not case.get("voided_at"):
            return False, "Ese caso no esta anulado."
        await bot.db.execute(
            "UPDATE cases SET voided_at=NULL, voided_by=NULL, void_reason=NULL "
            "WHERE guild_id=? AND number=?", (guild.id, number))
        await _record(bot, guild.id, number, actor_id, "restore", case["void_reason"], None)
    await _log(bot, guild, number, actor_id, "Caso restaurado", case["void_reason"], None)
    return True, f"Caso #{number} restaurado."


async def _log(bot, guild, number, actor_id, title, old, new) -> None:
    try:
        embed = embeds.base(f"{config.E_INFO} {title} · Caso #{number}", color=config.COLOR_INFO)
        embed.add_field(name="Por", value=f"<@{actor_id}>", inline=True)
        if old:
            embed.add_field(name="Antes", value=helpers.truncate(old, 500), inline=False)
        if new:
            embed.add_field(name="Despues", value=helpers.truncate(new, 500), inline=False)
        await helpers.send_log(bot, guild, "casos_gestion", embed)
    except Exception:
        log.exception("No se pudo registrar el cambio del caso %s", number)


def format_line(row: dict) -> str:
    label, emoji, _ = modlog.describe(row["action"])
    head = f"#{row['number']} · {emoji} {label} · <t:{row['created_at']}:d>"
    if row.get("voided_at"):
        head += " · ANULADO"
    return head


def format_value(row: dict, show_user: bool = True) -> str:
    text = helpers.truncate(row["reason"] or "Sin motivo", 150)
    who = f"<@{row['user_id']}> · " if show_user else ""
    mark = " · ✏️ editado" if row.get("edited_at") else ""
    body = f"{who}por <@{row['moderator_id']}>{mark}\n{text}"
    return f"~~{body}~~" if row.get("voided_at") else body


async def appeal_status(bot, guild_id: int, number: int) -> str | None:
    return await bot.db.fetchval(
        "SELECT status FROM appeals WHERE guild_id=? AND case_number=?", (guild_id, number))
