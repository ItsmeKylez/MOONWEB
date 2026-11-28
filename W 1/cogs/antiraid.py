"""Anti-raid.

Detecta oleadas de entradas y cuentas sospechosas. Cuando salta, aplica la
accion configurada a los nuevos miembros y opcionalmente cierra el servidor
durante unos minutos.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import defaultdict, deque
from datetime import timedelta

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, modlog
from utils.checks import admin_only

log = logging.getLogger("bot.antiraid")

ACTION_CHOICES = [
    app_commands.Choice(name="no hacer nada", value="none"),
    app_commands.Choice(name="poner en cuarentena", value="quarantine"),
    app_commands.Choice(name="expulsar", value="kick"),
    app_commands.Choice(name="banear", value="ban"),
]


class AntiRaid(commands.Cog, name="Anti-raid"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._joins: dict[int, deque[float]] = defaultdict(lambda: deque(maxlen=200))
        self._raid_until: dict[int, float] = {}
        self._unlock_tasks: dict[int, asyncio.Task] = {}

    def cog_unload(self) -> None:
        for task in self._unlock_tasks.values():
            task.cancel()

    def raid_active(self, guild_id: int) -> bool:
        return self._raid_until.get(guild_id, 0) > time.time()

    # =====================================================================
    #  DETECCION
    # =====================================================================
    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        guild = member.guild
        cfg = await self.bot.db.get("antiraid_config", guild.id)
        if not cfg["enabled"] or member.bot:
            return

        whitelist = await self.bot.db.get_whitelist(guild.id)
        if member.id in whitelist:
            return

        # 1. Filtros individuales de la cuenta.
        verdict = self._suspicious(member, cfg)
        if verdict is not None:
            reason, action = verdict
            await self._apply(member, action, f"Anti-raid: {reason}")
            await self._report(guild, member, reason, action)
            return

        # 2. Oleada de entradas.
        now = time.time()
        bucket = self._joins[guild.id]
        bucket.append(now)
        cutoff = now - cfg["join_window"]
        recent = sum(1 for t in bucket if t >= cutoff)

        if cfg["panic"] or self.raid_active(guild.id):
            await self._apply(member, cfg["raid_action"], "Anti-raid: modo defensivo activo")
            return

        if recent >= cfg["join_count"]:
            await self._start_raid(guild, cfg, recent)
            await self._apply(member, cfg["raid_action"], "Anti-raid: oleada de entradas")

    def _suspicious(self, member: discord.Member, cfg: dict) -> tuple[str, str] | None:
        """Devuelve (motivo, accion) si la cuenta no pasa los filtros de entrada."""
        if cfg["min_age_days"] > 0 and cfg["age_action"] != "none":
            age_days = (discord.utils.utcnow() - member.created_at).days
            if age_days < cfg["min_age_days"]:
                return f"cuenta creada hace solo {age_days} dia(s)", cfg["age_action"]
        if cfg["no_avatar_action"] != "none" and member.avatar is None:
            return "cuenta sin foto de perfil", cfg["no_avatar_action"]
        if cfg["name_regex"]:
            try:
                if re.search(cfg["name_regex"], member.name, re.I):
                    return "nombre bloqueado por el patron configurado", cfg["raid_action"]
            except re.error:
                log.warning("Regex de anti-raid invalida en %s", member.guild.id)
        return None

    async def _apply(self, member: discord.Member, action: str, reason: str) -> None:
        guild = member.guild
        try:
            if action == "ban":
                await guild.ban(member, reason=reason, delete_message_seconds=0)
            elif action == "kick":
                await member.kick(reason=reason)
            elif action == "quarantine":
                await self._quarantine(member, reason)
            else:
                return
        except discord.HTTPException:
            log.warning("No se pudo aplicar '%s' a %s", action, member.id)
            return

        if action != "none":
            await modlog.create_case(self.bot, guild, action if action != "quarantine"
                                     else "quarantine", member, self.bot.user, reason,
                                     notify=False)

    async def _quarantine(self, member: discord.Member, reason: str) -> None:
        """Rol de cuarentena si esta configurado; si no, aislamiento de 1 hora."""
        guild_cfg = await self.bot.db.get("guild_config", member.guild.id)
        role_id = guild_cfg.get("quarantine_role")
        role = member.guild.get_role(role_id) if role_id else None
        if role is not None and role < member.guild.me.top_role:
            await member.add_roles(role, reason=reason)
        else:
            await member.timeout(timedelta(hours=1), reason=reason)

    async def _start_raid(self, guild: discord.Guild, cfg: dict, count: int) -> None:
        minutes = max(1, cfg["lockdown_minutes"])
        self._raid_until[guild.id] = time.time() + minutes * 60

        embed = embeds.base(f"{config.E_FIRE} POSIBLE RAID DETECTADO",
                            color=config.COLOR_SECURITY)
        embed.add_field(name="Entradas", value=f"{count} en {cfg['join_window']}s", inline=True)
        embed.add_field(name="Accion sobre nuevos", value=cfg["raid_action"], inline=True)
        embed.add_field(name="Modo defensivo", value=f"{minutes} minutos", inline=True)

        if cfg["lockdown"]:
            moderation = self.bot.get_cog("Moderacion")
            locked = 0
            if moderation is not None:
                locked = await moderation.apply_lockdown(guild, True, "Anti-raid")
            try:
                await guild.edit(verification_level=discord.VerificationLevel.high,
                                 reason="Anti-raid")
            except discord.HTTPException:
                pass
            embed.add_field(name="Bloqueo", value=f"{locked} canal(es) cerrados", inline=False)
            self._schedule_unlock(guild, minutes)

        mention = None
        if cfg["alert_role"]:
            role = guild.get_role(cfg["alert_role"])
            mention = role.mention if role else None
        await helpers.send_log(
            self.bot, guild, "seguridad", embed, content=mention,
            allowed_mentions=discord.AllowedMentions(roles=True))

        if guild.owner is not None:
            await helpers.try_dm(guild.owner, embed=embed)
        log.warning("Raid detectado en %s (%s entradas)", guild.id, count)

    def _schedule_unlock(self, guild: discord.Guild, minutes: int) -> None:
        old = self._unlock_tasks.get(guild.id)
        if old is not None and not old.done():
            old.cancel()

        async def unlock_later() -> None:
            try:
                await asyncio.sleep(minutes * 60)
            except asyncio.CancelledError:
                return
            moderation = self.bot.get_cog("Moderacion")
            if moderation is not None:
                await moderation.apply_lockdown(guild, False, "Anti-raid: fin del bloqueo")
            self._raid_until.pop(guild.id, None)
            await helpers.send_log(
                self.bot, guild, "seguridad",
                embeds.ok("Modo defensivo terminado. Los canales vuelven a estar abiertos.",
                          "Anti-raid"))

        self._unlock_tasks[guild.id] = self.bot.loop.create_task(unlock_later())

    async def _report(self, guild: discord.Guild, member: discord.Member,
                      reason: str, action: str) -> None:
        if action == "none":
            return
        embed = embeds.base(f"{config.E_SHIELD} Entrada bloqueada", color=config.COLOR_WARN)
        embeds.author_field(embed, member)
        embed.add_field(name="Motivo", value=reason, inline=False)
        embed.add_field(name="Accion", value=action, inline=True)
        embed.add_field(name="Cuenta creada", value=helpers.ts(member.created_at), inline=True)
        await helpers.send_log(self.bot, guild, "seguridad", embed)

    # =====================================================================
    #  COMANDOS
    # =====================================================================
    antiraid = app_commands.Group(
        name="antiraid", description="Proteccion contra oleadas de entradas.",
        guild_only=True, default_permissions=discord.Permissions(administrator=True))

    @antiraid.command(name="estado", description="Muestra la configuracion del anti-raid.")
    @admin_only()
    async def estado(self, interaction: discord.Interaction) -> None:
        cfg = await self.bot.db.get("antiraid_config", interaction.guild.id)
        activo = "ACTIVADO" if cfg["enabled"] else "DESACTIVADO"
        embed = embeds.base(f"{config.E_SHIELD} Anti-raid: {activo}",
                            color=config.COLOR_SECURITY if cfg["enabled"] else config.COLOR_MUTED)
        embed.add_field(name="Oleada",
                        value=f"{cfg['join_count']} entradas en {cfg['join_window']}s",
                        inline=False)
        embed.add_field(name="Edad minima de cuenta",
                        value=f"{cfg['min_age_days']} dias ({cfg['age_action']})", inline=True)
        embed.add_field(name="Sin avatar", value=cfg["no_avatar_action"], inline=True)
        embed.add_field(name="Accion durante el raid", value=cfg["raid_action"], inline=True)
        embed.add_field(name="Cierre automatico",
                        value=(f"si, {cfg['lockdown_minutes']} min" if cfg["lockdown"] else "no"),
                        inline=True)
        embed.add_field(name="Modo panico", value="si" if cfg["panic"] else "no", inline=True)
        embed.add_field(name="Patron de nombres",
                        value=f"`{cfg['name_regex']}`" if cfg["name_regex"] else "ninguno",
                        inline=False)
        if self.raid_active(interaction.guild.id):
            restante = int(self._raid_until[interaction.guild.id] - time.time())
            embed.add_field(name="AHORA MISMO",
                            value=f"Modo defensivo activo ({restante}s restantes)", inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @antiraid.command(name="activar", description="Activa o desactiva el anti-raid.")
    @app_commands.describe(activo="True para activarlo.")
    @admin_only()
    async def activar(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id, enabled=int(activo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Anti-raid **{'activado' if activo else 'desactivado'}**."),
            ephemeral=True)

    @antiraid.command(name="oleada", description="Cuantas entradas seguidas se consideran un raid.")
    @app_commands.describe(entradas="Numero de entradas.", segundos="Ventana de tiempo.")
    @admin_only()
    async def oleada(self, interaction: discord.Interaction,
                     entradas: app_commands.Range[int, 2, 100],
                     segundos: app_commands.Range[int, 3, 300]) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id,
                              join_count=entradas, join_window=segundos)
        await interaction.response.send_message(
            embed=embeds.ok(f"Se considerara raid a partir de **{entradas} entradas "
                            f"en {segundos}s**."), ephemeral=True)

    @antiraid.command(name="edad", description="Edad minima que debe tener una cuenta para entrar.")
    @app_commands.describe(dias="0 para no comprobarlo.", accion="Que hacer con las cuentas nuevas.")
    @app_commands.choices(accion=ACTION_CHOICES)
    @admin_only()
    async def edad(self, interaction: discord.Interaction,
                   dias: app_commands.Range[int, 0, 365],
                   accion: app_commands.Choice[str]) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id,
                              min_age_days=dias, age_action=accion.value)
        await interaction.response.send_message(
            embed=embeds.ok(f"Cuentas de menos de **{dias} dias**: {accion.name}."),
            ephemeral=True)

    @antiraid.command(name="avatar", description="Que hacer con las cuentas sin foto de perfil.")
    @app_commands.choices(accion=ACTION_CHOICES)
    @admin_only()
    async def avatar(self, interaction: discord.Interaction,
                     accion: app_commands.Choice[str]) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id,
                              no_avatar_action=accion.value)
        await interaction.response.send_message(
            embed=embeds.ok(f"Cuentas sin avatar: **{accion.name}**."), ephemeral=True)

    @antiraid.command(name="accion", description="Que hacer con quien entre durante un raid.")
    @app_commands.choices(accion=ACTION_CHOICES)
    @admin_only()
    async def accion(self, interaction: discord.Interaction,
                     accion: app_commands.Choice[str]) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id,
                              raid_action=accion.value)
        await interaction.response.send_message(
            embed=embeds.ok(f"Durante un raid: **{accion.name}**."), ephemeral=True)

    @antiraid.command(name="cierre", description="Cerrar los canales automaticamente durante un raid.")
    @app_commands.describe(activo="True para cerrarlos.", minutos="Cuanto dura el cierre.")
    @admin_only()
    async def cierre(self, interaction: discord.Interaction, activo: bool,
                     minutos: app_commands.Range[int, 1, 180] = 10) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id,
                              lockdown=int(activo), lockdown_minutes=minutos)
        await interaction.response.send_message(
            embed=embeds.ok(f"Cierre automatico: **{'si' if activo else 'no'}** "
                            f"({minutos} minutos)."), ephemeral=True)

    @antiraid.command(name="panico", description="Fuerza el modo defensivo hasta que lo apagues.")
    @app_commands.describe(activo="True para activar el modo panico.")
    @admin_only()
    async def panico(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id, panic=int(activo))
        cfg = await self.bot.db.get("antiraid_config", interaction.guild.id)
        moderation = self.bot.get_cog("Moderacion")
        await interaction.response.defer(ephemeral=True)

        if activo:
            self._raid_until[interaction.guild.id] = time.time() + 86400
            if cfg["lockdown"] and moderation is not None:
                await moderation.apply_lockdown(interaction.guild, True, "Modo panico")
            texto = ("Modo panico **activado**. Todo el que entre recibira "
                     f"`{cfg['raid_action']}` y los canales quedan cerrados.")
        else:
            self._raid_until.pop(interaction.guild.id, None)
            task = self._unlock_tasks.pop(interaction.guild.id, None)
            if task is not None:
                task.cancel()
            if moderation is not None:
                await moderation.apply_lockdown(interaction.guild, False, "Fin del modo panico")
            texto = "Modo panico **desactivado**. Los canales vuelven a abrirse."

        await interaction.followup.send(embed=embeds.ok(texto), ephemeral=True)

    @antiraid.command(name="patron", description="Expresion regular para bloquear nombres.")
    @app_commands.describe(regex="Ej: (raid|nuke|hack). Deja vacio para quitarlo.")
    @admin_only()
    async def patron(self, interaction: discord.Interaction, regex: str | None = None) -> None:
        if regex:
            try:
                re.compile(regex)
            except re.error as exc:
                await interaction.response.send_message(
                    embed=embeds.error(f"Esa expresion no es valida: `{exc}`"), ephemeral=True)
                return
        await self.bot.db.set("antiraid_config", interaction.guild.id, name_regex=regex)
        await interaction.response.send_message(
            embed=embeds.ok(f"Patron de nombres: `{regex}`" if regex else "Patron eliminado."),
            ephemeral=True)

    @antiraid.command(name="alerta", description="Rol al que avisar cuando salte el anti-raid.")
    @app_commands.describe(rol="Rol de staff. Deja vacio para no avisar a nadie.")
    @admin_only()
    async def alerta(self, interaction: discord.Interaction,
                     rol: discord.Role | None = None) -> None:
        await self.bot.db.set("antiraid_config", interaction.guild.id,
                              alert_role=rol.id if rol else None)
        await interaction.response.send_message(
            embed=embeds.ok(f"Se avisara a {rol.mention}." if rol else "No se avisara a ningun rol."),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AntiRaid(bot))
