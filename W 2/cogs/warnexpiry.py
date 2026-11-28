"""Comandos y tarea de la expiracion de avisos (logica en utils/warnexpiry.py)."""

from __future__ import annotations

import logging

import discord
from discord import app_commands
from discord.ext import commands, tasks

import config
from utils import embeds, warnexpiry
from utils.checks import admin_only, staff_only

log = logging.getLogger("bot.warnexpiry")


class WarnExpiry(commands.Cog, name="Expiracion de avisos"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.sweep.start()

    async def cog_unload(self) -> None:
        self.sweep.cancel()

    @tasks.loop(minutes=10)
    async def sweep(self) -> None:
        await warnexpiry.sweep_all(self.bot)

    @sweep.before_loop
    async def _wait(self) -> None:
        await self.bot.wait_until_ready()

    expiracion = app_commands.Group(
        name="expiracion", description="Caducidad automatica de los avisos.", guild_only=True)

    @expiracion.command(name="estado", description="Muestra la configuracion de caducidad de avisos.")
    @staff_only()
    async def estado(self, interaction: discord.Interaction) -> None:
        cfg = await warnexpiry.get_config(self.bot, interaction.guild.id)
        days = cfg["days"] or 0
        embed = embeds.base("Expiracion de avisos", color=config.COLOR_PRIMARY)
        embed.add_field(name="Caducidad",
                        value=f"**{days} dia(s)**" if days else "**Desactivada** (nunca caducan)",
                        inline=True)
        embed.add_field(name="Aviso en logs", value="Si" if cfg["notify"] else "No", inline=True)
        if days:
            pend = await warnexpiry.pending_count(self.bot, interaction.guild.id, days)
            embed.add_field(name="Pendientes de caducar", value=str(pend), inline=True)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @expiracion.command(name="configurar", description="Define tras cuantos dias caducan los avisos.")
    @app_commands.describe(
        dias=f"Dias hasta que un aviso caduca (1-{warnexpiry.MAX_DAYS}); 0 = nunca.",
        notificar="Publicar en el log de moderacion cada vez que caduquen avisos.")
    @admin_only()
    async def configurar(self, interaction: discord.Interaction,
                         dias: app_commands.Range[int, 0, warnexpiry.MAX_DAYS],
                         notificar: bool | None = None) -> None:
        problem = warnexpiry.validate_days(dias)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        values = {"days": dias}
        if notificar is not None:
            values["notify"] = int(notificar)
        await self.bot.db.set("warn_expiry_config", interaction.guild.id, **values)
        if dias == 0:
            text = "Caducidad **desactivada**. Los avisos ya no caducan (los ya caducados siguen caducados)."
        else:
            pend = await warnexpiry.pending_count(self.bot, interaction.guild.id, dias)
            text = (f"Los avisos caducaran a los **{dias} dia(s)**. Esto afecta tambien a los "
                    f"avisos existentes: **{pend}** ya superan ese plazo y caducaran en la proxima "
                    f"pasada (cada 10 min, o con `/expiracion ahora`). Caducar no sanciona ni "
                    f"revierte sanciones.")
        await interaction.response.send_message(embed=embeds.ok(text), ephemeral=True)

    @expiracion.command(name="ahora", description="Ejecuta ya la pasada de caducidad.")
    @admin_only()
    async def ahora(self, interaction: discord.Interaction) -> None:
        cfg = await warnexpiry.get_config(self.bot, interaction.guild.id)
        if not cfg["days"]:
            await interaction.response.send_message(
                embed=embeds.error("La caducidad esta desactivada. Usa `/expiracion configurar`."),
                ephemeral=True)
            return
        expired = await warnexpiry.sweep_guild(self.bot, interaction.guild.id)
        if expired:
            await warnexpiry.log_expired(self.bot, interaction.guild, expired)
        total = sum(e["count"] for e in expired)
        await interaction.response.send_message(
            embed=embeds.ok(f"{total} aviso(s) de {len(expired)} usuario(s) caducados."),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(WarnExpiry(bot))
