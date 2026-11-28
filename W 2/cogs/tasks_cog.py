"""Tareas periodicas.

Aqui vive todo lo que debe seguir ocurriendo aunque el bot se reinicie: las
sanciones temporales caducan leyendo la base de datos, no un temporizador en
memoria.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time

import discord
from discord.ext import commands, tasks

import config
from utils import embeds, helpers

log = logging.getLogger("bot.tasks")


def _copy_database(source_path: str, target_path: str) -> None:
    """Copia consistente del .db usando la API de backup de SQLite."""
    source = sqlite3.connect(source_path)
    target = sqlite3.connect(target_path)
    try:
        with target:
            source.backup(target)
    finally:
        source.close()
        target.close()


class Tareas(commands.Cog, name="Tareas"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.expire_actions.start()
        self.autoclose_tickets.start()
        self.backup_database.start()

    async def cog_unload(self) -> None:
        self.expire_actions.cancel()
        self.autoclose_tickets.cancel()
        self.backup_database.cancel()

    # =====================================================================
    @tasks.loop(seconds=45)
    async def expire_actions(self) -> None:
        """Levanta baneos y cuarentenas temporales que ya han caducado."""
        now = int(time.time())
        rows = await self.bot.db.fetchall(
            "SELECT * FROM temp_actions WHERE expires_at <= ?", (now,))
        for row in rows:
            guild = self.bot.get_guild(row["guild_id"])
            if guild is None:
                await self.bot.db.execute("DELETE FROM temp_actions WHERE id=?", (row["id"],))
                continue
            try:
                if row["action"] == "ban":
                    await guild.unban(discord.Object(id=row["user_id"]),
                                      reason="Fin del baneo temporal")
                elif row["action"] == "quarantine":
                    member = guild.get_member(row["user_id"])
                    cfg = await self.bot.db.get("guild_config", guild.id)
                    role = guild.get_role(cfg["quarantine_role"]) if cfg["quarantine_role"] else None
                    if member is not None and role is not None:
                        await member.remove_roles(role, reason="Fin de la cuarentena")
            except discord.NotFound:
                pass
            except discord.HTTPException as exc:
                log.warning("No se pudo revertir %s en %s: %s", row["action"],
                            row["guild_id"], exc)
                continue
            await self.bot.db.execute("DELETE FROM temp_actions WHERE id=?", (row["id"],))

            embed = embeds.base("Sancion temporal terminada", color=config.COLOR_OK)
            embed.add_field(name="Usuario", value=f"<@{row['user_id']}>", inline=True)
            embed.add_field(name="Sancion", value=row["action"], inline=True)
            await helpers.send_log(self.bot, guild, "moderacion", embed)

    @expire_actions.before_loop
    async def _wait_ready_1(self) -> None:
        await self.bot.wait_until_ready()

    # =====================================================================
    @tasks.loop(minutes=15)
    async def autoclose_tickets(self) -> None:
        """Cierra los tickets que llevan demasiado tiempo sin actividad."""
        tickets_cog = self.bot.get_cog("Tickets")
        if tickets_cog is None:
            return
        for guild in self.bot.guilds:
            cfg = await self.bot.db.get("ticket_config", guild.id)
            hours = cfg["autoclose_hours"]
            if not hours:
                continue
            cutoff = int(time.time()) - hours * 3600
            rows = await self.bot.db.fetchall(
                "SELECT * FROM tickets WHERE guild_id=? AND status='open' AND last_activity<?",
                (guild.id, cutoff))
            for row in rows:
                channel = guild.get_channel_or_thread(row["channel_id"])
                if channel is None:
                    await self.bot.db.execute(
                        "UPDATE tickets SET status='deleted' WHERE id=?", (row["id"],))
                    continue
                try:
                    await tickets_cog.close_ticket(
                        channel, self.bot.user,
                        f"Cerrado automaticamente tras {hours}h sin actividad")
                except Exception:
                    log.exception("Fallo al cerrar el ticket %s", row["id"])
                await asyncio.sleep(2)

    @autoclose_tickets.before_loop
    async def _wait_ready_2(self) -> None:
        await self.bot.wait_until_ready()

    # =====================================================================
    @tasks.loop(hours=24)
    async def backup_database(self) -> None:
        """Copia diaria del archivo de base de datos."""
        source = self.bot.db.path
        folder = os.path.join(os.path.dirname(source), "backups")
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, time.strftime("bot-%Y%m%d-%H%M%S.db"))
        try:
            await asyncio.to_thread(_copy_database, source, target)
        except Exception:
            log.exception("No se pudo copiar la base de datos")
            return

        copies = sorted(f for f in os.listdir(folder) if f.endswith(".db"))
        for old in copies[:-config.DB_BACKUP_KEEP]:
            try:
                os.remove(os.path.join(folder, old))
            except OSError:
                pass
        log.info("Copia de la base de datos creada: %s", os.path.basename(target))

    @backup_database.before_loop
    async def _wait_ready_3(self) -> None:
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Tareas(bot))
