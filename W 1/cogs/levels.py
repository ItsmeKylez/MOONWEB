"""Sistema de niveles por actividad."""

from __future__ import annotations

import random
import time

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers
from utils.checks import admin_only
from utils.paginator import send_pages


# Tabla acumulada de XP por nivel; se amplia sola segun hace falta.
_CUMULATIVE = [0]


def xp_for_level(level: int) -> int:
    """XP total acumulada necesaria para alcanzar un nivel."""
    while len(_CUMULATIVE) <= level:
        previous = len(_CUMULATIVE) - 1
        _CUMULATIVE.append(_CUMULATIVE[-1] + 5 * previous * previous
                           + 50 * previous + 100)
    return _CUMULATIVE[level]


def level_from_xp(xp: int) -> int:
    level = 0
    while xp >= xp_for_level(level + 1):
        level += 1
        if level > 500:
            break
    return level


class Levels(commands.Cog, name="Niveles"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot or not message.content:
            return
        cfg = await self.bot.db.get("level_config", message.guild.id)
        if not cfg["enabled"]:
            return
        if await helpers.is_ignored(self.bot, message.guild.id, message.channel, message.author):
            return

        now = int(time.time())
        row = await self.bot.db.fetchone(
            "SELECT * FROM levels WHERE guild_id=? AND user_id=?",
            (message.guild.id, message.author.id))
        if row is None:
            await self.bot.db.execute(
                "INSERT OR IGNORE INTO levels (guild_id, user_id) VALUES (?,?)",
                (message.guild.id, message.author.id))
            row = {"xp": 0, "level": 0, "last_msg": 0}
        if now - row["last_msg"] < config.XP_COOLDOWN:
            return

        gain = random.randint(cfg["xp_min"], max(cfg["xp_min"], cfg["xp_max"]))
        new_xp = row["xp"] + gain
        new_level = level_from_xp(new_xp)
        await self.bot.db.execute(
            "UPDATE levels SET xp=?, level=?, last_msg=? WHERE guild_id=? AND user_id=?",
            (new_xp, new_level, now, message.guild.id, message.author.id))

        if new_level <= row["level"]:
            return
        await self._level_up(message, cfg, new_level)

    async def _level_up(self, message: discord.Message, cfg: dict, level: int) -> None:
        reward = await self.bot.db.fetchone(
            "SELECT role_id FROM level_rewards WHERE guild_id=? AND level=?",
            (message.guild.id, level))
        role = message.guild.get_role(reward["role_id"]) if reward else None
        if role is not None and role < message.guild.me.top_role:
            try:
                await message.author.add_roles(role, reason=f"Nivel {level}")
            except discord.HTTPException:
                role = None

        if not cfg["announce"]:
            return
        channel = message.guild.get_channel(cfg["channel_id"]) if cfg["channel_id"] else message.channel
        texto = f"{message.author.mention} ha subido al **nivel {level}**."
        if role is not None:
            texto += f"\nRecompensa: {role.mention}"
        try:
            await channel.send(
                embed=embeds.base("Subida de nivel", texto, config.COLOR_OK),
                allowed_mentions=discord.AllowedMentions(users=True))
        except discord.HTTPException:
            pass

    # =====================================================================
    @app_commands.command(name="nivel", description="Muestra tu nivel o el de otro miembro.")
    @app_commands.describe(usuario="Miembro a consultar.")
    @app_commands.guild_only()
    async def nivel(self, interaction: discord.Interaction,
                    usuario: discord.Member | None = None) -> None:
        member = usuario or interaction.user
        row = await self.bot.db.fetchone(
            "SELECT * FROM levels WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, member.id))
        if row is None or row["xp"] == 0:
            await interaction.response.send_message(
                embed=embeds.info(f"**{member.display_name}** todavia no tiene XP."),
                ephemeral=True)
            return

        level = row["level"]
        current = xp_for_level(level)
        following = xp_for_level(level + 1)
        progress = row["xp"] - current
        needed = following - current
        rank = await self.bot.db.fetchval(
            "SELECT COUNT(*) + 1 FROM levels WHERE guild_id=? AND xp > ?",
            (interaction.guild.id, row["xp"]), 1)

        embed = embeds.base(f"Nivel de {member.display_name}", color=config.COLOR_PRIMARY)
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.add_field(name="Nivel", value=str(level), inline=True)
        embed.add_field(name="XP total", value=str(row["xp"]), inline=True)
        embed.add_field(name="Puesto", value=f"#{rank}", inline=True)
        embed.add_field(
            name=f"Progreso al nivel {level + 1}",
            value=f"{helpers.progress_bar(progress, needed)} {progress}/{needed}",
            inline=False)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="ranking", description="Tabla de niveles del servidor.")
    @app_commands.guild_only()
    async def ranking(self, interaction: discord.Interaction) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT user_id, xp, level FROM levels WHERE guild_id=? AND xp > 0 "
            "ORDER BY xp DESC LIMIT 100", (interaction.guild.id,))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("Todavia no hay nadie en el ranking."), ephemeral=True)
            return
        pages = []
        for index, group in enumerate(helpers.chunk(rows, 10)):
            lines = []
            for position, row in enumerate(group, start=index * 10 + 1):
                lines.append(f"`{position:>3}.` <@{row['user_id']}> — nivel **{row['level']}** "
                             f"({row['xp']} XP)")
            pages.append(embeds.base("Ranking de niveles", "\n".join(lines),
                                     config.COLOR_PRIMARY))
        await send_pages(interaction, pages)

    niveles = app_commands.Group(
        name="niveles", description="Configuracion del sistema de niveles.",
        guild_only=True, default_permissions=discord.Permissions(administrator=True))

    @niveles.command(name="activar", description="Activa o desactiva el sistema de niveles.")
    @app_commands.describe(activo="True para activarlo.")
    @admin_only()
    async def activar(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("level_config", interaction.guild.id, enabled=int(activo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Niveles **{'activados' if activo else 'desactivados'}**."),
            ephemeral=True)

    @niveles.command(name="anuncios", description="Donde se anuncian las subidas de nivel.")
    @app_commands.describe(anunciar="Anunciar las subidas.",
                           canal="Canal fijo. Vacio = en el mismo canal del mensaje.")
    @admin_only()
    async def anuncios(self, interaction: discord.Interaction, anunciar: bool,
                       canal: discord.TextChannel | None = None) -> None:
        await self.bot.db.set("level_config", interaction.guild.id,
                              announce=int(anunciar), channel_id=canal.id if canal else None)
        await interaction.response.send_message(
            embed=embeds.ok("Anuncios de nivel actualizados."), ephemeral=True)

    @niveles.command(name="xp", description="Cuanta XP se gana por mensaje.")
    @app_commands.describe(minimo="XP minima.", maximo="XP maxima.")
    @admin_only()
    async def xp(self, interaction: discord.Interaction,
                 minimo: app_commands.Range[int, 1, 200],
                 maximo: app_commands.Range[int, 1, 200]) -> None:
        await self.bot.db.set("level_config", interaction.guild.id,
                              xp_min=min(minimo, maximo), xp_max=max(minimo, maximo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Cada mensaje dara entre **{min(minimo, maximo)}** y "
                            f"**{max(minimo, maximo)}** XP."), ephemeral=True)

    @niveles.command(name="recompensa", description="Rol que se da al llegar a un nivel.")
    @app_commands.describe(nivel="Nivel objetivo.", rol="Rol a dar. Vacio = quitar recompensa.")
    @admin_only()
    async def recompensa(self, interaction: discord.Interaction,
                         nivel: app_commands.Range[int, 1, 500],
                         rol: discord.Role | None = None) -> None:
        if rol is None:
            await self.bot.db.execute(
                "DELETE FROM level_rewards WHERE guild_id=? AND level=?",
                (interaction.guild.id, nivel))
            await interaction.response.send_message(
                embed=embeds.ok(f"Recompensa del nivel {nivel} eliminada."), ephemeral=True)
            return
        if rol >= interaction.guild.me.top_role:
            await interaction.response.send_message(
                embed=embeds.error("Ese rol esta por encima del mio."), ephemeral=True)
            return
        await self.bot.db.execute(
            "INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?,?,?) "
            "ON CONFLICT(guild_id, level) DO UPDATE SET role_id=excluded.role_id",
            (interaction.guild.id, nivel, rol.id))
        await interaction.response.send_message(
            embed=embeds.ok(f"Al llegar al nivel **{nivel}** se dara {rol.mention}."),
            ephemeral=True)

    @niveles.command(name="reiniciar", description="Borra la XP de un miembro o de todos.")
    @app_commands.describe(usuario="Miembro concreto. Vacio = todo el servidor.")
    @admin_only()
    async def reiniciar(self, interaction: discord.Interaction,
                        usuario: discord.Member | None = None) -> None:
        if usuario is not None:
            await self.bot.db.execute(
                "DELETE FROM levels WHERE guild_id=? AND user_id=?",
                (interaction.guild.id, usuario.id))
            texto = f"XP de **{usuario}** reiniciada."
        else:
            await self.bot.db.execute("DELETE FROM levels WHERE guild_id=?",
                                      (interaction.guild.id,))
            texto = "XP de todo el servidor reiniciada."
        await interaction.response.send_message(embed=embeds.ok(texto), ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Levels(bot))
