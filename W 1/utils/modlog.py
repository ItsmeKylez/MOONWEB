"""Registro de sanciones.

Todas las sanciones del bot (manuales, del anti-spam o del anti-nuke) pasan
por aqui, de modo que siempre generan un caso numerado, un aviso en el canal
de moderacion y un DM al sancionado.
"""

from __future__ import annotations

import time

import discord

import config
from . import embeds, helpers
from .time_parser import human_duration

ACTIONS = {
    "ban":        ("Baneo", config.E_HAMMER, config.COLOR_ERROR),
    "tempban":    ("Baneo temporal", config.E_HAMMER, config.COLOR_ERROR),
    "softban":    ("Softban", config.E_HAMMER, config.COLOR_MOD),
    "unban":      ("Desbaneo", config.E_OK, config.COLOR_OK),
    "kick":       ("Expulsion", config.E_BOOT, config.COLOR_MOD),
    "timeout":    ("Aislamiento", config.E_MUTE, config.COLOR_WARN),
    "untimeout":  ("Fin del aislamiento", config.E_OK, config.COLOR_OK),
    "warn":       ("Aviso", config.E_WARN, config.COLOR_WARN),
    "unwarn":     ("Aviso retirado", config.E_OK, config.COLOR_OK),
    "quarantine": ("Cuarentena", config.E_SHIELD, config.COLOR_SECURITY),
    "strip":      ("Roles retirados", config.E_SHIELD, config.COLOR_SECURITY),
    "purge":      ("Purga de mensajes", config.E_TRASH, config.COLOR_MOD),
}


def describe(action: str) -> tuple[str, str, int]:
    return ACTIONS.get(action, (action.capitalize(), config.E_INFO, config.COLOR_MOD))


async def create_case(bot, guild: discord.Guild, action: str,
                      target: discord.abc.User, moderator: discord.abc.User,
                      reason: str | None = None, duration: int | None = None,
                      notify: bool = True) -> int:
    """Crea el caso, lo publica en el log de moderacion y avisa al usuario."""
    reason = (reason or "Sin motivo indicado")[:900]
    number = await bot.db.next_counter(guild.id, "case_counter")
    await bot.db.execute(
        "INSERT INTO cases (guild_id, number, action, user_id, moderator_id, reason, "
        "duration, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (guild.id, number, action, target.id, moderator.id, reason, duration,
         int(time.time())),
    )

    label, emoji, color = describe(action)
    embed = embeds.base(f"{emoji} {label} · Caso #{number}", color=color)
    embed.add_field(name="Usuario", value=helpers.fmt_user(target), inline=False)
    embed.add_field(name="Moderador", value=helpers.fmt_user(moderator), inline=False)
    if duration:
        embed.add_field(name="Duracion", value=human_duration(duration), inline=True)
    embed.add_field(name="Motivo", value=helpers.truncate(reason, 900), inline=False)
    embed.set_thumbnail(url=target.display_avatar.url)
    await helpers.send_log(bot, guild, "moderacion", embed)

    if notify:
        cfg = await bot.db.get("guild_config", guild.id)
        if cfg.get("dm_on_punish"):
            await _notify(guild, target, label, reason, duration, color)
    return number


async def _notify(guild: discord.Guild, target: discord.abc.User, label: str,
                  reason: str, duration: int | None, color: int) -> None:
    embed = embeds.base(f"{label} en {guild.name}", color=color)
    embed.add_field(name="Motivo", value=helpers.truncate(reason, 900), inline=False)
    if duration:
        embed.add_field(name="Duracion", value=human_duration(duration), inline=True)
    embed.set_footer(text=guild.name, icon_url=guild.icon.url if guild.icon else None)
    await helpers.try_dm(target, embed=embed)


async def get_case(bot, guild_id: int, number: int) -> dict | None:
    return await bot.db.fetchone(
        "SELECT * FROM cases WHERE guild_id=? AND number=?", (guild_id, number)
    )


async def user_history(bot, guild_id: int, user_id: int, limit: int = 100) -> list[dict]:
    return await bot.db.fetchall(
        "SELECT * FROM cases WHERE guild_id=? AND user_id=? ORDER BY number DESC LIMIT ?",
        (guild_id, user_id, limit),
    )
