"""Expiracion configurable de avisos (Stage 4A / Feature 05).

  * Por defecto desactivada (days=0): ningun aviso caduca.
  * Un aviso caducado no se borra; se marca con expired_at. Deja de contar para
    la escalada, /userinfo y los totales, pero sigue en /warns y en el panel.
  * Caducar NUNCA aplica ni revierte sanciones: solo reduce el recuento. La
    escalada se rearma sola en el siguiente /warn (comportamiento existente).
  * Cambiar los dias afecta a TODOS los avisos del servidor: los que ya superen
    el nuevo plazo caducan en la siguiente pasada.
"""

from __future__ import annotations

import asyncio
import logging
import time

import discord

import config
from . import embeds, helpers

log = logging.getLogger("bot.warnexpiry")

DAY = 86400
MAX_DAYS = 3650
ACTIVE = "expired_at IS NULL"   # fragmento SQL: avisos que cuentan

# Serializa las pasadas: la tarea periodica y /expiracion ahora no pueden solaparse
# (si no, un aviso se contaria/registraria dos veces).
_sweep_lock = asyncio.Lock()


async def get_config(bot, guild_id: int) -> dict:
    return await bot.db.get("warn_expiry_config", guild_id)


def validate_days(days) -> str | None:
    if not isinstance(days, int) or isinstance(days, bool):
        return "Los dias deben ser un numero entero."
    if days < 0 or days > MAX_DAYS:
        return f"Los dias deben estar entre 0 (nunca) y {MAX_DAYS}."
    return None


def expires_at(created_at: int, days: int) -> int | None:
    """Momento en que caduca un aviso, o None si no caduca."""
    return created_at + days * DAY if days > 0 else None


async def count_active(bot, guild_id: int, user_id: int) -> int:
    return await bot.db.fetchval(
        f"SELECT COUNT(*) FROM warns WHERE guild_id=? AND user_id=? AND {ACTIVE}",
        (guild_id, user_id), 0)


async def pending_count(bot, guild_id: int, days: int, now: int | None = None) -> int:
    """Avisos activos que caducarian ahora con `days` (vista previa)."""
    if days <= 0:
        return 0
    now = now or int(time.time())
    return await bot.db.fetchval(
        f"SELECT COUNT(*) FROM warns WHERE guild_id=? AND {ACTIVE} AND created_at<=?",
        (guild_id, now - days * DAY), 0)


async def sweep_guild(bot, guild_id: int, now: int | None = None) -> list[dict]:
    """Marca como caducados los avisos vencidos. Devuelve [{user_id, count}].

    Idempotente: solo toca filas con expired_at NULL, asi que una pasada repetida
    o simultanea no vuelve a procesar nada.
    """
    async with _sweep_lock:
        cfg = await get_config(bot, guild_id)
        days = cfg["days"] or 0
        if days <= 0:
            return []
        now = now or int(time.time())
        cutoff = now - days * DAY
        rows = await bot.db.fetchall(
            f"SELECT id, user_id FROM warns WHERE guild_id=? AND {ACTIVE} AND created_at<=?",
            (guild_id, cutoff))
        if not rows:
            return []
        await bot.db.execute(
            f"UPDATE warns SET expired_at=? WHERE guild_id=? AND {ACTIVE} AND created_at<=?",
            (now, guild_id, cutoff))
    per_user: dict[int, int] = {}
    for r in rows:
        per_user[r["user_id"]] = per_user.get(r["user_id"], 0) + 1
    return [{"user_id": u, "count": c} for u, c in per_user.items()]


async def sweep_all(bot) -> None:
    rows = await bot.db.fetchall("SELECT guild_id FROM warn_expiry_config WHERE days>0")
    for row in rows:
        gid = row["guild_id"]
        try:
            expired = await sweep_guild(bot, gid)
            guild = bot.get_guild(gid)
            if expired and guild is not None:
                await log_expired(bot, guild, expired)
        except Exception:
            log.exception("Fallo al caducar avisos en %s", gid)


async def log_expired(bot, guild: discord.Guild, expired: list[dict]) -> None:
    cfg = await get_config(bot, guild.id)
    if not cfg["notify"]:
        return
    total = sum(e["count"] for e in expired)
    embed = embeds.base(f"{config.E_SHIELD} Avisos caducados", color=config.COLOR_OK)
    embed.add_field(name="Avisos", value=str(total), inline=True)
    embed.add_field(name="Usuarios", value=str(len(expired)), inline=True)
    embed.add_field(name="Plazo", value=f"{cfg['days']} dia(s)", inline=True)
    lines = [f"<@{e['user_id']}> · {e['count']}" for e in expired[:15]]
    if len(expired) > 15:
        lines.append(f"... y {len(expired) - 15} usuario(s) mas")
    embed.add_field(name="Detalle", value=helpers.truncate("\n".join(lines), 1000), inline=False)
    await helpers.send_log(bot, guild, "casos_gestion", embed)
