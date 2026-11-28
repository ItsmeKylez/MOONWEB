"""Funciones compartidas por todos los cogs."""

from __future__ import annotations

import asyncio
import datetime as _dt
import re
from typing import Iterable

import discord

import config

INVITE_RE = re.compile(r"(discord\.(gg|io|me|li)|discordapp\.com/invite|discord\.com/invite)/[a-zA-Z0-9\-]+", re.I)
URL_RE = re.compile(r"https?://[^\s]+", re.I)
CUSTOM_EMOJI_RE = re.compile(r"<a?:\w+:\d+>")
UNICODE_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]"
)
# Marcas diacriticas combinantes -> texto "zalgo"
ZALGO_RE = re.compile("[̀-ͯ҉]")
# Espacios de anchura cero y marcas de direccion, usados para colar palabras
INVISIBLE_RE = re.compile("[​-‏‪-‮⁠-⁯﻿]")


# --- Formato ---------------------------------------------------------------
def fmt_user(user: discord.abc.User | None) -> str:
    if user is None:
        return "desconocido"
    return f"{user.mention} (`{user}` · `{user.id}`)"


def truncate(text: str | None, limit: int = 1000) -> str:
    if not text:
        return "*vacio*"
    text = str(text)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def code_block(text: str, lang: str = "") -> str:
    return f"```{lang}\n{truncate(text, 1900)}\n```"


def ts(dt: _dt.datetime | None, style: str = "R") -> str:
    """Marca de tiempo dinamica de Discord (<t:123:R>)."""
    if dt is None:
        return "desconocido"
    return f"<t:{int(dt.timestamp())}:{style}>"


def progress_bar(done: int, total: int, size: int = 18) -> str:
    if total <= 0:
        return "▱" * size
    filled = int(size * done / total)
    return "▰" * filled + "▱" * (size - filled)


def chunk(items: list, size: int) -> Iterable[list]:
    for i in range(0, len(items), size):
        yield items[i: i + size]


# --- Logs ------------------------------------------------------------------
def log_channel_candidates(channels: dict, category: str) -> list[int]:
    """IDs de canal a probar, en orden, para una categoria o subcategoria.

    Valor 0 en una subcategoria = silenciada (no se envia a ningun sitio).
    """
    own = channels.get(category)
    sub = config.LOG_SUBCATEGORIES.get(category)
    if sub is None:
        return [own] if own else []
    if own == 0:
        return []
    parent = channels.get(sub[0])
    return [c for c in (own, parent) if c]


async def send_log(bot, guild: discord.Guild, category: str,
                   embed: discord.Embed, file: discord.File | None = None,
                   content: str | None = None,
                   allowed_mentions: discord.AllowedMentions | None = None
                   ) -> discord.Message | None:
    """Manda un embed al canal de log de esa categoria, si esta configurado.

    El bot desactiva las menciones globalmente, asi que las alertas que si
    deben sonar tienen que pasar su propio allowed_mentions."""
    if guild is None:
        return None
    channels = await bot.db.get_log_channels(guild.id)
    # Una subcategoria usa su canal propio y, si no existe o no se puede usar,
    # el de su categoria padre (ver config.LOG_SUBCATEGORIES).
    for channel_id in log_channel_candidates(channels, category):
        channel = guild.get_channel(channel_id)
        if channel is None or not isinstance(channel, discord.TextChannel):
            continue
        perms = channel.permissions_for(guild.me)
        if not (perms.send_messages and perms.embed_links):
            continue
        try:
            return await channel.send(content=content, embed=embed, file=file,
                                      allowed_mentions=allowed_mentions or
                                      discord.AllowedMentions.none())
        except (discord.Forbidden, discord.HTTPException):
            continue
    return None


async def is_ignored(bot, guild_id: int, channel: discord.abc.GuildChannel | None,
                     member: discord.Member | None) -> bool:
    """True si el canal, el usuario o alguno de sus roles esta en la lista de
    ignorados de ese servidor."""
    data = await bot.db.get_ignored(guild_id)
    if channel is not None:
        if channel.id in data["channel"]:
            return True
        parent = getattr(channel, "category_id", None)
        if parent and parent in data["channel"]:
            return True
    if member is not None:
        if member.id in data["user"]:
            return True
        if data["role"] and any(r.id in data["role"] for r in getattr(member, "roles", [])):
            return True
    return False


