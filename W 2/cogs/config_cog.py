"""Configuracion del servidor: asistente inicial, roles, logs e ignorados."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers
from utils.checks import admin_only

LOG_CHOICES = [app_commands.Choice(name=key, value=key) for key in config.LOG_CATEGORIES]


class Configuration(commands.Cog, name="Configuracion"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # =====================================================================
    #  ASISTENTE
    # =====================================================================
    @app_commands.command(
        name="setup",
        description="Asistente inicial: crea los canales de log y activa las protecciones.")
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    @admin_only()
    async def setup_command(self, interaction: discord.Interaction) -> None:
        guild = interaction.guild
        if not guild.me.guild_permissions.manage_channels:
            await interaction.response.send_message(
                embed=embeds.error("Necesito el permiso *Gestionar canales* para el asistente."),
                ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        pasos: list[str] = []

        # 1. Categoria privada con un canal por tipo de log.
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True,
                                                  embed_links=True, attach_files=True),
        }
        category = discord.utils.get(guild.categories, name="REGISTROS")
        if category is None:
            category = await guild.create_category("REGISTROS", overwrites=overwrites,
                                                   reason="Asistente de configuracion")
            pasos.append("Categoria **REGISTROS** creada.")

        creados = 0
        for key in config.LOG_CATEGORIES:
            existing = await self.bot.db.get_log_channels(guild.id)
            if key in existing and guild.get_channel(existing[key]) is not None:
                continue
            channel = discord.utils.get(category.text_channels, name=f"log-{key}")
            if channel is None:
                channel = await guild.create_text_channel(
                    f"log-{key}", category=category, reason="Asistente de configuracion")
                creados += 1
            await self.bot.db.set_log_channel(guild.id, key, channel.id)
        if creados:
            pasos.append(f"**{creados}** canal(es) de log creados y configurados.")

        # 2. Protecciones activadas con valores por defecto sensatos.
        await self.bot.db.set("antinuke_config", guild.id, enabled=1)
        await self.bot.db.set("antiraid_config", guild.id, enabled=1)
        await self.bot.db.set("antispam_config", guild.id, enabled=1)
        pasos.append("Anti-nuke, anti-raid y anti-spam **activados**.")

        # 3. Quien ejecuta el asistente entra en la lista blanca.
        await self.bot.db.add_whitelist(guild.id, interaction.user.id, interaction.user.id)
        pasos.append(f"{interaction.user.mention} añadido a la lista blanca del anti-nuke.")

        embed = embeds.base(f"{config.E_OK} Configuracion inicial lista",
                            "\n".join(f"· {p}" for p in pasos), config.COLOR_OK)
        embed.add_field(
            name="Siguientes pasos",
            value=("1. `/config staff` para indicar el rol del staff.\n"
                   "2. `/antinuke permitir` con cada administrador de confianza.\n"
                   "3. `/panel crear` y `/panel categoria` para el sistema de tickets.\n"
                   "4. `/bienvenida canal` y `/verificacion configurar` si los quieres.\n"
                   "5. `/backup crear` para guardar la estructura del servidor."),
            inline=False)
        embed.set_footer(text="Revisa la configuracion completa con /config ver")
        await interaction.followup.send(embed=embed, ephemeral=True)

    # =====================================================================
    #  CONFIG
    # =====================================================================
    cfg_group = app_commands.Group(
        name="config", description="Ajustes generales del servidor.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @cfg_group.command(name="ver", description="Resumen de toda la configuracion.")
    @admin_only()
    async def ver(self, interaction: discord.Interaction) -> None:
        guild = interaction.guild
        general = await self.bot.db.get("guild_config", guild.id)
        nuke = await self.bot.db.get("antinuke_config", guild.id)
        raid = await self.bot.db.get("antiraid_config", guild.id)
        spam = await self.bot.db.get("antispam_config", guild.id)
        tickets = await self.bot.db.get("ticket_config", guild.id)
        welcome = await self.bot.db.get("welcome_config", guild.id)
        levels = await self.bot.db.get("level_config", guild.id)
        logs = await self.bot.db.get_log_channels(guild.id)
        whitelist = await self.bot.db.get_whitelist(guild.id)

        def role(value):
            return f"<@&{value}>" if value else "sin configurar"

        def flag(value):
            return "activado" if value else "desactivado"

        embed = embeds.base(f"Configuracion de {guild.name}", color=config.COLOR_PRIMARY)
        embed.add_field(
            name="Roles",
            value=(f"Staff: {role(general['staff_role'])}\n"
                   f"Admin: {role(general['admin_role'])}\n"
                   f"Cuarentena: {role(general['quarantine_role'])}\n"
                   f"Verificado: {role(general['verified_role'])}\n"
                   f"Autorole: {role(general['autorole'])}"),
            inline=False)
        embed.add_field(
            name="Seguridad",
            value=(f"Anti-nuke: {flag(nuke['enabled'])} (castigo: {nuke['punishment']})\n"
                   f"Anti-raid: {flag(raid['enabled'])}\n"
                   f"Anti-spam: {flag(spam['enabled'])}\n"
                   f"Lista blanca: {len(whitelist)} usuario(s)"),
            inline=False)
        embed.add_field(
            name="Canales de log",
            value=("\n".join(f"`{key}`: <#{value}>" for key, value in logs.items())
                   or "ninguno configurado"),
            inline=False)
        embed.add_field(
            name="Tickets",
            value=(f"Maximo por usuario: {tickets['max_open']}\n"
                   f"Transcript por DM: {flag(tickets['transcript_dm'])}\n"
                   f"Auto-cierre: "
                   f"{str(tickets['autoclose_hours']) + 'h' if tickets['autoclose_hours'] else 'no'}"),
            inline=False)
        embed.add_field(
            name="Comunidad",
            value=(f"Bienvenidas: {flag(welcome['welcome_enabled'])}\n"
                   f"Despedidas: {flag(welcome['goodbye_enabled'])}\n"
                   f"Niveles: {flag(levels['enabled'])}"),
            inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @cfg_group.command(name="staff", description="Rol que puede usar los comandos de moderacion.")
    @app_commands.describe(rol="Rol del staff. Vacio para quitarlo.")
    @admin_only()
    async def staff(self, interaction: discord.Interaction,
                    rol: discord.Role | None = None) -> None:
        await self.bot.db.set("guild_config", interaction.guild.id,
                              staff_role=rol.id if rol else None)
        await interaction.response.send_message(
            embed=embeds.ok(f"Rol de staff: {rol.mention}." if rol
                            else "Rol de staff eliminado."),
            ephemeral=True)

    @cfg_group.command(name="admin", description="Rol con acceso a la configuracion del bot.")
    @app_commands.describe(rol="Rol de administracion. Vacio para quitarlo.")
    @admin_only()
    async def admin(self, interaction: discord.Interaction,
                    rol: discord.Role | None = None) -> None:
        await self.bot.db.set("guild_config", interaction.guild.id,
                              admin_role=rol.id if rol else None)
        await interaction.response.send_message(
            embed=embeds.ok(f"Rol de administracion: {rol.mention}." if rol
                            else "Rol de administracion eliminado."),
            ephemeral=True)

    @cfg_group.command(name="cuarentena", description="Rol que se pone a las cuentas sospechosas.")
    @app_commands.describe(rol="Rol de cuarentena. Vacio para usar el aislamiento de Discord.")
    @admin_only()
    async def cuarentena(self, interaction: discord.Interaction,
                         rol: discord.Role | None = None) -> None:
        await self.bot.db.set("guild_config", interaction.guild.id,
                              quarantine_role=rol.id if rol else None)
        await interaction.response.send_message(
            embed=embeds.ok(f"Rol de cuarentena: {rol.mention}." if rol
                            else "Se usara el aislamiento de Discord."),
            ephemeral=True)

    @cfg_group.command(name="avisos", description="Avisar por privado a quien reciba una sancion.")
    @app_commands.describe(activo="True para enviar el DM.")
    @admin_only()
    async def avisos(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("guild_config", interaction.guild.id,
                              dm_on_punish=int(activo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Aviso por privado: **{'si' if activo else 'no'}**."),
            ephemeral=True)

    # =====================================================================
    #  LOGS
    # =====================================================================
    logs_group = app_commands.Group(
        name="logs", description="Canales de registro.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @logs_group.command(name="canal", description="Asigna el canal de una categoria de log.")
    @app_commands.describe(categoria="Tipo de eventos.", canal="Canal destino. Vacio = quitar.")
    @app_commands.choices(categoria=LOG_CHOICES)
    @admin_only()
    async def logs_canal(self, interaction: discord.Interaction,
                         categoria: app_commands.Choice[str],
                         canal: discord.TextChannel | None = None) -> None:
        await self.bot.db.set_log_channel(interaction.guild.id, categoria.value,
                                          canal.id if canal else None)
        await interaction.response.send_message(
            embed=embeds.ok(f"Logs de **{categoria.value}** en {canal.mention}." if canal
                            else f"Logs de **{categoria.value}** desactivados."),
            ephemeral=True)

    @logs_group.command(name="ver", description="Muestra que canal usa cada tipo de log.")
    @admin_only()
    async def logs_ver(self, interaction: discord.Interaction) -> None:
        logs = await self.bot.db.get_log_channels(interaction.guild.id)
        lineas = []
        for key, descripcion in config.LOG_CATEGORIES.items():
            destino = f"<#{logs[key]}>" if key in logs else "sin configurar"
            lineas.append(f"**{key}** — {destino}\n{descripcion}")
        await interaction.response.send_message(
            embed=embeds.base("Canales de log", "\n\n".join(lineas), config.COLOR_INFO),
            ephemeral=True)

    # =====================================================================
    #  IGNORADOS
    # =====================================================================
    ignorar = app_commands.Group(
        name="ignorar", description="Canales, roles y usuarios que el bot no analiza.",
        guild_only=True, default_permissions=discord.Permissions(administrator=True))

    @ignorar.command(name="agregar", description="Ignora un canal, un rol o un usuario.")
    @app_commands.describe(canal="Canal o categoria a ignorar.", rol="Rol a ignorar.",
                           usuario="Usuario a ignorar.")
    @admin_only()
    async def ignorar_add(self, interaction: discord.Interaction,
                          canal: discord.abc.GuildChannel | None = None,
                          rol: discord.Role | None = None,
                          usuario: discord.User | None = None) -> None:
        added = []
        if canal is not None:
            await self.bot.db.add_ignored(interaction.guild.id, "channel", canal.id)
            added.append(canal.mention)
        if rol is not None:
            await self.bot.db.add_ignored(interaction.guild.id, "role", rol.id)
            added.append(rol.mention)
        if usuario is not None:
            await self.bot.db.add_ignored(interaction.guild.id, "user", usuario.id)
            added.append(usuario.mention)
        if not added:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos un canal, rol o usuario."), ephemeral=True)
            return
        await interaction.response.send_message(
            embed=embeds.ok("Ignorado: " + " ".join(added)), ephemeral=True)

    @ignorar.command(name="quitar", description="Deja de ignorar un canal, rol o usuario.")
    @app_commands.describe(canal="Canal.", rol="Rol.", usuario="Usuario.")
    @admin_only()
    async def ignorar_del(self, interaction: discord.Interaction,
                          canal: discord.abc.GuildChannel | None = None,
                          rol: discord.Role | None = None,
                          usuario: discord.User | None = None) -> None:
        removed = []
        if canal is not None:
            await self.bot.db.remove_ignored(interaction.guild.id, "channel", canal.id)
            removed.append(canal.mention)
        if rol is not None:
            await self.bot.db.remove_ignored(interaction.guild.id, "role", rol.id)
            removed.append(rol.mention)
        if usuario is not None:
            await self.bot.db.remove_ignored(interaction.guild.id, "user", usuario.id)
            removed.append(usuario.mention)
        if not removed:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos un canal, rol o usuario."), ephemeral=True)
            return
        await interaction.response.send_message(
            embed=embeds.ok("Ya no se ignora: " + " ".join(removed)), ephemeral=True)

    @ignorar.command(name="lista", description="Muestra todo lo que el bot ignora.")
    @admin_only()
    async def ignorar_lista(self, interaction: discord.Interaction) -> None:
        data = await self.bot.db.get_ignored(interaction.guild.id)
        embed = embeds.base("Elementos ignorados", color=config.COLOR_INFO)
        embed.add_field(name="Canales",
                        value=helpers.truncate(" ".join(f"<#{i}>" for i in data["channel"]), 900),
                        inline=False)
        embed.add_field(name="Roles",
                        value=helpers.truncate(" ".join(f"<@&{i}>" for i in data["role"]), 900),
                        inline=False)
        embed.add_field(name="Usuarios",
                        value=helpers.truncate(" ".join(f"<@{i}>" for i in data["user"]), 900),
                        inline=False)
        embed.set_footer(text="Los ignorados no se registran en los logs ni los analiza "
                              "el anti-spam.")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Configuration(bot))
