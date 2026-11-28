"""Evidencias (capturas, videos, documentos) adjuntas a los casos de moderacion.

Los adjuntos de Discord se descargan y se guardan en data/evidence/ porque las
URLs del CDN caducan. Solo se guardan bytes; nunca se ejecutan.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid

import discord

log = logging.getLogger("bot.evidence")

MAX_SIZE = 8 * 1024 * 1024        # 8 MB por archivo (limite de subida de Discord sin boost)
MAX_PER_CASE = 10
MAX_NOTE = 200

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_filename(name: str | None) -> str:
    """Nombre sin rutas ni caracteres raros, con longitud acotada."""
    name = os.path.basename((name or "").replace("\\", "/")) or "archivo"
    name = _SAFE.sub("_", name).strip("._") or "archivo"
    root, ext = os.path.splitext(name)
    return root[:60] + ext[:10]


def validate_attachment(att) -> str | None:
    """Motivo del rechazo, o None si el adjunto es aceptable."""
    if att is None:
        return "No hay ningun archivo."
    if att.size <= 0:
        return "El archivo esta vacio."
    if att.size > MAX_SIZE:
        return f"El archivo supera el maximo de {MAX_SIZE // (1024 * 1024)} MB."
    return None


def evidence_dir(bot) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(bot.db.path)), "evidence")


def resolve_path(bot, stored_path: str) -> str | None:
    """Ruta absoluta de un archivo guardado, solo si queda DENTRO de data/evidence/."""
    base = os.path.realpath(evidence_dir(bot))
    full = os.path.realpath(os.path.join(base, stored_path))
    return full if full.startswith(base + os.sep) else None


async def count_for_case(bot, guild_id: int, case_number: int) -> int:
    return await bot.db.fetchval(
        "SELECT COUNT(*) FROM case_evidence WHERE guild_id=? AND case_number=?",
        (guild_id, case_number), 0)


async def list_for_case(bot, guild_id: int, case_number: int) -> list[dict]:
    return await bot.db.fetchall(
        "SELECT * FROM case_evidence WHERE guild_id=? AND case_number=? ORDER BY id",
        (guild_id, case_number))


async def add(bot, guild_id: int, case_number: int, attachment, added_by: int,
              note: str | None = None) -> tuple[dict | None, str | None]:
    """Descarga y guarda un adjunto. Devuelve (fila, None) o (None, motivo)."""
    problem = validate_attachment(attachment)
    if problem:
        return None, problem
    if await count_for_case(bot, guild_id, case_number) >= MAX_PER_CASE:
        return None, f"Un caso admite como maximo {MAX_PER_CASE} evidencias."
    try:
        data = await attachment.read()
    except discord.HTTPException:
        return None, "No pude descargar el archivo desde Discord."
    if len(data) > MAX_SIZE:
        return None, "El archivo supera el tamaño maximo."

    filename = safe_filename(attachment.filename)
    rel = os.path.join(str(guild_id), f"{case_number}_{uuid.uuid4().hex[:8]}_{filename}")
    full = resolve_path(bot, rel)
    if full is None:
        return None, "Nombre de archivo no valido."
    try:
        await asyncio.to_thread(_write, full, data)
    except OSError:
        log.exception("No se pudo guardar la evidencia %s", rel)
        return None, "No pude guardar el archivo en el disco del bot."

    note = (note or "").strip()[:MAX_NOTE] or None
    row_id = await bot.db.execute(
        "INSERT INTO case_evidence (guild_id, case_number, filename, stored_path, "
        "content_type, size, note, added_by, added_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (guild_id, case_number, filename, rel, getattr(attachment, "content_type", None),
         len(data), note, added_by, int(time.time())))
    row = await bot.db.fetchone("SELECT * FROM case_evidence WHERE id=?", (row_id,))
    return row, None


def _write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


async def remove(bot, guild_id: int, evidence_id: int) -> bool:
    """Borra la fila y el archivo. False si no existe en ese servidor."""
    row = await bot.db.fetchone(
        "SELECT * FROM case_evidence WHERE id=? AND guild_id=?", (evidence_id, guild_id))
    if not row:
        return False
    await bot.db.execute("DELETE FROM case_evidence WHERE id=?", (evidence_id,))
    full = resolve_path(bot, row["stored_path"])
    if full:
        try:
            await asyncio.to_thread(os.remove, full)
        except OSError:
            pass
    return True


async def attach_on_action(bot, guild_id: int, case_number: int, attachment,
                           moderator_id: int) -> str:
    """Usado por /warn, /ban, /kick y /timeout. Devuelve una linea para la
    respuesta ('' si no habia adjunto). Un fallo aqui nunca deshace la sancion."""
    if attachment is None:
        return ""
    row, err = await add(bot, guild_id, case_number, attachment, moderator_id)
    if err:
        return f"\n⚠️ Evidencia no guardada: {err}"
    return f"\n📎 Evidencia #{row['id']} guardada en el caso."
