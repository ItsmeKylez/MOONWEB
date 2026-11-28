"""Sistema de apelaciones de sanciones.

Flujo:
  1. El sancionado (por el boton del DM o /apelar) envia su apelacion.
  2. Cae en el canal de log "apelaciones" (o "moderacion" si no hay) y en
     /apelacion lista.
  3. El staff la acepta o la deniega. Aceptar DESHACE la sancion (desbanea,
     quita el aislamiento o borra el aviso) y genera un caso normal.
  4. El usuario recibe un DM con la decision.

Reglas: desactivado por defecto, una apelacion por caso, solo el sancionado
puede apelar, ventana de tiempo configurable, maximo MAX_PENDING pendientes
por usuario y nadie puede resolver su propia apelacion.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time

import discord

import config
from . import embeds, helpers, modlog

log = logging.getLogger("bot.appeals")

APPEALABLE = modlog.APPEALABLE
MIN_REASON = 10
MAX_REASON = 1000
MAX_NOTE = 500
MAX_PENDING = 3
MAX_WINDOW_DAYS = 365
STATUS_LABELS = {"pending": "Pendiente", "accepted": "Aceptada", "denied": "Denegada"}

_decide_lock = asyncio.Lock()


async def get_config(bot, guild_id: int) -> dict:
    return await bot.db.get("appeal_config", guild_id)


async def get_appeal(bot, guild_id: int, appeal_id: int) -> dict | None:
    return await bot.db.fetchone(
        "SELECT * FROM appeals WHERE id=? AND guild_id=?", (appeal_id, guild_id))


async def _log(bot, guild: discord.Guild, embed: discord.Embed) -> None:
    channels = await bot.db.get_log_channels(guild.id)
    category = "apelaciones" if "apelaciones" in channels else "moderacion"
    await helpers.send_log(bot, guild, category, embed)


# ---------------------------------------------------------------------------
#  Envio
# ---------------------------------------------------------------------------
async def submit(bot, guild: discord.Guild, user, case_number: int,
                 reason: str) -> tuple[dict | None, str | None]:
    """Registra una apelacion. Devuelve (fila, None) o (None, motivo)."""
    cfg = await get_config(bot, guild.id)
    if not cfg.get("enabled"):
        return None, "Este servidor no tiene las apelaciones activadas."
    reason = (reason or "").strip()
    if len(reason) < MIN_REASON:
        return None, f"Explica tu apelacion con al menos {MIN_REASON} caracteres."
    reason = reason[:MAX_REASON]

    case = await modlog.get_case(bot, guild.id, case_number)
    if not case or case["user_id"] != user.id:
        # Mismo mensaje en ambos casos: no revelar casos de otras personas.
        return None, "No existe ese caso a tu nombre."
    if case["action"] not in APPEALABLE:
        return None, "Ese tipo de sancion no se puede apelar."
    days = cfg.get("window_days") or 0
    if days and int(time.time()) - (case["created_at"] or 0) > days * 86400:
        return None, f"Han pasado mas de {days} dia(s): ya no se puede apelar ese caso."
    if await bot.db.fetchone(
            "SELECT id FROM appeals WHERE guild_id=? AND case_number=?",
            (guild.id, case_number)):
        return None, "Ese caso ya tiene una apelacion registrada."
    pending = await bot.db.fetchval(
        "SELECT COUNT(*) FROM appeals WHERE guild_id=? AND user_id=? AND status='pending'",
        (guild.id, user.id), 0)
    if pending >= MAX_PENDING:
        return None, f"Ya tienes {MAX_PENDING} apelaciones pendientes. Espera a que las revisen."

    try:
        appeal_id = await bot.db.execute(
            "INSERT INTO appeals (guild_id, case_number, user_id, reason, status, created_at) "
            "VALUES (?,?,?,?, 'pending', ?)",
            (guild.id, case_number, user.id, reason, int(time.time())))
    except sqlite3.IntegrityError:
        return None, "Ese caso ya tiene una apelacion registrada."
    appeal = await get_appeal(bot, guild.id, appeal_id)

    label, emoji, _ = modlog.describe(case["action"])
    embed = embeds.base(f"📨 Nueva apelacion #{appeal_id} · Caso #{case_number}",
                        color=config.COLOR_INFO)
    embed.add_field(name="Usuario", value=helpers.fmt_user(user), inline=False)
    embed.add_field(name="Sancion", value=f"{emoji} {label}", inline=True)
    embed.add_field(name="Moderador", value=f"<@{case['moderator_id']}>", inline=True)
    embed.add_field(name="Motivo original", value=helpers.truncate(case["reason"], 500),
                    inline=False)
    embed.add_field(name="Apelacion", value=helpers.truncate(reason, 1000), inline=False)
    embed.set_footer(text=f"/apelacion aceptar id:{appeal_id}  ·  /apelacion denegar id:{appeal_id}")
    await _log(bot, guild, embed)
    return appeal, None


# ---------------------------------------------------------------------------
#  Resolucion
# ---------------------------------------------------------------------------
async def decide(bot, guild: discord.Guild, reviewer, appeal_id: int, accept: bool,
                 note: str | None = None) -> tuple[dict | None, str | None]:
    """Acepta o deniega. Devuelve (resultado, None) o (None, motivo)."""
    note = (note or "").strip()[:MAX_NOTE] or None
    async with _decide_lock:
        appeal = await get_appeal(bot, guild.id, appeal_id)
        if not appeal:
            return None, "No existe esa apelacion en este servidor."
        if appeal["status"] != "pending":
            return None, f"Esa apelacion ya esta {STATUS_LABELS[appeal['status']].lower()}."
        if appeal["user_id"] == reviewer.id:
            return None, "No puedes resolver tu propia apelacion."
        status = "accepted" if accept else "denied"
        await bot.db.execute(
            "UPDATE appeals SET status=?, reviewed_by=?, reviewed_at=?, review_note=? "
            "WHERE id=? AND status='pending'",
            (status, reviewer.id, int(time.time()), note, appeal_id))

    revert_note = None
    if accept:
        revert_note = await _revert(bot, guild, reviewer, appeal)
        await bot.db.execute("UPDATE appeals SET revert_note=? WHERE id=?",
                             (revert_note, appeal_id))

    appeal = await get_appeal(bot, guild.id, appeal_id)
    await _notify_user(bot, guild, appeal)

    embed = embeds.base(
        f"{'✅' if accept else '❌'} Apelacion #{appeal_id} {STATUS_LABELS[status].lower()} "
        f"· Caso #{appeal['case_number']}",
        color=config.COLOR_OK if accept else config.COLOR_ERROR)
    embed.add_field(name="Usuario", value=f"<@{appeal['user_id']}>", inline=True)
    embed.add_field(name="Revisada por", value=helpers.fmt_user(reviewer), inline=False)
    if note:
        embed.add_field(name="Nota", value=helpers.truncate(note, 500), inline=False)
    if revert_note:
        embed.add_field(name="Sancion deshecha", value=helpers.truncate(revert_note, 500),
                        inline=False)
    await _log(bot, guild, embed)
    return {"appeal": appeal, "revert_note": revert_note}, None


async def _revert(bot, guild: discord.Guild, reviewer, appeal: dict) -> str:
    """Deshace la sancion del caso apelado. Devuelve una frase con el resultado."""
    case = await modlog.get_case(bot, guild.id, appeal["case_number"])
    if not case:
        return "El caso original ya no existe; no hay nada que deshacer."
    action, user_id = case["action"], case["user_id"]
    reason = f"Apelacion #{appeal['id']} aceptada (caso #{case['number']})"

    try:
        if action in ("ban", "tempban"):
            try:
                await guild.unban(discord.Object(id=user_id), reason=reason)
                text = "Usuario desbaneado."
            except discord.NotFound:
                text = "El usuario ya no estaba baneado."
            await bot.db.execute(
                "DELETE FROM temp_actions WHERE guild_id=? AND user_id=? AND action='ban'",
                (guild.id, user_id))
            case_action = "unban"
        elif action == "timeout":
            member = guild.get_member(user_id)
            if member is not None and member.timed_out_until is not None:
                await member.timeout(None, reason=reason)
                text = "Aislamiento retirado."
            else:
                text = "El aislamiento ya habia terminado (o el usuario no esta en el servidor)."
            case_action = "untimeout"
        elif action == "warn":
            warn = await bot.db.fetchone(
                "SELECT id FROM warns WHERE guild_id=? AND user_id=? AND moderator_id=? "
                "AND ABS(created_at-?)<=120 ORDER BY ABS(created_at-?) LIMIT 1",
                (guild.id, user_id, case["moderator_id"], case["created_at"],
                 case["created_at"]))
            if warn:
                await bot.db.execute("DELETE FROM warns WHERE id=?", (warn["id"],))
                text = f"Aviso #{warn['id']} eliminado."
            else:
                text = "No encontre el aviso asociado (puede haberse borrado ya)."
            case_action = "unwarn"
        else:
            return "Esta sancion no se deshace automaticamente."
    except discord.Forbidden:
        return "No tengo permisos para deshacer la sancion: hazlo a mano."
    except discord.HTTPException as exc:
        return f"Error de Discord al deshacerla ({exc}): hazlo a mano."

    target = guild.get_member(user_id) or bot.get_user(user_id)
    if target is None:
        try:
            target = await bot.fetch_user(user_id)
        except discord.HTTPException:
            target = None
    if target is not None:
        number = await modlog.create_case(bot, guild, case_action, target, reviewer,
                                          reason, notify=False)
        text += f" Caso #{number}."
    return text


async def _notify_user(bot, guild: discord.Guild, appeal: dict) -> None:
    accepted = appeal["status"] == "accepted"
    user = bot.get_user(appeal["user_id"])
    if user is None:
        try:
            user = await bot.fetch_user(appeal["user_id"])
        except discord.HTTPException:
            return
    embed = embeds.base(
        f"Tu apelacion en {guild.name} ha sido {STATUS_LABELS[appeal['status']].lower()}",
        color=config.COLOR_OK if accepted else config.COLOR_ERROR)
    embed.add_field(name="Caso", value=f"#{appeal['case_number']}", inline=True)
    if appeal.get("review_note"):
        embed.add_field(name="Mensaje del staff",
                        value=helpers.truncate(appeal["review_note"], 500), inline=False)
    if accepted:
        embed.add_field(name="Resultado", value="La sancion ha sido retirada.", inline=False)
    await helpers.try_dm(user, embed=embed)
