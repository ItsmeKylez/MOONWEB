"""/canaleslog: un canal de log distinto por subcategoria (logica en utils/logrouting.py)."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, logrouting
from utils.checks import admin_only
from utils.paginator import send_pages

SUB_CHOICES = [app_commands.Choice(name=k, value=k) for k in config.LOG_SUBCATEGORIES]


class LogRouting(commands.Cog, name="Canales de log"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    canaleslog = app_commands.Group(
        name="canaleslog", description="Un canal de log distinto por tipo de evento.",
        guild_only=True, default_permissions=discord.Permissions(administrator=True))

    @canaleslog.command(name="ver", description="Destino efectivo de cada categoria y subcategoria.")
    @admin_only()
    async def ver(self, interaction: discord.Interaction) -> None:
        channels = await self.bot.db.get_log_channels(interaction.guild.id)
        pages = list(helpers.chunk(logrouting.lines(channels), 12))
        embed_list = []
        for i, group in enumerate(pages, 1):
            e = embeds.base("Canales de log", "\n".join(group), config.COLOR_INFO)
            e.set_footer(text=f"Pagina {i}/{len(pages)} · Sin canal propio, una subcategoria usa el de su categoria")
            embed_list.append(e)
        await send_pages(interaction, embed_list, ephemeral=True)

    @canaleslog.command(name="asignar", description="Envia una subcategoria a su propio canal.")
    @app_commands.describe(subcategoria="Tipo de evento.", canal="Canal de texto destino.")
    @app_commands.choices(subcategoria=SUB_CHOICES)
    @admin_only()
    async def asignar(self, interaction: discord.Interaction,
                      subcategoria: app_commands.Choice[str], canal: discord.TextChannel) -> None:
        problem = logrouting.check_channel(canal, interaction.guild.me)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        await logrouting.assign(self.bot, interaction.guild.id, subcategoria.value, canal.id)
        await interaction.response.send_message(
            embed=embeds.ok(f"`{subcategoria.value}` ahora se envia a {canal.mention}."), ephemeral=True)

    @canaleslog.command(name="quitar", description="La subcategoria vuelve a usar el canal de su categoria.")
    @app_commands.describe(subcategoria="Tipo de evento.")
    @app_commands.choices(subcategoria=SUB_CHOICES)
    @admin_only()
    async def quitar(self, interaction: discord.Interaction,
                     subcategoria: app_commands.Choice[str]) -> None:
        await logrouting.assign(self.bot, interaction.guild.id, subcategoria.value, None)
        parent = config.LOG_SUBCATEGORIES[subcategoria.value][0]
        await interaction.response.send_message(
            embed=embeds.ok(f"`{subcategoria.value}` vuelve a usar el canal de **{parent}**."),
            ephemeral=True)

    @canaleslog.command(name="silenciar", description="No registrar esta subcategoria en ningun canal.")
    @app_commands.describe(subcategoria="Tipo de evento.")
    @app_commands.choices(subcategoria=SUB_CHOICES)
    @admin_only()
    async def silenciar(self, interaction: discord.Interaction,
                        subcategoria: app_commands.Choice[str]) -> None:
        await logrouting.assign(self.bot, interaction.guild.id, subcategoria.value, logrouting.MUTED)
        await interaction.response.send_message(
            embed=embeds.ok(f"`{subcategoria.value}` silenciada. Usa `/canaleslog quitar` para revertirlo."),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(LogRouting(bot))
