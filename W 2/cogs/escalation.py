"""Comandos de administracion de la escalada automatica de sanciones.

La logica vive en utils/escalation.py; el aviso (/warn) la invoca desde
cogs/moderation.py. Aqui solo se configuran umbrales y se consulta el historial.
"""

from __future__ import annotations

import time

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, escalation, helpers
from utils.checks import admin_only, staff_only
from utils.paginator import send_pages
from utils.time_parser import human_duration, parse_duration

ACTION_CHOICES = [
    app_commands.Choice(name="Aislamiento (timeout)", value="timeout"),
    app_commands.Choice(name="Expulsion (kick)", value="kick"),
    app_commands.Choice(name="Baneo (ban)", value="ban"),
]


class Escalation(commands.Cog, name="Escalada"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    escalada = app_commands.Group(
        name="escalada", description="Sanciones automaticas segun los avisos acumulados.",
        guild_only=True)

    @escalada.command(name="activar", description="Activa o desactiva la escalada automatica.")
    @app_commands.describe(estado="on para activar, off para desactivar.")
    @app_commands.choices(estado=[
        app_commands.Choice(name="on", value="on"),
        app_commands.Choice(name="off", value="off"),
    ])
    @admin_only()
    async def activar(self, interaction: discord.Interaction,
                      estado: app_commands.Choice[str]) -> None:
        enable = estado.value == "on"
        rules = await escalation.get_rules(self.bot, interaction.guild.id)
        if enable and not rules:
            await interaction.response.send_message(
                embed=embeds.error("Primero define al menos un umbral con `/escalada agregar`."),
                ephemeral=True)
            return
        await self.bot.db.set("escalation_config", interaction.guild.id, enabled=int(enable))
        text = ("Escalada **activada**. Los avisos nuevos aplicaran los umbrales configurados."
                if enable else "Escalada **desactivada**. Los avisos ya no sancionan automaticamente.")
        await interaction.response.send_message(embed=embeds.ok(text), ephemeral=True)

    @escalada.command(name="agregar", description="Define o reemplaza un umbral de avisos.")
    @app_commands.describe(
        avisos="Numero de avisos que dispara la sancion (1-50).",
        accion="Sancion a aplicar.",
        duracion="Obligatoria en aislamiento (ej. 1h, 2d). En ban es opcional: vacio = permanente.")
    @app_commands.choices(accion=ACTION_CHOICES)
    @admin_only()
    async def agregar(self, interaction: discord.Interaction,
                     avisos: app_commands.Range[int, 1, escalation.MAX_THRESHOLD],
                     accion: app_commands.Choice[str],
                     duracion: str | None = None) -> None:
        seconds = None
        if duracion:
            seconds = parse_duration(duracion)
            if seconds is None:
                await interaction.response.send_message(
                    embed=embeds.error("No entiendo esa duracion. Usa `30m`, `12h` o `7d`."),
                    ephemeral=True)
                return
        problem = escalation.validate_rule(avisos, accion.value, seconds)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return

        guild_id = interaction.guild.id
        existing = await self.bot.db.fetchone(
            "SELECT id FROM escalation_rules WHERE guild_id=? AND threshold=?",
            (guild_id, avisos))
        if not existing:
            total = await self.bot.db.fetchval(
                "SELECT COUNT(*) FROM escalation_rules WHERE guild_id=?", (guild_id,), 0)
            if total >= escalation.MAX_RULES:
                await interaction.response.send_message(
                    embed=embeds.error(f"Maximo {escalation.MAX_RULES} umbrales por servidor."),
                    ephemeral=True)
                return

        await self.bot.db.execute(
            "INSERT INTO escalation_rules (guild_id, threshold, action, duration, created_by, "
            "created_at) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(guild_id, threshold) DO UPDATE SET action=excluded.action, "
            "duration=excluded.duration, created_by=excluded.created_by",
            (guild_id, avisos, accion.value, seconds, interaction.user.id, int(time.time())))
        rule = {"threshold": avisos, "action": accion.value, "duration": seconds}
        verb = "actualizado" if existing else "creado"
        note = ""
        if not await escalation.is_enabled(self.bot, guild_id):
            note = "\nLa escalada sigue **desactivada**: usa `/escalada activar`."
        await interaction.response.send_message(
            embed=embeds.ok(f"Umbral {verb}: **{avisos}** aviso(s) → "
                            f"{escalation.describe_rule(rule)}.{note}"),
            ephemeral=True)

    @escalada.command(name="quitar", description="Elimina un umbral de avisos.")
    @app_commands.describe(avisos="Umbral que quieres eliminar.")
    @admin_only()
    async def quitar(self, interaction: discord.Interaction, avisos: int) -> None:
        guild_id = interaction.guild.id
        row = await self.bot.db.fetchone(
            "SELECT id FROM escalation_rules WHERE guild_id=? AND threshold=?",
            (guild_id, avisos))
        if not row:
            await interaction.response.send_message(
                embed=embeds.error("No hay ningun umbral con ese numero de avisos."),
                ephemeral=True)
            return
        await self.bot.db.execute("DELETE FROM escalation_rules WHERE id=?", (row["id"],))
        remaining = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM escalation_rules WHERE guild_id=?", (guild_id,), 0)
        note = ""
        if not remaining and await escalation.is_enabled(self.bot, guild_id):
            await self.bot.db.set("escalation_config", guild_id, enabled=0)
            note = "\nNo quedan umbrales: la escalada se ha **desactivado**."
        await interaction.response.send_message(
            embed=embeds.ok(f"Umbral de {avisos} aviso(s) eliminado.{note}"), ephemeral=True)

    @escalada.command(name="lista", description="Muestra los umbrales configurados.")
    @staff_only()
    async def lista(self, interaction: discord.Interaction) -> None:
        guild_id = interaction.guild.id
        rules = await escalation.get_rules(self.bot, guild_id)
        enabled = await escalation.is_enabled(self.bot, guild_id)
        state = "🟢 activada" if enabled else "🔴 desactivada"
        if not rules:
            await interaction.response.send_message(
                embed=embeds.info(f"Escalada {state}. No hay umbrales definidos.\n"
                                  "Crea uno con `/escalada agregar`."), ephemeral=True)
            return
        lines = [f"**{r['threshold']}** aviso(s) → {escalation.describe_rule(r)}" for r in rules]
        embed = embeds.base("Escalada automatica", f"Estado: {state}\n\n" + "\n".join(lines),
                            config.COLOR_MOD)
        embed.set_footer(text="Se aplica solo el umbral mas alto alcanzado y no se repite "
                              "mientras el usuario siga por encima.")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @escalada.command(name="historial", description="Historial de escaladas aplicadas.")
    @app_commands.describe(usuario="Opcional: solo las de este usuario.")
    @staff_only()
    async def historial(self, interaction: discord.Interaction,
                        usuario: discord.User | None = None) -> None:
        where, params = "guild_id=?", [interaction.guild.id]
        if usuario:
            where += " AND user_id=?"
            params.append(usuario.id)
        rows = await self.bot.db.fetchall(
            f"SELECT * FROM escalation_history WHERE {where} ORDER BY id DESC LIMIT 100", params)
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("No hay escaladas registradas."), ephemeral=True)
            return
        pages = []
        for group in helpers.chunk(rows, 6):
            embed = embeds.base("Historial de escaladas", color=config.COLOR_MOD)
            for row in group:
                rule = {"action": row["action"], "duration": row["duration"]}
                mark = "✅" if row["status"] == "applied" else "❌"
                value = (f"<@{row['user_id']}> · {row['warn_count']} aviso(s) · "
                         f"{escalation.describe_rule(rule)}")
                if row["case_number"]:
                    value += f" · Caso #{row['case_number']}"
                if row["detail"]:
                    value += f"\n{helpers.truncate(row['detail'], 200)}"
                embed.add_field(
                    name=f"{mark} Umbral {row['threshold']} · <t:{row['created_at']}:d>",
                    value=value, inline=False)
            pages.append(embed)
        await send_pages(interaction, pages, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Escalation(bot))
