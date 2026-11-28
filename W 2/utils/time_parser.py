"""Conversion entre '2h30m' y segundos, en los dos sentidos."""

from __future__ import annotations

import re

_UNITS = {
    "s": 1,
    "seg": 1,
    "m": 60,
    "min": 60,
    "h": 3600,
    "hora": 3600,
    "horas": 3600,
    "d": 86400,
    "dia": 86400,
    "dias": 86400,
    "w": 604800,
    "sem": 604800,
    "mo": 2592000,
    "y": 31536000,
}

_PATTERN = re.compile(r"(\d+)\s*([a-zA-Z]+)")


def parse_duration(text: str) -> int | None:
    """'1d12h' -> 131400.  Devuelve None si no se entiende nada."""
    if not text:
        return None
    text = text.strip().lower().replace(" ", "")
    if text.isdigit():          # sin unidad -> minutos, que es lo que espera la gente
        return int(text) * 60
    total = 0
    found = False
    for amount, unit in _PATTERN.findall(text):
        mult = _UNITS.get(unit) or _UNITS.get(unit[:3]) or _UNITS.get(unit[0])
        if mult is None:
            continue
        total += int(amount) * mult
        found = True
    return total if found and total > 0 else None


def human_duration(seconds: int | float | None) -> str:
    """131400 -> '1d 12h'."""
    if not seconds or seconds <= 0:
        return "permanente"
    seconds = int(seconds)
    parts: list[str] = []
    for label, size in (("d", 86400), ("h", 3600), ("m", 60), ("s", 1)):
        if seconds >= size:
            value, seconds = divmod(seconds, size)
            parts.append(f"{value}{label}")
        if len(parts) == 2:      # con dos unidades ya se entiende de sobra
            break
    return " ".join(parts) if parts else "0s"
