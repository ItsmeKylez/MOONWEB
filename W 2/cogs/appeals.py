"""Apelaciones: boton en el DM de la sancion, /apelar y /apelacion (staff).

La logica esta en utils/appeals.py. El boton del DM es un DynamicItem para que
siga funcionando tras reiniciar el bot, y porque un usuario baneado ya no puede
usar comandos en el servidor.
"""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import appeals, embeds, helpers, modlog
from utils.checks import admin_only, staff_only
from utils.paginator import send_pages


class AppealModal(discord.ui.Modal, title="Apelar sancion"):
    texto = discord.ui.TextInput(
        label="¿Por que deberiamos revisar esta sancion?",
        style=discord.TextStyle.paragraph, min_length=appeals.MIN_REASON,
        max_length=appeals.MAX_REASON, required=True,
        placeholder="Explica con calma que paso y por que crees que es un error.")

    def __init__(self, guild_id: int, case_number: int):
        super().__init__(timeout=900)
        self.guild_id, self.case_number = guild_id, case_number

    async def on_submit(self, interaction: discord.Interaction) -> None:
        guild = interaction.client.get_guild(self.guild_id)
        if guild is None:
            await interaction.response.send_message(
                embed=embeds.error("Ya no puedo acceder a ese servidor."), ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        appeal, err = await appeals.submit(interaction.client, guild, interaction.user,
                                           self.case_number, self.texto.value)
        if err:
            await interaction.followup.send(embed=embeds.error(err), ephemeral=True)
            return
        await interaction.followup.send(
            embed=embeds.ok(f"Apelacion **#{appeal['id']}** enviada al staff de **{guild.name}**. "
                            "Recibiras la respuesta por mensaje privado."), ephemeral=True)


class AppealButton(discord.ui.DynamicItem[discord.ui.Button],
                   template=r"appeal:(?P<guild>[0-9]+):(?P<case>[0-9]+)"):
    """Boton 'Apelar este caso' que acompana al DM de la sancion."""

    def __init__(self, guild_id: int, case_number: int):
        super().__init__(discord.ui.Button(
            label="Apelar este caso", emoji="📨", style=discord.ButtonStyle.secondary,
            custom_id=f"appeal:{guild_id}:{case_number}"))
        self.guild_id, self.case_number = guild_id, case_number

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction,
                             item: discord.ui.Button, match, /):
        return cls(int(match["guild"]), int(match["case"]))

    async def callback(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_modal(AppealModal(self.guild_id, self.case_number))


STATE_CHOICES = [
    app_commands.Choice(name="pendientes", value="pending"),
    app_commands.Choice(name="aceptadas", value="accepted"),
    app_commands.Choice(name="denegadas", value="denied"),
]


def _appeal_embed(row: dict, case: dict | None) -> discord.Embed:
    color = {"pending": config.COLOR_INFO, "accepted": config.COLOR_OK,
             "denied": config.COLOR_ERROR}[row["status"]]
    embed = embeds.base(f"📨 Apelacion #{row['id']} · {appeals.STATUS_LABELS[row['status']]}",
                        color=color)
    embed.add_field(name="Usuario", value=f"<@{row['user_id']}> (`{row['user_id']}`)", inline=False)
    embed.add_field(name="Caso", value=f"#{row['case_number']}", inline=True)
    if case:
        label, emoji, _ = modlog.describe(case["action"])
        embed.add_field(name="Sancion", value=f"{emoji} {label}", inline=True)
        embed.add_field(name="Motivo original", value=helpers.truncate(case["reason"], 500),
                        inline=False)
    embed.add_field(name="Apelacion", value=helpers.truncate(row["reason"], 1000), inline=False)
    embed.add_field(name="Enviada", value=f"<t:{row['created_at']}:F>", inline=False)
    if row["reviewed_by"]:
        embed.add_field(name="Revisada por",
                        value=f"<@{row['reviewed_by']}> · <t:{row['reviewed_at']}:d>", inline=False)
    if row["review_note"]:
        embed.add_field(name="Nota del staff", value=helpers.truncate(row["review_note"], 500),
                        inline=False)
    if row["revert_note"]:
        embed.add_field(name="Sancion deshecha", value=helpers.truncate(row["revert_note"], 500),
                        inline=False)
    return embed


class Appeals(commands.Cog, name="Apelaciones"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def cog_load(self) -> None:
        self.bot.add_dynamic_items(AppealButton)

    async def cog_unload(self) -> None:
        self.bot.remove_dynamic_items(AppealButton)

    # -- usuario ------------------------------------------------------------
    @app_commands.command(name="apelar", description="Apela una sancion que te pusieron.")
    @app_commands.describe(caso="Numero del caso (aparece en el mensaje de la sancion).",
                           razon="Por que crees que la sancion debe revisarse.")
    @app_commands.guild_only()
    async def apelar(self, interaction: discord.Interaction, caso: int, razon: str) -> None:
        await interaction.response.defer(ephemeral=True)
        appeal, err = await appeals.submit(self.bot, interaction.guild, interaction.user,
                                           caso, razon)
        if err:
            await interaction.followup.send(embed=embeds.error(err), ephemeral=True)
            return
        await interaction.followup.send(
            embed=embeds.ok(f"Apelacion **#{appeal['id']}** enviada al staff. "
                            "Recibiras la respuesta por mensaje privado."), ephemeral=True)

    # -- staff --------------------------------------------------------------
    apelacion = app_commands.Group(name="apelacion", description="Gestion de apelaciones.",
                                   guild_only=True)

    @apelacion.command(name="config", description="Activa las apelaciones y fija el plazo.")
    @app_commands.describe(estado="on para activar, off para desactivar.",
                           dias="Dias tras la sancion en los que se puede apelar (0 = sin limite).")
    @app_commands.choices(estado=[app_commands.Choice(name="on", value="on"),
                                  app_commands.Choice(name="off", value="off")])
    @admin_only()
    async def config_cmd(self, interaction: discord.Interaction,
                         estado: app_commands.Choice[str] | None = None,
                         dias: app_commands.Range[int, 0, appeals.MAX_WINDOW_DAYS] | None = None
                         ) -> None:
        guild_id = interaction.guild.id
        changes = {}
        if estado is not None:
            changes["enabled"] = int(estado.value == "on")
        if dias is not None:
            changes["window_days"] = dias
        if changes:
            await self.bot.db.set("appeal_config", guild_id, **changes)
        cfg = await appeals.get_config(self.bot, guild_id)
        channels = await self.bot.db.get_log_channels(guild_id)
        where = (f"<#{channels['apelaciones']}>" if "apelaciones" in channels
                 else "canal de **moderacion** (usa `/config logs` para fijar uno de apelaciones)")
        window = f"{cfg['window_days']} dia(s)" if cfg["window_days"] else "sin limite"
        embed = embeds.base("Apelaciones", color=config.COLOR_INFO)
        embed.add_field(name="Estado", value="🟢 activadas" if cfg["enabled"] else "🔴 desactivadas",
                        inline=True)
        embed.add_field(name="Plazo", value=window, inline=True)
        embed.add_field(name="Las apelaciones llegan a", value=where, inline=False)
        embed.set_footer(text="Apelables: ban, ban temporal, aislamiento y aviso.")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @apelacion.command(name="lista", description="Lista las apelaciones.")
    @app_commands.describe(estado="Filtrar por estado (por defecto: pendientes).")
    @app_commands.choices(estado=STATE_CHOICES)
    @staff_only()
    async def lista(self, interaction: discord.Interaction,
                    estado: app_commands.Choice[str] | None = None) -> None:
        status = estado.value if estado else "pending"
        rows = await self.bot.db.fetchall(
            "SELECT * FROM appeals WHERE guild_id=? AND status=? ORDER BY id DESC LIMIT 60",
            (interaction.guild.id, status))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info(f"No hay apelaciones {appeals.STATUS_LABELS[status].lower()}s."),
                ephemeral=True)
            return
        pages = []
        for group in helpers.chunk(rows, 6):
            embed = embeds.base(f"Apelaciones · {appeals.STATUS_LABELS[status]}s",
                                color=config.COLOR_INFO)
            for r in group:
                embed.add_field(
                    name=f"#{r['id']} · Caso #{r['case_number']} · <t:{r['created_at']}:d>",
                    value=f"<@{r['user_id']}>\n{helpers.truncate(r['reason'], 150)}",
                    inline=False)
            pages.append(embed)
        await send_pages(interaction, pages, ephemeral=True)

    @apelacion.command(name="ver", description="Muestra una apelacion completa.")
    @app_commands.describe(id="Numero de la apelacion.")
    @staff_only()
    async def ver(self, interaction: discord.Interaction, id: int) -> None:
        row = await appeals.get_appeal(self.bot, interaction.guild.id, id)
        if not row:
            await interaction.response.send_message(
                embed=embeds.error("No existe esa apelacion."), ephemeral=True)
            return
        case = await modlog.get_case(self.bot, interaction.guild.id, row["case_number"])
        await interaction.response.send_message(embed=_appeal_embed(row, case), ephemeral=True)

    @apelacion.command(name="aceptar", description="Acepta la apelacion y deshace la sancion.")
    @app_commands.describe(id="Numero de la apelacion.", nota="Mensaje opcional para el usuario.")
    @staff_only()
    async def aceptar(self, interaction: discord.Interaction, id: int,
                      nota: str | None = None) -> None:
        await self._resolve(interaction, id, True, nota)

    @apelacion.command(name="denegar", description="Deniega la apelacion (decision definitiva).")
    @app_commands.describe(id="Numero de la apelacion.", nota="Mensaje opcional para el usuario.")
    @staff_only()
    async def denegar(self, interaction: discord.Interaction, id: int,
                      nota: str | None = None) -> None:
        await self._resolve(interaction, id, False, nota)

    async def _resolve(self, interaction: discord.Interaction, appeal_id: int,
                       accept: bool, note: str | None) -> None:
        await interaction.response.defer(ephemeral=True)
        result, err = await appeals.decide(self.bot, interaction.guild, interaction.user,
                                           appeal_id, accept, note)
        if err:
            await interaction.followup.send(embed=embeds.error(err), ephemeral=True)
            return
        text = f"Apelacion #{appeal_id} {'aceptada' if accept else 'denegada'}."
        if result["revert_note"]:
            text += f"\n{result['revert_note']}"
        await interaction.followup.send(embed=embeds.ok(text), ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Appeals(bot))
