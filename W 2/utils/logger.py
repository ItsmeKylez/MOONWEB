"""Configuracion del logging a consola y a archivo rotativo."""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler


def setup_logging(directory: str = "data/logs", level: int = logging.INFO) -> logging.Logger:
    os.makedirs(directory, exist_ok=True)

    fmt = logging.Formatter(
        "[{asctime}] [{levelname:<8}] {name}: {message}",
        datefmt="%Y-%m-%d %H:%M:%S",
        style="{",
    )

    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    file_handler = RotatingFileHandler(
        os.path.join(directory, "bot.log"),
        maxBytes=8 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    # discord.py es muy verboso en DEBUG; INFO ya avisa de reconexiones.
    logging.getLogger("discord").setLevel(logging.INFO)
    logging.getLogger("discord.http").setLevel(logging.WARNING)
    logging.getLogger("discord.gateway").setLevel(logging.WARNING)

    return logging.getLogger("bot")
