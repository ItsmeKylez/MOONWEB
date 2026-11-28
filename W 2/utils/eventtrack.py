"""Seguimiento ampliado de eventos (Stage 4B / Feature 01).

Anade eventos que cogs/logs.py no cubre. Cada uno se manda a una categoria de
log YA existente (mensajes / miembros / servidor / voz / moderacion /
seguridad), asi que respeta los canales que el admin ya configuro; si la
categoria no tiene canal, no se envia nada. Cada evento se puede activar o
desactivar por servidor con /eventos. La logica de comparacion vive aqui como
funciones puras para poder probarla sin Discord.
"""

from __future__ import annotations

import logging
import time

import discord

import config
from . import embeds, helpers

log = logging.getLogger("bot.eventtrack")

# clave -> (descripcion, categoria de log, activado por defecto)
EVENTS: dict[str, tuple[str, str, bool]] = {
    "thread_update":   ("Hilos renombrados, archivados, bloqueados o con modo lento", "canales", True),
    "thread_member":   ("Miembros que entran o salen de un hilo (mucho volumen)", "servidor", False),
    "stage":           ("Stage iniciado, editado o terminado", "voz", True),
    "scheduled_event": ("Eventos programados creados, editados o borrados", "ajustes_servidor", True),
    "automod_rule":    ("Reglas de AutoMod creadas, editadas o borradas", "ajustes_servidor", True),
    "automod_action":  ("Acciones ejecutadas por AutoMod de Discord", "automod", True),
    "reaction_clear":  ("Reacciones eliminadas en bloque de un mensaje", "mensajes", True),
    "pins":            ("Pines de un canal actualizados", "mensajes", True),
    "voice_server":    ("Silencio / ensordecimiento aplicado por un moderador en voz", "voz", True),
    "voice_stream":    ("Transmision de pantalla o camara en voz (mucho volumen)", "voz", False),
    "boost":           ("Miembros que empiezan o dejan de impulsar el servidor", "miembros", True),
    "timeout_removed": ("Aislamientos retirados (manual o por Discord)", "moderacion", True),
}


async def is_enabled(bot, guild_id: int, key: str) -> bool:
    if key not in EVENTS:
        return False
    row = await bot.db.fetchone(
        "SELECT enabled FROM event_toggles WHERE guild_id=? AND event=?", (guild_id, key))
    return bool(row["enabled"]) if row else EVENTS[key][2]


async def set_enabled(bot, guild_id: int, key: str, enabled: bool) -> bool:
    """False si la clave no existe. Guarda solo si difiere del valor por defecto."""
    if key not in EVENTS:
        return False
    if enabled == EVENTS[key][2]:
        await bot.db.execute("DELETE FROM event_toggles WHERE guild_id=? AND event=?",
                             (guild_id, key))
    else:
        await bot.db.execute(
            "INSERT OR REPLACE INTO event_toggles (guild_id, event, enabled) VALUES (?,?,?)",
            (guild_id, key, int(enabled)))
    return True


async def status(bot, guild_id: int) -> dict[str, bool]:
    rows = await bot.db.fetchall("SELECT event, enabled FROM event_toggles WHERE guild_id=?", (guild_id,))
    over = {r["event"]: bool(r["enabled"]) for r in rows}
    return {k: over.get(k, v[2]) for k, v in EVENTS.items()}


class Deduper:
    """Evita procesar dos veces el mismo evento (reentregas del gateway)."""

    def __init__(self, ttl: float = 5.0, max_size: int = 2000):
        self.ttl, self.max_size = ttl, max_size
        self._seen: dict[tuple, float] = {}

    def seen(self, key: tuple, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if len(self._seen) > self.max_size:
            self._seen = {k: t for k, t in self._seen.items() if now - t < self.ttl}
        last = self._seen.get(key)
        self._seen[key] = now
        return last is not None and now - last < self.ttl


async def emit(bot, guild: discord.Guild, key: str, embed: discord.Embed,
               channel=None, member=None) -> bool:
    """Envia el embed si el evento esta activo y no esta ignorado. True si se intento."""
    if guild is None or not await is_enabled(bot, guild.id, key):
        return False
    if (channel is not None or member is not None) and \
            await helpers.is_ignored(bot, guild.id, channel, member):
        return False
    await helpers.send_log(bot, guild, EVENTS[key][1], embed)
    return True


# --- comparaciones puras ----------------------------------------------------
def _show(v) -> str:
    if v is None or v == "":
        return "*ninguno*"
    if isinstance(v, bool):
        return "si" if v else "no"
    return helpers.truncate(str(v), 300)


def diff_attrs(before, after, attrs: dict[str, str]) -> list[tuple[str, str, str]]:
    """[(etiqueta, antes, despues)] de los atributos que cambiaron."""
    out = []
    for attr, label in attrs.items():
        b, a = getattr(before, attr, None), getattr(after, attr, None)
        if b != a:
            out.append((label, _show(b), _show(a)))
    return out


THREAD_ATTRS = {"name": "Nombre", "archived": "Archivado", "locked": "Bloqueado",
                "slowmode_delay": "Modo lento (s)", "auto_archive_duration": "Autoarchivo (min)"}
EVENT_ATTRS = {"name": "Nombre", "description": "Descripcion", "start_time": "Inicio",
               "end_time": "Fin", "status": "Estado", "location": "Lugar"}


def voice_server_changes(before, after) -> list[str]:
    out = []
    if before.mute != after.mute:
        out.append("silenciado por el servidor" if after.mute else "ya no esta silenciado por el servidor")
    if before.deaf != after.deaf:
        out.append("ensordecido por el servidor" if after.deaf else "ya no esta ensordecido por el servidor")
    return out


def voice_stream_changes(before, after) -> list[str]:
    out = []
    if before.self_stream != after.self_stream:
        out.append("empieza a transmitir pantalla" if after.self_stream else "deja de transmitir pantalla")
    if before.self_video != after.self_video:
        out.append("enciende la camara" if after.self_video else "apaga la camara")
    return out


def change_embed(title: str, color: int, changes: list[tuple[str, str, str]]) -> discord.Embed:
    embed = embeds.base(title, color=color)
    for label, b, a in changes[:10]:
        embed.add_field(name=label, value=f"{b} → {a}", inline=False)
    return embed
