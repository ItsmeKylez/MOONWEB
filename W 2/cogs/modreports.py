"""Informes de actividad del staff: /modreporte resumen | moderador | exportar.

Los datos salen de cases, appeals y case_evidence (utils/modreports.py).
/modstats (ranking simple) sigue existiendo en el cog de moderacion.
"""

from __future__ import annotations

import io

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, modlog, modreports
from utils.checks import admin_only, staff_only
from utils.time_parser import human_duration

DAYS = app_commands.Range[int, modreports.MIN_DAYS, modreports.MAX_DAYS]


def _action_lines(by_action: dict[str, int]) -> str:
    parts = []
    for action, n in sorted(by_action.items(), key=lambda kv: -kv[1]):
        label, emoji, _ = modlog.describe(action)
        parts.append(f"{emoji} {label}: **{n}**")
    return "\n".join(parts) or "—"


class ModReports(commands.Cog, name="Informes"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    modreporte = app_commands.Group(
        name="modreporte", description="Informes de actividad del staff.", guild_only=True)

    @modreporte.command(name="resumen", description="Actividad de moderacion del servidor.")
    @app_commands.describe(dias="Periodo a analizar en dias (1-365, por defecto 30).")
    @admin_only()
    async def resumen(self, interaction: discord.Interaction, dias: DAYS = 30) -> None:
        guild = interaction.guild
        await interaction.response.defer(ephemeral=True)
        data = await modreports.gather(self.bot, guild.id, modreports.since_ts(dias),
                                       self.bot.user.id)
        t, ap = data["totals"], data["appeals"]

        embed = embeds.base(f"📊 Actividad de moderacion · ultimos {dias} dia(s)",
                            color=config.COLOR_MOD)
        embed.add_field(
            name="Totales",
            value=(f"Sanciones: **{t['sanctions']}**\nReversiones: **{t['reversals']}**\n"
                   f"Otras acciones: **{t['other']}**"), inline=True)
        embed.add_field(
            name="Apelaciones",
            value=(f"Recibidas: **{ap['submitted']}**\nAceptadas: **{ap['accepted']}**\n"
                   f"Denegadas: **{ap['denied']}**\nPendientes ahora: **{ap['pending_now']}**"),
            inline=True)
        auto = data["automated"]
        embed.add_field(
            name="Automatico (bot)",
            value=(f"**{auto['total']}** accion(es)\n_anti-spam, anti-nuke, anti-raid, escalada_"
                   if auto else "0 acciones"), inline=True)
        embed.add_field(name="Por tipo", value=_action_lines(data["by_action"]), inline=False)

        top = modreports.ranking(data, 10)
        if top:
            lines = []
            for i, (mid, e) in enumerate(top, 1):
                extra = []
                if e["reversals"]:
                    extra.append(f"{e['reversals']} reversion(es)")
                resolved = e["appeals_accepted"] + e["appeals_denied"]
                if resolved:
                    extra.append(f"{resolved} apelacion(es)")
                if e["evidence"]:
                    extra.append(f"{e['evidence']} evidencia(s)")
                tail = f" · {', '.join(extra)}" if extra else ""
                lines.append(f"`{i:>2}.` <@{mid}> — **{e['sanctions']}** sanciones{tail}")
            embed.add_field(name="Moderadores", value="\n".join(lines)[:1024], inline=False)
        else:
            embed.add_field(name="Moderadores", value="Sin actividad humana en este periodo.",
                            inline=False)

        cfg = await self.bot.db.get("guild_config", guild.id)
        role = guild.get_role(cfg["staff_role"]) if cfg.get("staff_role") else None
        if role is not None:
            staff_ids = [m.id for m in role.members if not m.bot]
            idle = modreports.inactive(staff_ids, data)
            if idle:
                mentions = ", ".join(f"<@{i}>" for i in idle[:15])
                more = f" y {len(idle) - 15} mas" if len(idle) > 15 else ""
                embed.add_field(name=f"Staff sin actividad ({len(idle)}/{len(staff_ids)})",
                                value=(mentions + more)[:1024], inline=False)
        else:
            embed.set_footer(text="Configura /config staff para ver tambien quien no ha tenido actividad.")
        await interaction.followup.send(embed=embed, ephemeral=True)

    @modreporte.command(name="moderador", description="Actividad detallada de un moderador.")
    @app_commands.describe(usuario="Moderador a consultar (tu mismo, o cualquiera si eres admin).",
                           dias="Periodo en dias (1-365, por defecto 30).")
    @staff_only()
    async def moderador(self, interaction: discord.Interaction, usuario: discord.User,
                        dias: DAYS = 30) -> None:
        guild = interaction.guild
        if usuario.id != interaction.user.id and not await helpers.is_admin(
                self.bot, interaction.user):
            await interaction.response.send_message(
                embed=embeds.error("Solo los administradores pueden ver la actividad de otros "
                                   "moderadores. Puedes consultar la tuya."), ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        since = modreports.since_ts(dias)
        data = await modreports.gather(self.bot, guild.id, since, self.bot.user.id)
        is_bot = usuario.id == self.bot.user.id
        e = data["automated"] if is_bot else data["moderators"].get(usuario.id)

        embed = embeds.base(f"📊 {usuario} · ultimos {dias} dia(s)", color=config.COLOR_MOD)
        embed.set_thumbnail(url=usuario.display_avatar.url)
        if not e:
            embed.description = "Sin actividad registrada en este periodo."
            await interaction.followup.send(embed=embed, ephemeral=True)
            return

        embed.add_field(
            name="Resumen",
            value=(f"Sanciones: **{e['sanctions']}**\nReversiones: **{e['reversals']}**\n"
                   f"Otras: **{e['other']}**\nMedia: **{e['sanctions'] / dias:.2f}** sanciones/dia"),
            inline=True)
        embed.add_field(
            name="Apelaciones y pruebas",
            value=(f"Apelaciones aceptadas: **{e['appeals_accepted']}**\n"
                   f"Apelaciones denegadas: **{e['appeals_denied']}**\n"
                   f"Evidencias subidas: **{e['evidence']}**"), inline=True)
        embed.add_field(name="Por tipo", value=_action_lines(e["by_action"]), inline=False)
        if e["first"]:
            embed.add_field(name="Primera / ultima accion",
                            value=f"<t:{e['first']}:d> / <t:{e['last']}:R>", inline=False)

        rows = await modreports.recent_cases(self.bot, guild.id, usuario.id, since)
        if rows:
            lines = []
            for r in rows:
                label, emoji, _ = modlog.describe(r["action"])
                lines.append(f"#{r['number']} {emoji} {label} → <@{r['user_id']}> · "
                             f"<t:{r['created_at']}:d>")
            embed.add_field(name="Ultimos casos", value="\n".join(lines)[:1024], inline=False)
        await interaction.followup.send(embed=embed, ephemeral=True)

    @modreporte.command(name="exportar", description="Exporta la actividad del staff en CSV.")
    @app_commands.describe(dias="Periodo en dias (1-365, por defecto 30).")
    @admin_only()
    async def exportar(self, interaction: discord.Interaction, dias: DAYS = 30) -> None:
        guild = interaction.guild
        await interaction.response.defer(ephemeral=True)
        data = await modreports.gather(self.bot, guild.id, modreports.since_ts(dias),
                                       self.bot.user.id)
        names = {}
        for mid in data["moderators"]:
            member = guild.get_member(mid)
            if member is not None:
                names[mid] = member.display_name
        csv_text = modreports.to_csv(data, names)
        file = discord.File(io.BytesIO(csv_text.encode("utf-8-sig")),
                            filename=f"actividad_staff_{dias}d.csv")
        await interaction.followup.send(
            embed=embeds.ok(f"Informe de los ultimos {dias} dia(s): "
                            f"**{len(data['moderators'])}** moderador(es)."),
            file=file, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(ModReports(bot))
