"""Capa de acceso a la base de datos local (SQLite via aiosqlite).

Por que asi:
  * Una sola conexion + un asyncio.Lock.  SQLite no admite escrituras
    concurrentes; serializar aqui evita los "database is locked".
  * Las tablas de configuracion se cachean en memoria y se invalidan al
    escribir.  El anti-spam consulta su config en CADA mensaje: sin cache
    estariamos golpeando el disco cientos de veces por minuto.
  * Los nombres de columna se validan contra PRAGMA table_info antes de
    interpolarlos en el SQL, porque no se pueden parametrizar.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Iterable, Sequence

import aiosqlite

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")

# Tablas de tipo "una fila por servidor" que se cachean y se crean al vuelo.
CONFIG_TABLES = {
    "guild_config",
    "ticket_config",
    "antinuke_config",
    "antiraid_config",
    "antispam_config",
    "welcome_config",
    "level_config",
    "escalation_config",
    "appeal_config",
    "warn_expiry_config",
}


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()
        self._columns: dict[str, set[str]] = {}
        self._cache: dict[str, dict[int, dict]] = {t: {} for t in CONFIG_TABLES}
        self._logs_cache: dict[int, dict[str, int]] = {}
        self._ignored_cache: dict[int, dict[str, set[int]]] = {}
        self._whitelist_cache: dict[int, set[int]] = {}

    # -- ciclo de vida ------------------------------------------------------
    async def connect(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row

        with open(SCHEMA_PATH, "r", encoding="utf-8") as fh:
            await self.conn.executescript(fh.read())
        await self.conn.commit()
        await self._migrate()

        # Cachea el listado de columnas de cada tabla para validar escrituras.
        async with self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ) as cur:
            tables = [r[0] for r in await cur.fetchall()]
        for table in tables:
            async with self.conn.execute(f"PRAGMA table_info({table})") as cur:
                self._columns[table] = {r[1] for r in await cur.fetchall()}

    async def _migrate(self) -> None:
        """Migraciones aditivas e idempotentes para bases de datos antiguas."""
        async with self.conn.execute("PRAGMA table_info(warns)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "expired_at" not in cols:
            await self.conn.execute("ALTER TABLE warns ADD COLUMN expired_at INTEGER")
        async with self.conn.execute("PRAGMA table_info(cases)") as cur:
            case_cols = {r[1] for r in await cur.fetchall()}
        for col, typ in (("voided_at", "INTEGER"), ("voided_by", "INTEGER"),
                         ("void_reason", "TEXT"), ("edited_at", "INTEGER")):
            if col not in case_cols:
                await self.conn.execute(f"ALTER TABLE cases ADD COLUMN {col} {typ}")
        await self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_warns_active ON warns(guild_id, user_id, expired_at)")
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn is not None:
            await self.conn.commit()
            await self.conn.close()
            self.conn = None

    # -- primitivas ---------------------------------------------------------
    async def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        async with self._lock:
            cur = await self.conn.execute(sql, params)
            await self.conn.commit()
            rowid = cur.lastrowid
            await cur.close()
            return rowid

    async def executemany(self, sql: str, seq: Iterable[Sequence[Any]]) -> None:
        async with self._lock:
            await self.conn.executemany(sql, seq)
            await self.conn.commit()

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> dict | None:
        async with self._lock:
            async with self.conn.execute(sql, params) as cur:
                row = await cur.fetchone()
        return dict(row) if row else None

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        async with self._lock:
            async with self.conn.execute(sql, params) as cur:
                rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def fetchval(self, sql: str, params: Sequence[Any] = (), default=None):
        row = await self.fetchone(sql, params)
        if not row:
            return default
        return next(iter(row.values()))

    # -- tablas de configuracion -------------------------------------------
    async def get(self, table: str, guild_id: int) -> dict:
        """Devuelve la fila de configuracion, creandola con los valores por
        defecto del esquema si todavia no existe."""
        if table not in CONFIG_TABLES:
            raise ValueError(f"{table} no es una tabla de configuracion")

        cached = self._cache[table].get(guild_id)
        if cached is not None:
            return cached

        row = await self.fetchone(f"SELECT * FROM {table} WHERE guild_id=?", (guild_id,))
        if row is None:
            if table == "guild_config":
                await self.execute(
                    "INSERT OR IGNORE INTO guild_config (guild_id, created_at) VALUES (?,?)",
                    (guild_id, int(time.time())),
                )
            else:
                await self.execute(
                    f"INSERT OR IGNORE INTO {table} (guild_id) VALUES (?)", (guild_id,)
                )
            row = await self.fetchone(
                f"SELECT * FROM {table} WHERE guild_id=?", (guild_id,)
            )
        self._cache[table][guild_id] = row
        return row

    async def set(self, table: str, guild_id: int, **values: Any) -> None:
        if table not in CONFIG_TABLES:
            raise ValueError(f"{table} no es una tabla de configuracion")
        cols = self._columns.get(table, set())
        clean = {k: v for k, v in values.items() if k in cols and k != "guild_id"}
        if not clean:
            return
        await self.get(table, guild_id)  # asegura que la fila existe
        assign = ", ".join(f"{k}=?" for k in clean)
        await self.execute(
            f"UPDATE {table} SET {assign} WHERE guild_id=?",
            (*clean.values(), guild_id),
        )
        self._cache[table].pop(guild_id, None)

    # -- contadores incrementales ------------------------------------------
    async def next_counter(self, guild_id: int, column: str) -> int:
        """Incrementa y devuelve un contador de guild_config de forma atomica."""
        if column not in {"case_counter", "ticket_counter"}:
            raise ValueError(column)
        await self.get("guild_config", guild_id)
        async with self._lock:
            await self.conn.execute(
                f"UPDATE guild_config SET {column} = {column} + 1 WHERE guild_id=?",
                (guild_id,),
            )
            async with self.conn.execute(
                f"SELECT {column} FROM guild_config WHERE guild_id=?", (guild_id,)
            ) as cur:
                row = await cur.fetchone()
            await self.conn.commit()
        self._cache["guild_config"].pop(guild_id, None)
        return int(row[0])

    # -- canales de log -----------------------------------------------------
    async def get_log_channels(self, guild_id: int) -> dict[str, int]:
        cached = self._logs_cache.get(guild_id)
        if cached is not None:
            return cached
        rows = await self.fetchall(
            "SELECT category, channel_id FROM log_channels WHERE guild_id=?", (guild_id,)
        )
        data = {r["category"]: r["channel_id"] for r in rows}
        self._logs_cache[guild_id] = data
        return data

    async def set_log_channel(self, guild_id: int, category: str, channel_id: int | None) -> None:
        if channel_id is None:
            await self.execute(
                "DELETE FROM log_channels WHERE guild_id=? AND category=?",
                (guild_id, category),
            )
        else:
            await self.execute(
                "INSERT INTO log_channels (guild_id, category, channel_id) VALUES (?,?,?) "
                "ON CONFLICT(guild_id, category) DO UPDATE SET channel_id=excluded.channel_id",
                (guild_id, category, channel_id),
            )
        self._logs_cache.pop(guild_id, None)

    # -- ignorados ----------------------------------------------------------
    async def get_ignored(self, guild_id: int) -> dict[str, set[int]]:
        cached = self._ignored_cache.get(guild_id)
        if cached is not None:
            return cached
        rows = await self.fetchall(
            "SELECT kind, target_id FROM ignored WHERE guild_id=?", (guild_id,)
        )
        data: dict[str, set[int]] = {"channel": set(), "role": set(), "user": set()}
        for r in rows:
            data.setdefault(r["kind"], set()).add(r["target_id"])
        self._ignored_cache[guild_id] = data
        return data

    async def add_ignored(self, guild_id: int, kind: str, target_id: int) -> None:
        await self.execute(
            "INSERT OR IGNORE INTO ignored (guild_id, kind, target_id) VALUES (?,?,?)",
            (guild_id, kind, target_id),
        )
        self._ignored_cache.pop(guild_id, None)

    async def remove_ignored(self, guild_id: int, kind: str, target_id: int) -> None:
        await self.execute(
            "DELETE FROM ignored WHERE guild_id=? AND kind=? AND target_id=?",
            (guild_id, kind, target_id),
        )
        self._ignored_cache.pop(guild_id, None)

    # -- whitelist de seguridad --------------------------------------------
    async def get_whitelist(self, guild_id: int) -> set[int]:
        cached = self._whitelist_cache.get(guild_id)
        if cached is not None:
            return cached
        rows = await self.fetchall(
            "SELECT user_id FROM whitelist WHERE guild_id=?", (guild_id,)
        )
        data = {r["user_id"] for r in rows}
        self._whitelist_cache[guild_id] = data
        return data

    async def add_whitelist(self, guild_id: int, user_id: int, added_by: int) -> None:
        await self.execute(
            "INSERT OR IGNORE INTO whitelist (guild_id, user_id, added_by) VALUES (?,?,?)",
            (guild_id, user_id, added_by),
        )
        self._whitelist_cache.pop(guild_id, None)

    async def remove_whitelist(self, guild_id: int, user_id: int) -> None:
        await self.execute(
            "DELETE FROM whitelist WHERE guild_id=? AND user_id=?", (guild_id, user_id)
        )
        self._whitelist_cache.pop(guild_id, None)

    # -- utilidades ---------------------------------------------------------
    def invalidate(self, guild_id: int) -> None:
        """Tira toda la cache de un servidor (usado por /setup y restauraciones)."""
        for table in self._cache:
            self._cache[table].pop(guild_id, None)
        self._logs_cache.pop(guild_id, None)
        self._ignored_cache.pop(guild_id, None)
        self._whitelist_cache.pop(guild_id, None)
