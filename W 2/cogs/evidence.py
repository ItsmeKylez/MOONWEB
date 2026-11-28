"""Gestion de evidencias de los casos: /evidencia agregar | ver | quitar."""

from __future__ import annotations

import os

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, evidence, helpers, modlog
from utils.checks import staff_only


class Evidence(commands.Cog, name="Evidencias"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    evidencia = app_commands.Group(
        name="evidencia", description="Archivos de prueba adjuntos a los casos.",
        guild_only=True)

    @evidencia.command(name="agregar", description="Adjunta un archivo como prueba de un caso.")
    @app_commands.describe(caso="Numero del caso.", archivo="Captura, video o documento.",
                           nota="Opcional: que demuestra este archivo.")
    @staff_only()
    async def agregar(self, interaction: discord.Interaction, caso: int,
                      archivo: discord.Attachment, nota: str | None = None) -> None:
        guild = interaction.guild
        if not await modlog.get_case(self.bot, guild.id, caso):
            await interaction.response.send_message(
                embed=embeds.error("Ese caso no existe."), ephemeral=True)
            return
        problem = evidence.validate_attachment(archivo)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        row, err = await evidence.add(self.bot, guild.id, caso, archivo,
                                      interaction.user.id, nota)
        if err:
            await interaction.followup.send(embed=embeds.error(err), ephemeral=True)
            return
        await interaction.followup.send(
            embed=embeds.ok(f"Evidencia **#{row['id']}** (`{row['filename']}`) añadida al caso #{caso}."),
            ephemeral=True)

        log_embed = embeds.base(f"📎 Evidencia añadida · Caso #{caso}", color=config.COLOR_MOD)
        log_embed.add_field(name="Archivo", value=f"`{row['filename']}` ({row['size'] // 1024} KB)",
                            inline=True)
        log_embed.add_field(name="Añadida por", value=helpers.fmt_user(interaction.user),
                            inline=False)
        if row["note"]:
            log_embed.add_field(name="Nota", value=helpers.truncate(row["note"], 200), inline=False)
        await helpers.send_log(self.bot, guild, "moderacion", log_embed)

    @evidencia.command(name="ver", description="Muestra las evidencias de un caso.")
    @app_commands.describe(caso="Numero del caso.")
    @staff_only()
    async def ver(self, interaction: discord.Interaction, caso: int) -> None:
        guild = interaction.guild
        if not await modlog.get_case(self.bot, guild.id, caso):
            await interaction.response.send_message(
                embed=embeds.error("Ese caso no existe."), ephemeral=True)
            return
        rows = await evidence.list_for_case(self.bot, guild.id, caso)
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info(f"El caso #{caso} no tiene evidencias."), ephemeral=True)
            return

        embed = embeds.base(f"📎 Evidencias · Caso #{caso}", color=config.COLOR_MOD)
        files: list[discord.File] = []
        missing = 0
        for row in rows:
            line = (f"`{row['filename']}` · {row['size'] // 1024} KB · "
                    f"<@{row['added_by']}> · <t:{row['added_at']}:d>")
            if row["note"]:
                line += f"\n{helpers.truncate(row['note'], 200)}"
            path = evidence.resolve_path(self.bot, row["stored_path"])
            if path and os.path.isfile(path):
                if len(files) < 10:
                    files.append(discord.File(path, filename=row["filename"]))
            else:
                missing += 1
                line += "\n⚠️ Archivo no encontrado en el disco."
            embed.add_field(name=f"Evidencia #{row['id']}", value=line, inline=False)
        if missing:
            embed.set_footer(text=f"{missing} archivo(s) ya no estan en el disco del bot.")
        await interaction.response.send_message(embed=embed, files=files, ephemeral=True)

    @evidencia.command(name="quitar", description="Elimina una evidencia por su numero.")
    @app_commands.describe(id_evidencia="Numero que aparece en /evidencia ver.")
    @staff_only()
    async def quitar(self, interaction: discord.Interaction, id_evidencia: int) -> None:
        guild = interaction.guild
        row = await self.bot.db.fetchone(
            "SELECT * FROM case_evidence WHERE id=? AND guild_id=?", (id_evidencia, guild.id))
        if not row:
            await interaction.response.send_message(
                embed=embeds.error("No existe esa evidencia en este servidor."), ephemeral=True)
            return
        if row["added_by"] != interaction.user.id and not await helpers.is_admin(
                self.bot, interaction.user):
            await interaction.response.send_message(
                embed=embeds.error("Solo quien la subio o un administrador puede borrarla."),
                ephemeral=True)
            return
        await evidence.remove(self.bot, guild.id, id_evidencia)
        await interaction.response.send_message(
            embed=embeds.ok(f"Evidencia #{id_evidencia} eliminada del caso #{row['case_number']}."),
            ephemeral=True)

        log_embed = embeds.base(f"🗑️ Evidencia eliminada · Caso #{row['case_number']}",
                                color=config.COLOR_WARN)
        log_embed.add_field(name="Archivo", value=f"`{row['filename']}`", inline=True)
        log_embed.add_field(name="Eliminada por", value=helpers.fmt_user(interaction.user),
                            inline=False)
        await helpers.send_log(self.bot, guild, "moderacion", log_embed)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Evidence(bot))
