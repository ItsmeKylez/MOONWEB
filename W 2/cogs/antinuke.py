"""Anti-nuke.

Vigila las acciones destructivas del servidor por ventana de tiempo. Cuando
un usuario que no esta en la lista blanca supera el limite configurado para
una accion, se le aplica el castigo, se intenta revertir el daño y se avisa
al dueño.

El ejecutor se obtiene del audit log: es la unica fuente fiable de quien
borro un canal o baneo a alguien.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, modlog
from utils.checks import admin_only

log = logging.getLogger("bot.antinuke")

# accion interna -> (columna de limite, texto legible)
ACTIONS = {
    "channel_delete": ("lim_channel_delete", "borrar canales"),
    "channel_create": ("lim_channel_create", "crear canales"),
    "role_delete":    ("lim_role_delete", "borrar roles"),
    "role_create":    ("lim_role_create", "crear roles"),
    "ban":            ("lim_ban", "banear miembros"),
    "kick":           ("lim_kick", "expulsar miembros"),
    "webhook":        ("lim_webhook", "crear webhooks"),
    "emoji_delete":   ("lim_emoji_delete", "borrar emojis"),
    "perm_update":    ("lim_perm_update", "cambiar permisos"),
}


class RateTracker:
    """Cuenta cuantas veces ha hecho X un usuario en los ultimos N segundos."""

    def __init__(self) -> None:
        self._hits: dict[tuple[int, int, str], list[float]] = defaultdict(list)

    def hit(self, guild_id: int, user_id: int, action: str, window: int) -> int:
        key = (guild_id, user_id, action)
        now = time.time()
        bucket = self._hits[key]
        bucket.append(now)
        cutoff = now - window
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)
        return len(bucket)

    def reset(self, guild_id: int, user_id: int) -> None:
        for key in [k for k in self._hits if k[0] == guild_id and k[1] == user_id]:
            self._hits.pop(key, None)


class AntiNuke(commands.Cog, name="Anti-nuke"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.tracker = RateTracker()
        # Evita castigar dos veces al mismo atacante mientras se procesa.
        self._punishing: set[tuple[int, int]] = set()

    # =====================================================================
    #  NUCLEO
    # =====================================================================
    async def _config(self, guild_id: int) -> dict | None:
        cfg = await self.bot.db.get("antinuke_config", guild_id)
        return cfg if cfg["enabled"] else None

    async def _is_exempt(self, guild: discord.Guild, user: discord.abc.User | None) -> bool:
        """El dueño, el propio bot y la lista blanca nunca disparan el anti-nuke."""
        if user is None:
            return True
        if user.id in (guild.owner_id, self.bot.user.id):
            return True
        whitelist = await self.bot.db.get_whitelist(guild.id)
        return user.id in whitelist

    async def _register(self, guild: discord.Guild, user: discord.abc.User | None,
                        action: str, detail: str,
                        restore: callable | None = None) -> None:
        """Punto unico de entrada: cuenta la accion y castiga si toca."""
        cfg = await self._config(guild.id)
        if cfg is None or await self._is_exempt(guild, user):
            return

        column, label = ACTIONS[action]
        limit = cfg[column]
        if limit <= 0:
            return

        count = self.tracker.hit(guild.id, user.id, action, cfg["window"])
        if count < limit:
            return
        if (guild.id, user.id) in self._punishing:
            return

        self._punishing.add((guild.id, user.id))
        try:
            await self._trigger(guild, user, cfg, label, count, detail, restore)
        finally:
            self._punishing.discard((guild.id, user.id))
            self.tracker.reset(guild.id, user.id)

    async def _trigger(self, guild: discord.Guild, user: discord.abc.User, cfg: dict,
                       label: str, count: int, detail: str,
                       restore: callable | None) -> None:
        member = guild.get_member(user.id)
        applied = "no se pudo aplicar"

        if member is not None:
            applied = await self._punish(guild, member, cfg["punishment"], label)
            await modlog.create_case(
                self.bot, guild, "strip" if cfg["punishment"] == "strip" else cfg["punishment"],
                user, self.bot.user,
                f"Anti-nuke: {count} veces '{label}' en {cfg['window']}s", notify=True)

        restored = "no"
        if cfg["restore"] and restore is not None:
            try:
                restored = await restore() or "si"
            except Exception:
                log.exception("Fallo al revertir la accion del anti-nuke")
                restored = "fallo"

        embed = embeds.base(f"{config.E_SHIELD} ANTI-NUKE ACTIVADO",
                            color=config.COLOR_SECURITY)
        embed.add_field(name="Usuario", value=helpers.fmt_user(user), inline=False)
        embed.add_field(name="Accion detectada", value=f"{label} ({count} en "
                                                       f"{cfg['window']}s)", inline=False)
        embed.add_field(name="Detalle", value=helpers.truncate(detail, 500), inline=False)
        embed.add_field(name="Castigo aplicado", value=applied, inline=True)
        embed.add_field(name="Revertido", value=str(restored), inline=True)
        puede_pingear = guild.me.guild_permissions.mention_everyone
        await helpers.send_log(
            self.bot, guild, "antinuke", embed,
            content="@here" if puede_pingear else None,
            allowed_mentions=discord.AllowedMentions(everyone=puede_pingear))

        if cfg["alert_owner"] and guild.owner is not None:
            await helpers.try_dm(guild.owner, embed=embed)
        log.warning("Anti-nuke en %s contra %s (%s)", guild.id, user.id, label)

    async def _punish(self, guild: discord.Guild, member: discord.Member,
                      punishment: str, reason: str) -> str:
        """Aplica el castigo configurado y devuelve que se hizo, en texto."""
        reason_text = f"Anti-nuke: {reason}"
        if member.top_role >= guild.me.top_role:
            return "imposible: su rol esta por encima del mio"
        try:
            if punishment == "ban":
                await guild.ban(member, reason=reason_text, delete_message_seconds=0)
                return "baneado"
            if punishment == "kick":
                await member.kick(reason=reason_text)
                return "expulsado"
            removable = [r for r in member.roles
                         if not r.is_default() and not r.managed and r < guild.me.top_role]
            if removable:
                await member.remove_roles(*removable, reason=reason_text)
                return f"{len(removable)} rol(es) retirados"
            return "no tenia roles que quitar"
        except discord.Forbidden:
            return "sin permisos para castigarle"
        except discord.HTTPException:
            return "error de Discord"

    # =====================================================================
    #  EVENTOS VIGILADOS
    # =====================================================================
    @commands.Cog.listener()
    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        guild = channel.guild
        if await self._config(guild.id) is None:
            return
        entry = await helpers.find_audit(guild, discord.AuditLogAction.channel_delete, channel.id)
        if entry is None:
            return

        async def restore() -> str:
            overwrites = dict(channel.overwrites)
            kwargs = {"overwrites": overwrites, "category": channel.category,
                      "reason": "Anti-nuke: canal restaurado"}
            if isinstance(channel, discord.TextChannel):
                new = await guild.create_text_channel(channel.name, topic=channel.topic,
                                                      nsfw=channel.nsfw, **kwargs)
            elif isinstance(channel, discord.VoiceChannel):
                new = await guild.create_voice_channel(channel.name, **kwargs)
            elif isinstance(channel, discord.CategoryChannel):
                new = await guild.create_category(channel.name, overwrites=overwrites,
                                                  reason="Anti-nuke: categoria restaurada")
            else:
                return "tipo de canal no restaurable"
            try:
                await new.edit(position=channel.position)
            except discord.HTTPException:
                pass
            return f"canal recreado ({new.mention})"

        await self._register(guild, entry.user, "channel_delete",
                             f"Canal `{channel.name}` borrado", restore)

    @commands.Cog.listener()
    async def on_guild_channel_create(self, channel: discord.abc.GuildChannel) -> None:
        if await self._config(channel.guild.id) is None:
            return
        entry = await helpers.find_audit(
            channel.guild, discord.AuditLogAction.channel_create, channel.id)
        if entry is None:
            return

        async def restore() -> str:
            await channel.delete(reason="Anti-nuke: canal creado en masa")
            return "canal borrado"

        await self._register(channel.guild, entry.user, "channel_create",
                             f"Canal `{channel.name}` creado", restore)

    @commands.Cog.listener()
    async def on_guild_role_delete(self, role: discord.Role) -> None:
        guild = role.guild
        if await self._config(guild.id) is None:
            return
        entry = await helpers.find_audit(guild, discord.AuditLogAction.role_delete, role.id)
        if entry is None:
            return

        async def restore() -> str:
            new = await guild.create_role(
                name=role.name, permissions=role.permissions, colour=role.colour,
                hoist=role.hoist, mentionable=role.mentionable,
                reason="Anti-nuke: rol restaurado")
            try:
                await new.edit(position=min(role.position, guild.me.top_role.position - 1))
            except discord.HTTPException:
                pass
            return f"rol recreado ({new.mention})"

        await self._register(guild, entry.user, "role_delete",
                             f"Rol `{role.name}` borrado", restore)

    @commands.Cog.listener()
    async def on_guild_role_create(self, role: discord.Role) -> None:
        if await self._config(role.guild.id) is None:
            return
        entry = await helpers.find_audit(role.guild, discord.AuditLogAction.role_create, role.id)
        if entry is None:
            return

        async def restore() -> str:
            await role.delete(reason="Anti-nuke: roles creados en masa")
            return "rol borrado"

        await self._register(role.guild, entry.user, "role_create",
                             f"Rol `{role.name}` creado", restore)

    @commands.Cog.listener()
    async def on_member_ban(self, guild: discord.Guild, user: discord.User) -> None:
        if await self._config(guild.id) is None:
            return
        entry = await helpers.find_audit(guild, discord.AuditLogAction.ban, user.id)
        if entry is None or entry.user is None or entry.user.id == self.bot.user.id:
            return

        async def restore() -> str:
            await guild.unban(user, reason="Anti-nuke: baneo masivo revertido")
            return f"{user} desbaneado"

        await self._register(guild, entry.user, "ban", f"Baneo de {user}", restore)

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member) -> None:
        if await self._config(member.guild.id) is None:
            return
        entry = await helpers.find_audit(
            member.guild, discord.AuditLogAction.kick, member.id)
        if entry is None or entry.user is None or entry.user.id == self.bot.user.id:
            return
        await self._register(member.guild, entry.user, "kick", f"Expulsion de {member}")

    @commands.Cog.listener()
    async def on_webhooks_update(self, channel: discord.abc.GuildChannel) -> None:
        if await self._config(channel.guild.id) is None:
            return
        entry = await helpers.find_audit(
            channel.guild, discord.AuditLogAction.webhook_create)
        if entry is None:
            return

        async def restore() -> str:
            try:
                for webhook in await channel.webhooks():
                    await webhook.delete(reason="Anti-nuke: webhooks borrados")
                return "webhooks del canal borrados"
            except discord.Forbidden:
                return "sin permiso para borrar webhooks"

        await self._register(channel.guild, entry.user, "webhook",
                             f"Webhook creado en #{channel.name}", restore)

    @commands.Cog.listener()
    async def on_guild_emojis_update(self, guild: discord.Guild,
                                     before: list, after: list) -> None:
        if len(after) >= len(before) or await self._config(guild.id) is None:
            return
        entry = await helpers.find_audit(guild, discord.AuditLogAction.emoji_delete)
        if entry is None:
            return
        await self._register(guild, entry.user, "emoji_delete", "Emoji borrado")

    @commands.Cog.listener()
    async def on_guild_channel_update(self, before: discord.abc.GuildChannel,
                                      after: discord.abc.GuildChannel) -> None:
        if before.overwrites == after.overwrites:
            return
        if await self._config(after.guild.id) is None:
            return
        entry = await helpers.find_audit(
            after.guild, discord.AuditLogAction.channel_update, after.id)
        if entry is None:
            return

        async def restore() -> str:
            await after.edit(overwrites=dict(before.overwrites),
                             reason="Anti-nuke: permisos restaurados")
            return "permisos del canal restaurados"

        await self._register(after.guild, entry.user, "perm_update",
                             f"Permisos de #{after.name} modificados", restore)

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member, after: discord.Member) -> None:
        """Reparto de roles con permisos peligrosos: se actua a la primera."""
        cfg = await self._config(after.guild.id)
        if cfg is None or not cfg["block_dangerous_roles"]:
            return
        added = [r for r in after.roles if r not in before.roles]
        risky = [r for r in added if helpers.has_dangerous_permissions(r.permissions)]
        if not risky:
            return

        entry = await helpers.find_audit(
            after.guild, discord.AuditLogAction.member_role_update, after.id)
        executor = entry.user if entry else None
        if await self._is_exempt(after.guild, executor):
            return

        names = ", ".join(f"`{r.name}`" for r in risky)
        try:
            await after.remove_roles(*risky, reason="Anti-nuke: rol peligroso no autorizado")
            reverted = f"roles retirados a {after}"
        except discord.HTTPException:
            reverted = "no se pudieron retirar los roles"

        await self._register(after.guild, executor, "perm_update",
                             f"Ha dado {names} a {after}",
                             restore=lambda: asyncio.sleep(0, result=reverted))

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        """Bots añadidos por alguien que no esta en la lista blanca."""
        if not member.bot:
            return
        cfg = await self._config(member.guild.id)
        if cfg is None or not cfg["block_bots"]:
            return
        entry = await helpers.find_audit(
            member.guild, discord.AuditLogAction.bot_add, member.id)
        executor = entry.user if entry else None
        if await self._is_exempt(member.guild, executor):
            return

        try:
            await member.kick(reason="Anti-nuke: bot añadido sin autorizacion")
            note = f"bot `{member}` expulsado"
        except discord.HTTPException:
            note = "no se pudo expulsar al bot"

        embed = embeds.base(f"{config.E_SHIELD} Bot no autorizado",
                            color=config.COLOR_SECURITY)
        embed.add_field(name="Bot", value=helpers.fmt_user(member), inline=False)
        embed.add_field(name="Añadido por", value=helpers.fmt_user(executor), inline=False)
        embed.add_field(name="Resultado", value=note, inline=False)
        await helpers.send_log(self.bot, member.guild, "antinuke", embed)
        if cfg["alert_owner"] and member.guild.owner is not None:
            await helpers.try_dm(member.guild.owner, embed=embed)

    @commands.Cog.listener()
    async def on_guild_update(self, before: discord.Guild, after: discord.Guild) -> None:
        cfg = await self._config(after.id)
        if cfg is None or not cfg["block_guild_update"]:
            return
        if before.name == after.name and before.icon == after.icon:
            return
        entry = await helpers.find_audit(after, discord.AuditLogAction.guild_update)
        executor = entry.user if entry else None
        if await self._is_exempt(after, executor):
            return

        try:
            await after.edit(name=before.name, reason="Anti-nuke: nombre restaurado")
            note = "nombre del servidor restaurado"
        except discord.HTTPException:
            note = "no se pudo restaurar el nombre"

        embed = embeds.base(f"{config.E_SHIELD} Cambio del servidor bloqueado",
                            color=config.COLOR_SECURITY)
        embed.add_field(name="Por", value=helpers.fmt_user(executor), inline=False)
        embed.add_field(name="Resultado", value=note, inline=False)
        await helpers.send_log(self.bot, after, "antinuke", embed)

    # =====================================================================
    #  COMANDOS
    # =====================================================================
    antinuke = app_commands.Group(name="antinuke", description="Proteccion contra ataques al servidor.",
                                  guild_only=True,
                                  default_permissions=discord.Permissions(administrator=True))

    @antinuke.command(name="estado", description="Muestra la configuracion actual del anti-nuke.")
    @admin_only()
    async def estado(self, interaction: discord.Interaction) -> None:
        cfg = await self.bot.db.get("antinuke_config", interaction.guild.id)
        whitelist = await self.bot.db.get_whitelist(interaction.guild.id)

        estado = "ACTIVADO" if cfg["enabled"] else "DESACTIVADO"
        embed = embeds.base(f"{config.E_SHIELD} Anti-nuke: {estado}",
                            color=config.COLOR_SECURITY if cfg["enabled"] else config.COLOR_MUTED)
        embed.add_field(name="Castigo", value=cfg["punishment"], inline=True)
        embed.add_field(name="Ventana", value=f"{cfg['window']}s", inline=True)
        embed.add_field(name="Revertir daño", value="si" if cfg["restore"] else "no", inline=True)

        limits = "\n".join(
            f"`{label:<22}` {cfg[column]}" for column, label in ACTIONS.values()
        )
        embed.add_field(name="Limites por ventana", value=limits, inline=False)
        embed.add_field(
            name="Protecciones extra",
            value=(f"Roles peligrosos: {'si' if cfg['block_dangerous_roles'] else 'no'}\n"
                   f"Bots nuevos: {'si' if cfg['block_bots'] else 'no'}\n"
                   f"Cambios del servidor: {'si' if cfg['block_guild_update'] else 'no'}"),
            inline=False)
        embed.add_field(name="Lista blanca",
                        value=" ".join(f"<@{u}>" for u in list(whitelist)[:20]) or "vacia",
                        inline=False)
        embed.set_footer(text="El dueño del servidor y el propio bot estan siempre exentos.")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @antinuke.command(name="activar", description="Activa o desactiva el anti-nuke.")
    @app_commands.describe(activo="True para activarlo.")
    @admin_only()
    async def activar(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("antinuke_config", interaction.guild.id, enabled=int(activo))
        texto = ("Anti-nuke **activado**. Revisa la lista blanca con `/antinuke lista`."
                 if activo else "Anti-nuke **desactivado**.")
        await interaction.response.send_message(embed=embeds.ok(texto), ephemeral=True)

    @antinuke.command(name="castigo", description="Que hacer con quien supere un limite.")
    @app_commands.choices(tipo=[
        app_commands.Choice(name="quitarle todos los roles", value="strip"),
        app_commands.Choice(name="expulsar", value="kick"),
        app_commands.Choice(name="banear", value="ban"),
    ])
    @admin_only()
    async def castigo(self, interaction: discord.Interaction,
                      tipo: app_commands.Choice[str]) -> None:
        await self.bot.db.set("antinuke_config", interaction.guild.id, punishment=tipo.value)
        await interaction.response.send_message(
            embed=embeds.ok(f"Castigo del anti-nuke: **{tipo.name}**."), ephemeral=True)

    @antinuke.command(name="limite", description="Cambia el limite de una accion concreta.")
    @app_commands.describe(accion="Accion vigilada.", cantidad="Veces permitidas por ventana (0 = no vigilar).")
    @app_commands.choices(accion=[
        app_commands.Choice(name="borrar canales", value="channel_delete"),
        app_commands.Choice(name="crear canales", value="channel_create"),
        app_commands.Choice(name="borrar roles", value="role_delete"),
        app_commands.Choice(name="crear roles", value="role_create"),
        app_commands.Choice(name="banear", value="ban"),
        app_commands.Choice(name="expulsar", value="kick"),
        app_commands.Choice(name="crear webhooks", value="webhook"),
        app_commands.Choice(name="borrar emojis", value="emoji_delete"),
        app_commands.Choice(name="cambiar permisos", value="perm_update"),
    ])
    @admin_only()
    async def limite(self, interaction: discord.Interaction,
                     accion: app_commands.Choice[str],
                     cantidad: app_commands.Range[int, 0, 50]) -> None:
        column = ACTIONS[accion.value][0]
        await self.bot.db.set("antinuke_config", interaction.guild.id, **{column: cantidad})
        await interaction.response.send_message(
            embed=embeds.ok(f"Limite de **{accion.name}**: {cantidad} por ventana."),
            ephemeral=True)

    @antinuke.command(name="ventana", description="Segundos que dura la ventana de conteo.")
    @app_commands.describe(segundos="Entre 10 y 600.")
    @admin_only()
    async def ventana(self, interaction: discord.Interaction,
                      segundos: app_commands.Range[int, 10, 600]) -> None:
        await self.bot.db.set("antinuke_config", interaction.guild.id, window=segundos)
        await interaction.response.send_message(
            embed=embeds.ok(f"Ventana de conteo: **{segundos}s**."), ephemeral=True)

    @antinuke.command(name="extras", description="Activa o desactiva las protecciones adicionales.")
    @app_commands.describe(roles_peligrosos="Impedir que se repartan roles con permisos criticos.",
                           bots_nuevos="Expulsar bots añadidos por gente fuera de la lista blanca.",
                           cambios_servidor="Revertir cambios de nombre o icono del servidor.")
    @admin_only()
    async def extras(self, interaction: discord.Interaction,
                     roles_peligrosos: bool | None = None,
                     bots_nuevos: bool | None = None,
                     cambios_servidor: bool | None = None) -> None:
        values = {}
        if roles_peligrosos is not None:
            values["block_dangerous_roles"] = int(roles_peligrosos)
        if bots_nuevos is not None:
            values["block_bots"] = int(bots_nuevos)
        if cambios_servidor is not None:
            values["block_guild_update"] = int(cambios_servidor)
        if not values:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos una opcion."), ephemeral=True)
            return
        await self.bot.db.set("antinuke_config", interaction.guild.id, **values)
        await interaction.response.send_message(
            embed=embeds.ok("Protecciones actualizadas."), ephemeral=True)

    @antinuke.command(name="revertir", description="Intentar deshacer el daño automaticamente.")
    @app_commands.describe(activo="True para recrear canales y roles borrados.")
    @admin_only()
    async def revertir(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("antinuke_config", interaction.guild.id, restore=int(activo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Reversion automatica: **{'si' if activo else 'no'}**."),
            ephemeral=True)

    @antinuke.command(name="permitir", description="Añade un usuario o bot a la lista blanca.")
    @app_commands.describe(usuario="Persona de total confianza.")
    @admin_only()
    async def permitir(self, interaction: discord.Interaction, usuario: discord.User) -> None:
        await self.bot.db.add_whitelist(interaction.guild.id, usuario.id, interaction.user.id)
        await interaction.response.send_message(
            embed=embeds.ok(f"**{usuario}** ya no disparara el anti-nuke."), ephemeral=True)

    @antinuke.command(name="quitar", description="Saca a un usuario de la lista blanca.")
    @app_commands.describe(usuario="Usuario a quitar.")
    @admin_only()
    async def quitar(self, interaction: discord.Interaction, usuario: discord.User) -> None:
        await self.bot.db.remove_whitelist(interaction.guild.id, usuario.id)
        await interaction.response.send_message(
            embed=embeds.ok(f"**{usuario}** vuelve a estar vigilado."), ephemeral=True)

    @antinuke.command(name="lista", description="Muestra la lista blanca.")
    @admin_only()
    async def lista(self, interaction: discord.Interaction) -> None:
        whitelist = await self.bot.db.get_whitelist(interaction.guild.id)
        if not whitelist:
            texto = "La lista blanca esta vacia."
        else:
            texto = "\n".join(f"<@{u}> (`{u}`)" for u in whitelist)
        embed = embeds.base("Lista blanca del anti-nuke", helpers.truncate(texto, 3000),
                            config.COLOR_SECURITY)
        embed.set_footer(text="El dueño del servidor esta siempre exento.")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AntiNuke(bot))