# --- Audit log -------------------------------------------------------------
async def find_audit(guild: discord.Guild, action: discord.AuditLogAction,
                     target_id: int | None = None, within: int = 20,
                     delay: float = 1.2) -> discord.AuditLogEntry | None:
    """Busca en el audit log quien hizo algo.

    El audit log de Discord llega con retraso, por eso esperamos un momento
    antes de consultarlo.  Si el bot no tiene el permiso, devolvemos None y
    el llamante simplemente registra 'desconocido'.
    """
    if not guild.me.guild_permissions.view_audit_log:
        return None
    if delay:
        await asyncio.sleep(delay)
    now = discord.utils.utcnow()
    try:
        async for entry in guild.audit_logs(limit=10, action=action):
            if (now - entry.created_at).total_seconds() > within:
                continue
            if target_id is not None:
                tid = getattr(entry.target, "id", entry.target)
                if tid != target_id:
                    continue
            return entry
    except (discord.Forbidden, discord.HTTPException):
        return None
    return None


# --- Jerarquia y permisos --------------------------------------------------
def can_act_on(guild: discord.Guild, actor: discord.Member,
               target: discord.Member) -> str | None:
    """Devuelve None si `actor` puede sancionar a `target`, o el motivo del
    rechazo.  Comprueba tambien que el propio bot pueda hacerlo."""
    if target.id == actor.id:
        return "No puedes aplicarte una sancion a ti mismo."
    if target.id == guild.owner_id:
        return "No se puede sancionar al dueño del servidor."
    if target.id == guild.me.id:
        return "No voy a sancionarme a mi mismo."
    if actor.id != guild.owner_id and target.top_role >= actor.top_role:
        return "Ese usuario tiene un rol igual o superior al tuyo."
    if target.top_role >= guild.me.top_role:
        return ("Mi rol esta por debajo del suyo. Sube el rol del bot en "
                "Ajustes del servidor > Roles.")
    return None


async def is_staff(bot, member: discord.Member) -> bool:
    """Staff = permiso de moderar mensajes, o el rol de staff/admin configurado."""
    if member.guild_permissions.administrator or member.id == member.guild.owner_id:
        return True
    cfg = await bot.db.get("guild_config", member.guild.id)
    role_ids = {cfg.get("staff_role"), cfg.get("admin_role")} - {None}
    if role_ids and any(r.id in role_ids for r in member.roles):
        return True
    return member.guild_permissions.manage_messages or member.guild_permissions.moderate_members


async def is_admin(bot, member: discord.Member) -> bool:
    if member.guild_permissions.administrator or member.id == member.guild.owner_id:
        return True
    cfg = await bot.db.get("guild_config", member.guild.id)
    admin_role = cfg.get("admin_role")
    return bool(admin_role) and any(r.id == admin_role for r in member.roles)


# --- Envio seguro ----------------------------------------------------------
async def try_dm(user: discord.abc.User, **kwargs) -> bool:
    """Intenta mandar un DM.  Devuelve False si el usuario los tiene cerrados."""
    try:
        await user.send(**kwargs)
        return True
    except (discord.Forbidden, discord.HTTPException, AttributeError):
        return False


async def safe_respond(interaction: discord.Interaction, **kwargs) -> None:
    """Responde a una interaccion tanto si ya se habia diferido como si no."""
    try:
        if interaction.response.is_done():
            await interaction.followup.send(**kwargs)
        else:
            await interaction.response.send_message(**kwargs)
    except discord.HTTPException:
        pass


# --- Analisis de texto (usado por el anti-spam) ----------------------------
def count_emojis(text: str) -> int:
    return len(CUSTOM_EMOJI_RE.findall(text)) + len(UNICODE_EMOJI_RE.findall(text))


def caps_ratio(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if c.isupper()) / len(letters)


def normalize(text: str) -> str:
    """Quita separadores y sustituye numeros por letras para detectar
    evasiones tipo  'p-a-l-4-b-r-a'  en el filtro de palabras."""
    text = INVISIBLE_RE.sub("", text.lower())
    text = re.sub(r"[\s\.\-_\*|~`'\"]+", "", text)
    table = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
                           "7": "t", "8": "b", "@": "a", "$": "s", "!": "i"})
    return text.translate(table)


def similarity(a: str, b: str) -> float:
    """Parecido rapido entre dos cadenas (0..1) sin dependencias externas."""
    a, b = a.lower(), b.lower()
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    matches = sum(1 for i, ch in enumerate(shorter) if i < len(longer) and longer[i] == ch)
    return matches / len(longer)


def has_dangerous_permissions(perms: discord.Permissions) -> list[str]:
    return [p for p in config.DANGEROUS_PERMISSIONS if getattr(perms, p, False)]
