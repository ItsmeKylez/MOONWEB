"""Escalada automatica de sanciones segun el numero de avisos.

Reglas de funcionamiento (todas configurables por un administrador):
  * Esta desactivada por defecto. Sin reglas definidas no ocurre nada.
  * Cada regla es "al llegar a N avisos -> accion (+ duracion)".
  * Tras un /warn se cuentan los avisos ACTUALES del usuario y se aplica como
    maximo UNA regla: la de mayor umbral que ya se haya alcanzado.
  * Una regla no se repite mientras el usuario siga por encima de su umbral.
    Solo cuentan los avisos NO caducados (Feature 05).
    Si los avisos bajan (delwarn / clearwarns / panel web) el umbral se
    "rearma" y volvera a aplicarse si el usuario lo alcanza de nuevo.
  * Todo queda en escalation_history y genera un caso normal (con el bot
    como moderador) para que aparezca en /caso, /historial y el log.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import timedelta

import discord

import config
from . import embeds, helpers, modlog
from .time_parser import human_duration

log = logging.getLogger("bot.escalation")

ACTIONS = ("timeout", "kick", "ban")
MAX_TIMEOUT = 28 * 86400
MAX_THRESHOLD = 50
MAX_RULES = 15

ACTION_LABELS = {"timeout": "Aislamiento", "kick": "Expulsion", "ban": "Baneo"}

# Un bloqueo por (servidor, usuario): dos /warn simultaneos no pueden aplicar
# la misma escalada dos veces.
_locks: dict[tuple[int, int], asyncio.Lock] = {}


def _lock_for(guild_id: int, user_id: int) -> asyncio.Lock:
    key = (guild_id, user_id)
    lock = _locks.get(key)
    if lock is None:
        lock = _locks[key] = asyncio.Lock()
    return lock


# ---------------------------------------------------------------------------
#  Validacion y seleccion (logica pura, sin Discord)
# ---------------------------------------------------------------------------
def validate_rule(threshold: int, action: str, duration: int | None) -> str | None:
    """Devuelve el motivo del rechazo o None si la regla es valida."""
    if not 1 <= threshold <= MAX_THRESHOLD:
        return f"El umbral debe estar entre 1 y {MAX_THRESHOLD} avisos."
    if action not in ACTIONS:
        return "Accion no valida. Usa timeout, kick o ban."
    if action == "timeout":
        if not duration:
            return "El aislamiento necesita una duracion (ej. `1h`, `2d`)."
        if duration > MAX_TIMEOUT:
            return "Discord no permite aislar mas de 28 dias."
    if action == "kick" and duration:
        return "La expulsion no admite duracion."
    return None


def pick_rule(rules: list[dict], warn_count: int) -> dict | None:
    """Regla de mayor umbral alcanzado por `warn_count`, o None."""
    reached = [r for r in rules if r["threshold"] <= warn_count]
    return max(reached, key=lambda r: r["threshold"]) if reached else None


def describe_rule(rule: dict) -> str:
    label = ACTION_LABELS.get(rule["action"], rule["action"])
    if rule["action"] == "ban" and not rule.get("duration"):
        return f"{label} permanente"
    if rule.get("duration"):
        return f"{label} de {human_duration(rule['duration'])}"
    return label


# ---------------------------------------------------------------------------
#  Acceso a datos
# ---------------------------------------------------------------------------
async def get_rules(bot, guild_id: int) -> list[dict]:
    return await bot.db.fetchall(
        "SELECT * FROM escalation_rules WHERE guild_id=? ORDER BY threshold", (guild_id,))


async def is_enabled(bot, guild_id: int) -> bool:
    cfg = await bot.db.get("escalation_config", guild_id)
    return bool(cfg.get("enabled"))


async def rearm(bot, guild_id: int, user_id: int, warn_count: int) -> None:
    """Desactiva las escaladas cuyo umbral el usuario ya no alcanza."""
    await bot.db.execute(
        "UPDATE escalation_history SET active=0 "
        "WHERE guild_id=? AND user_id=? AND active=1 AND threshold>?",
        (guild_id, user_id, warn_count))


# ---------------------------------------------------------------------------
#  Evaluacion
# ---------------------------------------------------------------------------
async def evaluate(bot, guild: discord.Guild, member: discord.Member,
                   warn_id: int | None = None) -> dict | None:
    """Comprueba los avisos de `member` y aplica la escalada que toque.

    Devuelve un dict con lo ocurrido (para que /warn lo muestre) o None si no
    hubo escalada.
    """
    if not await is_enabled(bot, guild.id):
        return None
    rules = await get_rules(bot, guild.id)
    if not rules:
        return None

    async with _lock_for(guild.id, member.id):
        count = await bot.db.fetchval(
            "SELECT COUNT(*) FROM warns WHERE guild_id=? AND user_id=? AND expired_at IS NULL",
            (guild.id, member.id), 0)
        await rearm(bot, guild.id, member.id, count)

        rule = pick_rule(rules, count)
        if rule is None:
            return None

        already = await bot.db.fetchval(
            "SELECT id FROM escalation_history "
            "WHERE guild_id=? AND user_id=? AND threshold=? AND active=1",
            (guild.id, member.id, rule["threshold"]))
        if already:
            return None

        return await _apply(bot, guild, member, rule, count, warn_id)


async def _apply(bot, guild: discord.Guild, member: discord.Member, rule: dict,
                 count: int, warn_id: int | None) -> dict:
    action, duration = rule["action"], rule["duration"]
    reason = (f"Escalada automatica: {count} aviso(s) "
              f"(umbral {rule['threshold']} -> {describe_rule(rule).lower()})")
    status, detail = "applied", None

    problem = _bot_cannot_punish(guild, member)
    if problem:
        status, detail = "failed", problem
    else:
        try:
            if action == "timeout":
                await member.timeout(timedelta(seconds=duration), reason=reason)
            elif action == "kick":
                await member.kick(reason=reason)
            elif action == "ban":
                await guild.ban(member, reason=reason, delete_message_seconds=0)
                if duration:
                    await bot.db.execute(
                        "INSERT INTO temp_actions (guild_id, user_id, action, expires_at) "
                        "VALUES (?,?,?,?)",
                        (guild.id, member.id, "ban", int(time.time()) + duration))
        except discord.Forbidden:
            status, detail = "failed", "Discord denego la accion (permisos o jerarquia de roles)."
        except discord.HTTPException as exc:
            status, detail = "failed", f"Error de Discord: {exc}"

    case_number = None
    if status == "applied":
        case_action = "tempban" if (action == "ban" and duration) else action
        # En una expulsion/baneo el usuario ya no esta: no hay a quien notificar.
        case_number = await modlog.create_case(
            bot, guild, case_action, member, bot.user, reason, duration,
            notify=action == "timeout")

    await bot.db.execute(
        "INSERT INTO escalation_history (guild_id, user_id, threshold, action, duration, "
        "warn_count, warn_id, case_number, status, detail, active, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,1,?)",
        (guild.id, member.id, rule["threshold"], action, duration, count, warn_id,
         case_number, status, detail, int(time.time())))

    result = {"rule": rule, "count": count, "status": status, "detail": detail,
              "case": case_number, "text": describe_rule(rule)}
    await _log(bot, guild, member, result)
    if status == "failed":
        log.warning("Escalada fallida en %s para %s: %s", guild.id, member.id, detail)
    return result


def _bot_cannot_punish(guild: discord.Guild, member: discord.Member) -> str | None:
    if member.id == guild.owner_id:
        return "No se puede sancionar al dueño del servidor."
    me = guild.me
    if member.top_role >= me.top_role:
        return "El rol del usuario esta por encima o al mismo nivel que el del bot."
    return None


async def _log(bot, guild: discord.Guild, member: discord.Member, result: dict) -> None:
    """Aviso en el canal de moderacion (aparte del caso, que ya publica modlog)."""
    ok = result["status"] == "applied"
    embed = embeds.base(
        f"{config.E_SHIELD} Escalada automatica {'aplicada' if ok else 'FALLIDA'}",
        color=config.COLOR_SECURITY if ok else config.COLOR_ERROR)
    embed.add_field(name="Usuario", value=helpers.fmt_user(member), inline=False)
    embed.add_field(name="Avisos", value=str(result["count"]), inline=True)
    embed.add_field(name="Umbral", value=str(result["rule"]["threshold"]), inline=True)
    embed.add_field(name="Sancion", value=result["text"], inline=True)
    if result["case"]:
        embed.add_field(name="Caso", value=f"#{result['case']}", inline=True)
    if result["detail"]:
        embed.add_field(name="Motivo del fallo", value=helpers.truncate(result["detail"], 500),
                        inline=False)
    await helpers.send_log(bot, guild, "casos_gestion", embed)
