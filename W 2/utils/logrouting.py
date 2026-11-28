"""Enrutado de logs por subcategoria (Stage 4B / Feature 02).

Cada subcategoria (config.LOG_SUBCATEGORIES) puede tener su propio canal. Sin
canal propio hereda el de su categoria padre; con valor 0 queda silenciada.
Los datos viven en la tabla log_channels ya existente (sin migracion).
"""

from __future__ import annotations

import discord

import config

MUTED = 0


def describe(channels: dict, key: str) -> str:
    """Texto con el destino efectivo de una categoria o subcategoria."""
    own = channels.get(key)
    sub = config.LOG_SUBCATEGORIES.get(key)
    if sub is None:
        return f"<#{own}>" if own else "sin configurar"
    if own == MUTED and key in channels:
        return "🔇 silenciado"
    if own:
        return f"<#{own}>"
    parent = channels.get(sub[0])
    return f"↳ <#{parent}> (hereda de **{sub[0]}**)" if parent else "sin configurar"


def check_channel(channel: discord.TextChannel, me: discord.Member) -> str | None:
    """None si el bot puede escribir embeds ahi; si no, el motivo."""
    perms = channel.permissions_for(me)
    missing = [n for n, ok in (("Ver canal", perms.view_channel),
                               ("Enviar mensajes", perms.send_messages),
                               ("Insertar enlaces", perms.embed_links)) if not ok]
    return f"Me faltan permisos en {channel.mention}: {', '.join(missing)}." if missing else None


async def assign(bot, guild_id: int, key: str, channel_id: int | None) -> bool:
    """channel_id: id = canal propio, None = heredar (borra), MUTED = silenciar."""
    if key not in config.LOG_SUBCATEGORIES:
        return False
    await bot.db.set_log_channel(guild_id, key, channel_id)
    return True


def lines(channels: dict) -> list[str]:
    out = []
    for parent, desc in config.LOG_CATEGORIES.items():
        out.append(f"**{parent}** — {describe(channels, parent)}")
        for key, (p, sdesc) in config.LOG_SUBCATEGORIES.items():
            if p == parent:
                out.append(f"  `{key}` — {describe(channels, key)}\n  *{sdesc}*")
    return out
