"""Registro de eventos del servidor.

Cada evento se manda al canal configurado para su categoria. Cuando Discord
no dice quien hizo la accion se consulta el audit log, que es la unica forma
de saber, por ejemplo, quien borro un canal.
"""

from __future__ import annotations

import logging

import discord
from discord.ext import commands

import config
from utils import embeds, helpers

log = logging.getLogger("bot.logs")


class Logs(commands.Cog, name="Logs"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # guild_id -> {invite_code: usos}. Sirve para saber que invitacion
        # ha usado cada miembro nuevo.
        self._invites: dict[int, dict[str, int]] = {}

    async def cog_load(self) -> None:
        self.bot.loop.create_task(self._prime_invites())

    async def _prime_invites(self) -> None:
        await self.bot.wait_until_ready()
        for guild in self.bot.guilds:
            await self._refresh_invites(guild)

    async def _refresh_invites(self, guild: discord.Guild) -> None:
        if not guild.me.guild_permissions.manage_guild:
            return
        try:
            invites = await guild.invites()
        except (discord.Forbidden, discord.HTTPException):
            return
        self._invites[guild.id] = {i.code: i.uses or 0 for i in invites}

    async def _used_invite(self, guild: discord.Guild) -> discord.Invite | None:
        """Compara los usos actuales con los cacheados para deducir cual se uso."""
        if not guild.me.guild_permissions.manage_guild:
            return None
        try:
            invites = await guild.invites()
        except (discord.Forbidden, discord.HTTPException):
            return None
        before = self._invites.get(guild.id, {})
        found = None
        for invite in invites:
            if (invite.uses or 0) > before.get(invite.code, 0):
                found = invite
                break
        self._invites[guild.id] = {i.code: i.uses or 0 for i in invites}
        return found

    # =====================================================================
    #  MENSAJES
    # =====================================================================
    @commands.Cog.listener()
    async def on_message_delete(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot:
            return
        if await helpers.is_ignored(self.bot, message.guild.id, message.channel, message.author):
            return

        embed = embeds.base(f"{config.E_TRASH} Mensaje borrado", color=config.COLOR_ERROR)
        embeds.author_field(embed, message.author)
        embed.add_field(name="Canal", value=message.channel.mention, inline=True)
        embed.add_field(name="Enviado", value=helpers.ts(message.created_at), inline=True)
        embed.add_field(name="Contenido",
                        value=helpers.truncate(message.content, 1000), inline=False)
        if message.attachments:
            embed.add_field(
                name="Adjuntos",
                value="\n".join(f"`{a.filename}`" for a in message.attachments[:5]),
                inline=False)

        entry = await helpers.find_audit(
            message.guild, discord.AuditLogAction.message_delete, message.author.id)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Borrado por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, message.guild, "mensajes", embed)

    @commands.Cog.listener()
    async def on_message_edit(self, before: discord.Message, after: discord.Message) -> None:
        if after.guild is None or after.author.bot or before.content == after.content:
            return
        if await helpers.is_ignored(self.bot, after.guild.id, after.channel, after.author):
            return

        embed = embeds.base("Mensaje editado", color=config.COLOR_WARN)
        embeds.author_field(embed, after.author)
        embed.add_field(name="Canal", value=after.channel.mention, inline=True)
        embed.add_field(name="Ir al mensaje", value=f"[Abrir]({after.jump_url})", inline=True)
        embed.add_field(name="Antes", value=helpers.truncate(before.content, 500), inline=False)
        embed.add_field(name="Despues", value=helpers.truncate(after.content, 500), inline=False)
        await helpers.send_log(self.bot, after.guild, "mensajes", embed)

    @commands.Cog.listener()
    async def on_bulk_message_delete(self, messages: list[discord.Message]) -> None:
        if not messages or messages[0].guild is None:
            return
        guild = messages[0].guild
        channel = messages[0].channel
        if await helpers.is_ignored(self.bot, guild.id, channel, None):
            return
        embed = embeds.base(f"{config.E_TRASH} Borrado masivo de mensajes",
                            color=config.COLOR_ERROR)
        embed.add_field(name="Canal", value=channel.mention, inline=True)
        embed.add_field(name="Cantidad", value=str(len(messages)), inline=True)
        await helpers.send_log(self.bot, guild, "mensajes", embed)

    # =====================================================================
    #  MIEMBROS
    # =====================================================================
    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        embed = embeds.base("Miembro nuevo", color=config.COLOR_OK)
        embeds.author_field(embed, member)
        embed.add_field(name="Cuenta creada", value=helpers.ts(member.created_at), inline=True)
        embed.add_field(name="Miembros", value=str(member.guild.member_count), inline=True)
        if member.bot:
            entry = await helpers.find_audit(
                member.guild, discord.AuditLogAction.bot_add, member.id)
            embed.add_field(name="Bot añadido por",
                            value=helpers.fmt_user(entry.user) if entry else "desconocido",
                            inline=False)
        else:
            invite = await self._used_invite(member.guild)
            if invite is not None:
                embed.add_field(
                    name="Invitacion usada",
                    value=f"`{invite.code}` de {helpers.fmt_user(invite.inviter)}",
                    inline=False)
        embed.set_thumbnail(url=member.display_avatar.url)
        await helpers.send_log(self.bot, member.guild, "miembros", embed)

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member) -> None:
        # Distinguir salida voluntaria de expulsion mirando el audit log.
        entry = await helpers.find_audit(member.guild, discord.AuditLogAction.kick, member.id)
        if entry is not None and entry.user is not None:
            embed = embeds.base(f"{config.E_BOOT} Miembro expulsado", color=config.COLOR_MOD)
            embed.add_field(name="Moderador", value=helpers.fmt_user(entry.user), inline=False)
            embed.add_field(name="Motivo", value=entry.reason or "sin motivo", inline=False)
        else:
            embed = embeds.base("Miembro fuera", color=config.COLOR_MUTED)
            roles = [r.mention for r in member.roles if not r.is_default()]
            if roles:
                embed.add_field(name="Roles que tenia",
                                value=helpers.truncate(" ".join(roles), 900), inline=False)
        embeds.author_field(embed, member)
        embed.add_field(name="Entro", value=helpers.ts(member.joined_at), inline=True)
        embed.add_field(name="Miembros", value=str(member.guild.member_count), inline=True)
        await helpers.send_log(self.bot, member.guild, "miembros", embed)

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member, after: discord.Member) -> None:
        guild = after.guild

        if before.nick != after.nick:
            embed = embeds.base("Apodo cambiado", color=config.COLOR_INFO)
            embeds.author_field(embed, after)
            embed.add_field(name="Antes", value=before.nick or "*ninguno*", inline=True)
            embed.add_field(name="Ahora", value=after.nick or "*ninguno*", inline=True)
            await helpers.send_log(self.bot, guild, "miembros", embed)

        if before.roles != after.roles:
            added = [r for r in after.roles if r not in before.roles]
            removed = [r for r in before.roles if r not in after.roles]
            embed = embeds.base("Roles modificados", color=config.COLOR_INFO)
            embeds.author_field(embed, after)
            if added:
                embed.add_field(name="Añadidos",
                                value=" ".join(r.mention for r in added), inline=False)
            if removed:
                embed.add_field(name="Quitados",
                                value=" ".join(r.mention for r in removed), inline=False)
            entry = await helpers.find_audit(
                guild, discord.AuditLogAction.member_role_update, after.id)
            if entry is not None and entry.user is not None:
                embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
            await helpers.send_log(self.bot, guild, "miembros", embed)

        if before.timed_out_until != after.timed_out_until and after.timed_out_until:
            embed = embeds.base(f"{config.E_MUTE} Miembro aislado", color=config.COLOR_WARN)
            embeds.author_field(embed, after)
            embed.add_field(name="Hasta", value=helpers.ts(after.timed_out_until, "F"), inline=False)
            entry = await helpers.find_audit(
                guild, discord.AuditLogAction.member_update, after.id)
            if entry is not None and entry.user is not None:
                embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
            await helpers.send_log(self.bot, guild, "moderacion", embed)

    @commands.Cog.listener()
    async def on_member_ban(self, guild: discord.Guild, user: discord.User) -> None:
        entry = await helpers.find_audit(guild, discord.AuditLogAction.ban, user.id)
        embed = embeds.base(f"{config.E_HAMMER} Usuario baneado", color=config.COLOR_ERROR)
        embeds.author_field(embed, user)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Moderador", value=helpers.fmt_user(entry.user), inline=False)
            embed.add_field(name="Motivo", value=entry.reason or "sin motivo", inline=False)
        await helpers.send_log(self.bot, guild, "moderacion", embed)

    @commands.Cog.listener()
    async def on_member_unban(self, guild: discord.Guild, user: discord.User) -> None:
        entry = await helpers.find_audit(guild, discord.AuditLogAction.unban, user.id)
        embed = embeds.base("Usuario desbaneado", color=config.COLOR_OK)
        embeds.author_field(embed, user)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Moderador", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, guild, "moderacion", embed)

    @commands.Cog.listener()
    async def on_user_update(self, before: discord.User, after: discord.User) -> None:
        changes = []
        if before.name != after.name:
            changes.append(("Nombre de usuario", f"`{before.name}` -> `{after.name}`"))
        if before.display_avatar.key != after.display_avatar.key:
            changes.append(("Avatar", "ha cambiado su foto de perfil"))
        if not changes:
            return
        for guild in self.bot.guilds:
            if guild.get_member(after.id) is None:
                continue
            embed = embeds.base("Perfil actualizado", color=config.COLOR_INFO)
            embeds.author_field(embed, after)
            for name, value in changes:
                embed.add_field(name=name, value=value, inline=False)
            embed.set_thumbnail(url=after.display_avatar.url)
            await helpers.send_log(self.bot, guild, "miembros", embed)

    # =====================================================================
    #  SERVIDOR
    # =====================================================================
    @commands.Cog.listener()
    async def on_guild_channel_create(self, channel: discord.abc.GuildChannel) -> None:
        entry = await helpers.find_audit(
            channel.guild, discord.AuditLogAction.channel_create, channel.id)
        embed = embeds.base("Canal creado", color=config.COLOR_OK)
        embed.add_field(name="Canal", value=f"{channel.mention} (`{channel.name}`)", inline=False)
        embed.add_field(name="Tipo", value=str(channel.type), inline=True)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, channel.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        entry = await helpers.find_audit(
            channel.guild, discord.AuditLogAction.channel_delete, channel.id)
        embed = embeds.base("Canal borrado", color=config.COLOR_ERROR)
        embed.add_field(name="Canal", value=f"`{channel.name}` (`{channel.id}`)", inline=False)
        embed.add_field(name="Tipo", value=str(channel.type), inline=True)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, channel.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_channel_update(self, before: discord.abc.GuildChannel,
                                      after: discord.abc.GuildChannel) -> None:
        changes = []
        if before.name != after.name:
            changes.append(("Nombre", f"`{before.name}` -> `{after.name}`"))
        if getattr(before, "topic", None) != getattr(after, "topic", None):
            changes.append(("Descripcion", helpers.truncate(getattr(after, "topic", ""), 300)))
        if getattr(before, "slowmode_delay", None) != getattr(after, "slowmode_delay", None):
            changes.append(("Modo lento", f"{getattr(after, 'slowmode_delay', 0)}s"))
        if before.overwrites != after.overwrites:
            changes.append(("Permisos", "se han modificado los permisos del canal"))
        if not changes:
            return
        entry = await helpers.find_audit(
            after.guild, discord.AuditLogAction.channel_update, after.id)
        embed = embeds.base("Canal modificado", color=config.COLOR_WARN)
        embed.add_field(name="Canal", value=after.mention, inline=False)
        for name, value in changes:
            embed.add_field(name=name, value=value, inline=False)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, after.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_role_create(self, role: discord.Role) -> None:
        entry = await helpers.find_audit(role.guild, discord.AuditLogAction.role_create, role.id)
        embed = embeds.base("Rol creado", color=config.COLOR_OK)
        embed.add_field(name="Rol", value=f"{role.mention} (`{role.name}`)", inline=False)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, role.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_role_delete(self, role: discord.Role) -> None:
        entry = await helpers.find_audit(role.guild, discord.AuditLogAction.role_delete, role.id)
        embed = embeds.base("Rol borrado", color=config.COLOR_ERROR)
        embed.add_field(name="Rol", value=f"`{role.name}` (`{role.id}`)", inline=False)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, role.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_role_update(self, before: discord.Role, after: discord.Role) -> None:
        changes = []
        if before.name != after.name:
            changes.append(("Nombre", f"`{before.name}` -> `{after.name}`"))
        if before.color != after.color:
            changes.append(("Color", f"{before.color} -> {after.color}"))
        if before.permissions != after.permissions:
            gained = helpers.has_dangerous_permissions(
                discord.Permissions(after.permissions.value & ~before.permissions.value))
            text = "se han modificado los permisos"
            if gained:
                text += f"\nPermisos delicados ganados: `{', '.join(gained)}`"
            changes.append(("Permisos", text))
        if not changes:
            return
        entry = await helpers.find_audit(after.guild, discord.AuditLogAction.role_update, after.id)
        embed = embeds.base("Rol modificado", color=config.COLOR_WARN)
        embed.add_field(name="Rol", value=after.mention, inline=False)
        for name, value in changes:
            embed.add_field(name=name, value=value, inline=False)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, after.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_emojis_update(self, guild: discord.Guild,
                                     before: list, after: list) -> None:
        added = [e for e in after if e not in before]
        removed = [e for e in before if e not in after]
        if not added and not removed:
            return
        embed = embeds.base("Emojis actualizados", color=config.COLOR_INFO)
        if added:
            embed.add_field(name="Añadidos",
                            value=" ".join(f"`{e.name}`" for e in added[:20]), inline=False)
        if removed:
            embed.add_field(name="Borrados",
                            value=" ".join(f"`{e.name}`" for e in removed[:20]), inline=False)
        await helpers.send_log(self.bot, guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_guild_stickers_update(self, guild: discord.Guild,
                                       before: list, after: list) -> None:
        if len(before) == len(after):
            return
        embed = embeds.base("Stickers actualizados", color=config.COLOR_INFO)
        embed.add_field(name="Cantidad", value=f"{len(before)} -> {len(after)}", inline=True)
        await helpers.send_log(self.bot, guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_webhooks_update(self, channel: discord.abc.GuildChannel) -> None:
        entry = await helpers.find_audit(channel.guild, discord.AuditLogAction.webhook_create)
        embed = embeds.base("Webhooks modificados", color=config.COLOR_WARN)
        embed.add_field(name="Canal", value=channel.mention, inline=True)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Ultimo cambio por",
                            value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, channel.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_invite_create(self, invite: discord.Invite) -> None:
        if invite.guild is None:
            return
        embed = embeds.base("Invitacion creada", color=config.COLOR_INFO)
        embed.add_field(name="Codigo", value=f"`{invite.code}`", inline=True)
        embed.add_field(name="Usos maximos", value=str(invite.max_uses or "ilimitados"), inline=True)
        embed.add_field(name="Creada por", value=helpers.fmt_user(invite.inviter), inline=False)
        await helpers.send_log(self.bot, invite.guild, "servidor", embed)
        await self._refresh_invites(invite.guild)

    @commands.Cog.listener()
    async def on_invite_delete(self, invite: discord.Invite) -> None:
        if invite.guild is None:
            return
        embed = embeds.base("Invitacion borrada", color=config.COLOR_MUTED)
        embed.add_field(name="Codigo", value=f"`{invite.code}`", inline=True)
        await helpers.send_log(self.bot, invite.guild, "servidor", embed)
        await self._refresh_invites(invite.guild)

    @commands.Cog.listener()
    async def on_guild_update(self, before: discord.Guild, after: discord.Guild) -> None:
        changes = []
        if before.name != after.name:
            changes.append(("Nombre", f"`{before.name}` -> `{after.name}`"))
        if before.icon != after.icon:
            changes.append(("Icono", "ha cambiado"))
        if before.owner_id != after.owner_id:
            changes.append(("Dueño", f"<@{before.owner_id}> -> <@{after.owner_id}>"))
        if before.verification_level != after.verification_level:
            changes.append(("Nivel de verificacion",
                            f"{before.verification_level} -> {after.verification_level}"))
        if not changes:
            return
        entry = await helpers.find_audit(after, discord.AuditLogAction.guild_update)
        embed = embeds.base("Servidor modificado", color=config.COLOR_WARN)
        for name, value in changes:
            embed.add_field(name=name, value=value, inline=False)
        if entry is not None and entry.user is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
        await helpers.send_log(self.bot, after, "servidor", embed)

    @commands.Cog.listener()
    async def on_thread_create(self, thread: discord.Thread) -> None:
        embed = embeds.base("Hilo creado", color=config.COLOR_OK)
        embed.add_field(name="Hilo", value=thread.mention, inline=True)
        embed.add_field(name="Canal", value=f"<#{thread.parent_id}>", inline=True)
        if thread.owner is not None:
            embed.add_field(name="Por", value=helpers.fmt_user(thread.owner), inline=False)
        await helpers.send_log(self.bot, thread.guild, "servidor", embed)

    @commands.Cog.listener()
    async def on_thread_delete(self, thread: discord.Thread) -> None:
        embed = embeds.base("Hilo borrado", color=config.COLOR_ERROR)
        embed.add_field(name="Hilo", value=f"`{thread.name}`", inline=True)
        embed.add_field(name="Canal", value=f"<#{thread.parent_id}>", inline=True)
        await helpers.send_log(self.bot, thread.guild, "servidor", embed)

    # =====================================================================
    #  VOZ
    # =====================================================================
    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member,
                                    before: discord.VoiceState,
                                    after: discord.VoiceState) -> None:
        if await helpers.is_ignored(self.bot, member.guild.id, after.channel or before.channel, member):
            return

        if before.channel is None and after.channel is not None:
            embed = embeds.base("Entra a voz", color=config.COLOR_OK)
            embed.add_field(name="Canal", value=after.channel.mention, inline=True)
        elif before.channel is not None and after.channel is None:
            embed = embeds.base("Sale de voz", color=config.COLOR_MUTED)
            embed.add_field(name="Canal", value=before.channel.mention, inline=True)
        elif before.channel != after.channel:
            embed = embeds.base("Cambia de canal de voz", color=config.COLOR_INFO)
            embed.add_field(name="De", value=before.channel.mention, inline=True)
            embed.add_field(name="A", value=after.channel.mention, inline=True)
        elif before.self_mute != after.self_mute or before.self_deaf != after.self_deaf:
            estado = []
            if after.self_mute:
                estado.append("microfono silenciado")
            if after.self_deaf:
                estado.append("auriculares silenciados")
            embed = embeds.base("Estado de voz", color=config.COLOR_MUTED)
            embed.add_field(name="Ahora", value=", ".join(estado) or "activo", inline=True)
        else:
            return

        embeds.author_field(embed, member)
        await helpers.send_log(self.bot, member.guild, "voz", embed)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Logs(bot))
