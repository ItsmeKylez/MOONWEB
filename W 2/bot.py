"""Punto de entrada del bot.

    python bot.py

Requiere un archivo .env junto a este fichero (copia .env.example).
"""

from __future__ import annotations

import logging
import os
import sys
import traceback

import discord
from discord.ext import commands
from dotenv import load_dotenv

from database import Database
from utils.logger import setup_logging

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "bot.db")

EXTENSIONS = (
    "cogs.errors",
    "cogs.config_cog",
    "cogs.moderation",
    "cogs.escalation",
    "cogs.warnexpiry",
    "cogs.casemgmt",
    "cogs.eventlogs",
    "cogs.logrouting",
    "cogs.evidence",
    "cogs.appeals",
    "cogs.modreports",
    "cogs.logs",
    "cogs.antinuke",
    "cogs.antiraid",
    "cogs.antispam",
    "cogs.tickets",
    "cogs.backups",
    "cogs.welcome",
    "cogs.verification",
    "cogs.levels",
    "cogs.rolemenu",
    "cogs.utility",
    "cogs.tasks_cog",
    "cogs.dashboard",
)

log = logging.getLogger("bot")


class SecurityBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        intents.members = True           # entradas/salidas, roles, apodos
        intents.message_content = True   # anti-spam y filtro de palabras

        super().__init__(
            command_prefix=commands.when_mentioned_or(os.getenv("PREFIX", "!")),
            intents=intents,
            help_command=None,
            case_insensitive=True,
            allowed_mentions=discord.AllowedMentions(
                everyone=False, roles=False, users=True, replied_user=False
            ),
            activity=discord.Activity(
                type=discord.ActivityType.watching, name="la seguridad del servidor"
            ),
            status=discord.Status.online,
        )

        self.db = Database(DB_PATH)
        self.start_time = discord.utils.utcnow()
        self.owner_id = int(os.getenv("OWNER_ID") or 0) or None
        self.dev_guild_id = int(os.getenv("DEV_GUILD_ID") or 0) or None

    # -- arranque -----------------------------------------------------------
    async def setup_hook(self) -> None:
        os.makedirs(os.path.join(DATA_DIR, "logs"), exist_ok=True)
        os.makedirs(os.path.join(DATA_DIR, "transcripts"), exist_ok=True)
        os.makedirs(os.path.join(DATA_DIR, "backups"), exist_ok=True)

        await self.db.connect()
        log.info("Base de datos lista en %s", DB_PATH)

        loaded = 0
        for extension in EXTENSIONS:
            try:
                await self.load_extension(extension)
                loaded += 1
            except Exception:
                log.error("No se pudo cargar %s\n%s", extension, traceback.format_exc())
        log.info("Cogs cargados: %s/%s", loaded, len(EXTENSIONS))

        try:
            if self.dev_guild_id:
                guild = discord.Object(id=self.dev_guild_id)
                self.tree.copy_global_to(guild=guild)
                synced = await self.tree.sync(guild=guild)
                log.info("%s comandos sincronizados en el servidor de pruebas", len(synced))
            else:
                synced = await self.tree.sync()
                log.info("%s comandos sincronizados globalmente", len(synced))
        except discord.HTTPException:
            log.error("Fallo al sincronizar los comandos\n%s", traceback.format_exc())

    async def on_ready(self) -> None:
        log.info("Conectado como %s (%s)", self.user, self.user.id)
        log.info("Servidores: %s | Miembros en cache: %s",
                 len(self.guilds), sum(g.member_count or 0 for g in self.guilds))

    async def on_guild_join(self, guild: discord.Guild) -> None:
        # Crea la fila de configuracion para no tener que comprobarlo despues.
        await self.db.get("guild_config", guild.id)
        log.info("Añadido a %s (%s)", guild.name, guild.id)

    async def close(self) -> None:
        await self.db.close()
        await super().close()

    # -- utilidades ---------------------------------------------------------
    @property
    def uptime_seconds(self) -> int:
        return int((discord.utils.utcnow() - self.start_time).total_seconds())


bot = SecurityBot()


@bot.command(name="sync")
@commands.is_owner()
async def sync_command(ctx: commands.Context, scope: str = "guild") -> None:
    """Resincroniza los slash commands. Uso: !sync [guild|global|clear]"""
    if scope == "global":
        synced = await bot.tree.sync()
        await ctx.reply(f"{len(synced)} comandos sincronizados globalmente "
                        f"(pueden tardar hasta 1 hora en aparecer).")
    elif scope == "clear":
        bot.tree.clear_commands(guild=ctx.guild)
        await bot.tree.sync(guild=ctx.guild)
        await ctx.reply("Comandos de este servidor borrados.")
    else:
        bot.tree.copy_global_to(guild=ctx.guild)
        synced = await bot.tree.sync(guild=ctx.guild)
        await ctx.reply(f"{len(synced)} comandos sincronizados en este servidor.")


@bot.command(name="reload")
@commands.is_owner()
async def reload_command(ctx: commands.Context, extension: str) -> None:
    """Recarga un cog sin reiniciar el bot. Uso: !reload cogs.tickets"""
    try:
        await bot.reload_extension(extension)
    except Exception as exc:
        await ctx.reply(f"Error: `{exc}`")
        return
    await ctx.reply(f"`{extension}` recargado.")


def main() -> None:
    setup_logging(os.path.join(DATA_DIR, "logs"))

    token = os.getenv("DISCORD_TOKEN")
    if not token:
        print("ERROR: falta DISCORD_TOKEN. Copia .env.example a .env y rellenalo.")
        sys.exit(1)

    try:
        bot.run(token, log_handler=None)
    except discord.LoginFailure:
        print("ERROR: el token no es valido. Genera uno nuevo en el Developer Portal.")
        sys.exit(1)
    except discord.PrivilegedIntentsRequired:
        print("ERROR: activa SERVER MEMBERS INTENT y MESSAGE CONTENT INTENT en el "
              "Developer Portal > tu aplicacion > Bot.")
        sys.exit(1)


if __name__ == "__main__":
    main()
