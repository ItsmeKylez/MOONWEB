"""Gestion de casos: /casos lista|buscar|editar|anular|restaurar|auditoria.
La logica vive en utils/casemgmt.py."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import casemgmt, embeds, helpers, modlog
from utils.checks import admin_only, staff_only
from utils.paginator import send_pages

ACTION_CHOICES = [app_commands.Choice(name=v[0], value=k) for k, v in modlog.ACTIONS.items()]
STATE_CHOICES = [
    app_commands.Choice(name="Activos (por defecto)", value="active"),
    app_commands.Choice(name="Anulados", value="voided"),
    app_commands.Choice(name="Todos", value="all"),
]


class CaseManagement(commands.Cog, name="Gestion de casos"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    casos = app_commands.Group(
        name="casos", description="Busca y gestiona los casos de moderacion.", guild_only=True)

    async def _send_results(self, interaction, rows, total, title) -> None:
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("No hay casos con esos filtros."), ephemeral=True)
            return
        pages = []
        for group in helpers.chunk(rows, casemgmt.PAGE_SIZE):
            embed = embeds.base(title, color=config.COLOR_MOD)
            for row in group:
                embed.add_field(name=casemgmt.format_line(row),
                                value=casemgmt.format_value(row), inline=False)
            shown = f" (mostrando los {len(rows)} mas recientes)" if total > len(rows) else ""
            embed.set_footer(text=f"{total} caso(s){shown}")
            pages.append(embed)
        await send_pages(interaction, pages, ephemeral=True)

    @casos.command(name="lista", description="Lista casos con filtros.")
    @app_commands.describe(
        usuario="Solo casos de este usuario.", moderador="Solo casos de este moderador.",
        accion="Tipo de sancion.", estado="Activos, anulados o todos.",
        dias=f"Solo los ultimos N dias (1-{casemgmt.MAX_DAYS}).")
    @app_commands.choices(accion=ACTION_CHOICES, estado=STATE_CHOICES)
    @staff_only()
    async def lista(self, interaction: discord.Interaction,
                    usuario: discord.User | None = None, moderador: discord.User | None = None,
                    accion: app_commands.Choice[str] | None = None,
                    estado: app_commands.Choice[str] | None = None,
                    dias: app_commands.Range[int, 1, casemgmt.MAX_DAYS] | None = None) -> None:
        rows, total = await casemgmt.search(
            self.bot, interaction.guild.id, user_id=usuario.id if usuario else None,
            moderator_id=moderador.id if moderador else None,
            action=accion.value if accion else None,
            state=estado.value if estado else "active", days=dias)
        await self._send_results(interaction, rows, total, "Casos de moderacion")

    @casos.command(name="buscar", description="Busca casos por texto del motivo.")
    @app_commands.describe(texto="Texto a buscar en el motivo.",
                           estado="Activos, anulados o todos.")
    @app_commands.choices(estado=STATE_CHOICES)
    @staff_only()
    async def buscar(self, interaction: discord.Interaction,
                     texto: app_commands.Range[str, 2, 100],
                     estado: app_commands.Choice[str] | None = None) -> None:
        rows, total = await casemgmt.search(
            self.bot, interaction.guild.id, text=texto,
            state=estado.value if estado else "active")
        await self._send_results(interaction, rows, total, f"Casos con «{texto}»")

    @casos.command(name="editar", description="Edita el motivo de un caso (queda auditado).")
    @app_commands.describe(numero="Numero del caso.", motivo="Nuevo motivo.")
    @staff_only()
    async def editar(self, interaction: discord.Interaction, numero: int,
                     motivo: app_commands.Range[str, casemgmt.MIN_REASON, casemgmt.MAX_REASON]) -> None:
        is_admin = await helpers.is_admin(self.bot, interaction.user)
        ok, msg = await casemgmt.edit_reason(
            self.bot, interaction.guild, numero, interaction.user.id, is_admin, motivo)
        await interaction.response.send_message(
            embed=embeds.ok(msg) if ok else embeds.error(msg), ephemeral=True)

    @casos.command(name="anular", description="Anula un caso (no deshace la sancion).")
    @app_commands.describe(numero="Numero del caso.", motivo="Por que se anula.")
    @admin_only()
    async def anular(self, interaction: discord.Interaction, numero: int,
                     motivo: app_commands.Range[str, casemgmt.MIN_REASON, casemgmt.MAX_VOID_REASON]) -> None:
        ok, msg = await casemgmt.void_case(
            self.bot, interaction.guild, numero, interaction.user.id, True, motivo)
        await interaction.response.send_message(
            embed=embeds.ok(msg) if ok else embeds.error(msg), ephemeral=True)

    @casos.command(name="restaurar", description="Restaura un caso anulado.")
    @app_commands.describe(numero="Numero del caso.")
    @admin_only()
    async def restaurar(self, interaction: discord.Interaction, numero: int) -> None:
        ok, msg = await casemgmt.restore_case(
            self.bot, interaction.guild, numero, interaction.user.id, True)
        await interaction.response.send_message(
            embed=embeds.ok(msg) if ok else embeds.error(msg), ephemeral=True)

    @casos.command(name="auditoria", description="Cambios hechos a un caso.")
    @app_commands.describe(numero="Numero del caso.")
    @staff_only()
    async def auditoria(self, interaction: discord.Interaction, numero: int) -> None:
        if not await modlog.get_case(self.bot, interaction.guild.id, numero):
            await interaction.response.send_message(
                embed=embeds.error("Ese caso no existe."), ephemeral=True)
            return
        rows = await casemgmt.audit_for_case(self.bot, interaction.guild.id, numero)
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info(f"El caso #{numero} no tiene cambios."), ephemeral=True)
            return
        names = {"edit": "Edicion", "void": "Anulacion", "restore": "Restauracion"}
        embed = embeds.base(f"Auditoria · Caso #{numero}", color=config.COLOR_INFO)
        for r in rows[:10]:
            value = f"<@{r['actor_id']}>"
            if r["old_value"]:
                value += f"\nAntes: {helpers.truncate(r['old_value'], 200)}"
            if r["new_value"]:
                value += f"\nDespues: {helpers.truncate(r['new_value'], 200)}"
            embed.add_field(name=f"{names.get(r['action'], r['action'])} · <t:{r['created_at']}:f>",
                            value=value, inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(CaseManagement(bot))
