"""Comandos de informacion y utilidades varias."""

from __future__ import annotations

import asyncio
import platform
import time

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers
from utils.checks import staff_only
from utils.time_parser import human_duration, parse_duration


class EmbedModal(discord.ui.Modal, title="Constructor de embeds"):
    titulo = discord.ui.TextInput(label="Titulo", required=False, max_length=250)
    descripcion = discord.ui.TextInput(label="Descripcion", style=discord.TextStyle.paragraph,
                                       required=False, max_length=3800)
    color = discord.ui.TextInput(label="Color hexadecimal", required=False,
                                 placeholder="#5865F2", max_length=9)
    imagen = discord.ui.TextInput(label="URL de la imagen", required=False)
    pie = discord.ui.TextInput(label="Pie de pagina", required=False, max_length=200)

    def __init__(self, channel: discord.TextChannel):
        super().__init__()
        self.channel = channel

    async def on_submit(self, interaction: discord.Interaction) -> None:
        if not self.titulo.value and not self.descripcion.value:
            await interaction.response.send_message(
                embed=embeds.error("Necesitas al menos un titulo o una descripcion."),
                ephemeral=True)
            return
        try:
            value = int(str(self.color.value).lstrip("#"), 16) if self.color.value \
                else config.COLOR_PRIMARY
        except ValueError:
            value = config.COLOR_PRIMARY

        embed = discord.Embed(title=self.titulo.value or None,
                              description=self.descripcion.value or None, color=value)
        if self.imagen.value:
            embed.set_image(url=self.imagen.value)
        if self.pie.value:
            embed.set_footer(text=self.pie.value)
        try:
            await self.channel.send(embed=embed)
        except discord.HTTPException as exc:
            await interaction.response.send_message(
                embed=embeds.error(f"No se ha podido enviar: `{exc}`"), ephemeral=True)
            return
        await interaction.response.send_message(
            embed=embeds.ok(f"Embed enviado a {self.channel.mention}."), ephemeral=True)


class Utility(commands.Cog, name="Utilidades"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._snipes: dict[int, tuple[str, int, float]] = {}

    @commands.Cog.listener()
    async def on_message_delete(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot or not message.content:
            return
        self._snipes[message.channel.id] = (message.content, message.author.id, time.time())

    # =====================================================================
    @app_commands.command(name="ping", description="Latencia del bot.")
    async def ping(self, interaction: discord.Interaction) -> None:
        start = time.perf_counter()
        await interaction.response.defer(thinking=True)
        elapsed = (time.perf_counter() - start) * 1000
        embed = embeds.base("Estado de la conexion", color=config.COLOR_INFO)
        embed.add_field(name="Gateway", value=f"{self.bot.latency * 1000:.0f} ms", inline=True)
        embed.add_field(name="Respuesta", value=f"{elapsed:.0f} ms", inline=True)
        await interaction.followup.send(embed=embed)

    @app_commands.command(name="uptime", description="Cuanto lleva el bot encendido.")
    async def uptime(self, interaction: discord.Interaction) -> None:
        embed = embeds.base("Informacion del bot", color=config.COLOR_INFO)
        embed.add_field(name="Encendido desde",
                        value=f"<t:{int(self.bot.start_time.timestamp())}:R>", inline=True)
        embed.add_field(name="Tiempo", value=human_duration(self.bot.uptime_seconds),
                        inline=True)
        embed.add_field(name="Servidores", value=str(len(self.bot.guilds)), inline=True)
        embed.add_field(name="Python", value=platform.python_version(), inline=True)
        embed.add_field(name="discord.py", value=discord.__version__, inline=True)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="userinfo", description="Informacion de un miembro.")
    @app_commands.describe(usuario="Miembro a consultar.")
    @app_commands.guild_only()
    async def userinfo(self, interaction: discord.Interaction,
                       usuario: discord.Member | None = None) -> None:
        member = usuario or interaction.user
        roles = [r.mention for r in reversed(member.roles) if not r.is_default()]
        warns = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM warns WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, member.id), 0)
        cases = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM cases WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, member.id), 0)

        embed = embeds.base(str(member), color=member.color.value or config.COLOR_PRIMARY)
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.add_field(name="ID", value=f"`{member.id}`", inline=True)
        embed.add_field(name="Bot", value="si" if member.bot else "no", inline=True)
        embed.add_field(name="Apodo", value=member.nick or "ninguno", inline=True)
        embed.add_field(name="Cuenta creada", value=helpers.ts(member.created_at, "F"),
                        inline=False)
        embed.add_field(name="Entro al servidor", value=helpers.ts(member.joined_at, "F"),
                        inline=False)
        embed.add_field(name="Rol mas alto", value=member.top_role.mention, inline=True)
        embed.add_field(name="Avisos", value=str(warns), inline=True)
        embed.add_field(name="Sanciones", value=str(cases), inline=True)
        if member.timed_out_until:
            embed.add_field(name="Aislado hasta",
                            value=helpers.ts(member.timed_out_until, "F"), inline=False)
        embed.add_field(name=f"Roles ({len(roles)})",
                        value=helpers.truncate(" ".join(roles), 900), inline=False)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="serverinfo", description="Informacion del servidor.")
    @app_commands.guild_only()
    async def serverinfo(self, interaction: discord.Interaction) -> None:
        guild = interaction.guild
        humans = sum(1 for m in guild.members if not m.bot)
        bots = guild.member_count - humans if guild.member_count else 0

        embed = embeds.base(guild.name, color=config.COLOR_PRIMARY)
        if guild.icon:
            embed.set_thumbnail(url=guild.icon.url)
        if guild.banner:
            embed.set_image(url=guild.banner.url)
        embed.add_field(name="ID", value=f"`{guild.id}`", inline=True)
        embed.add_field(name="Dueño", value=f"<@{guild.owner_id}>", inline=True)
        embed.add_field(name="Creado", value=helpers.ts(guild.created_at, "D"), inline=True)
        embed.add_field(name="Miembros",
                        value=f"{guild.member_count} ({humans} personas · {bots} bots)",
                        inline=False)
        embed.add_field(name="Canales",
                        value=f"{len(guild.text_channels)} de texto · "
                              f"{len(guild.voice_channels)} de voz · "
                              f"{len(guild.categories)} categorias", inline=False)
        embed.add_field(name="Roles", value=str(len(guild.roles)), inline=True)
        embed.add_field(name="Emojis", value=str(len(guild.emojis)), inline=True)
        embed.add_field(name="Nivel de mejoras",
                        value=f"{guild.premium_tier} ({guild.premium_subscription_count} boosts)",
                        inline=True)
        embed.add_field(name="Verificacion", value=str(guild.verification_level), inline=True)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="roleinfo", description="Informacion de un rol.")
    @app_commands.describe(rol="Rol a consultar.")
    @app_commands.guild_only()
    async def roleinfo(self, interaction: discord.Interaction, rol: discord.Role) -> None:
        peligrosos = helpers.has_dangerous_permissions(rol.permissions)
        embed = embeds.base(f"Rol {rol.name}", color=rol.color.value or config.COLOR_PRIMARY)
        embed.add_field(name="ID", value=f"`{rol.id}`", inline=True)
        embed.add_field(name="Miembros", value=str(len(rol.members)), inline=True)
        embed.add_field(name="Posicion", value=str(rol.position), inline=True)
        embed.add_field(name="Color", value=str(rol.color), inline=True)
        embed.add_field(name="Separado", value="si" if rol.hoist else "no", inline=True)
        embed.add_field(name="Mencionable", value="si" if rol.mentionable else "no", inline=True)
        embed.add_field(name="Creado", value=helpers.ts(rol.created_at, "D"), inline=False)
        embed.add_field(name="Permisos delicados",
                        value=", ".join(f"`{p}`" for p in peligrosos) or "ninguno",
                        inline=False)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="avatar", description="Muestra el avatar de alguien en grande.")
    @app_commands.describe(usuario="Usuario a consultar.")
    async def avatar(self, interaction: discord.Interaction,
                     usuario: discord.User | None = None) -> None:
        user = usuario or interaction.user
        embed = embeds.base(f"Avatar de {user}", color=config.COLOR_PRIMARY)
        embed.set_image(url=user.display_avatar.replace(size=1024).url)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="snipe", description="Recupera el ultimo mensaje borrado del canal.")
    @app_commands.guild_only()
    @staff_only()
    async def snipe(self, interaction: discord.Interaction) -> None:
        entry = self._snipes.get(interaction.channel_id)
        if entry is None:
            await interaction.response.send_message(
                embed=embeds.info("No hay ningun mensaje borrado reciente aqui."),
                ephemeral=True)
            return
        content, author_id, when = entry
        embed = embeds.base("Ultimo mensaje borrado",
                            helpers.truncate(content, 3000), config.COLOR_MUTED)
        embed.add_field(name="Autor", value=f"<@{author_id}>", inline=True)
        embed.add_field(name="Cuando", value=f"<t:{int(when)}:R>", inline=True)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="embed", description="Crea un embed personalizado.")
    @app_commands.describe(canal="Canal donde enviarlo. Vacio = el canal actual.")
    @app_commands.guild_only()
    @staff_only()
    async def embed_command(self, interaction: discord.Interaction,
                            canal: discord.TextChannel | None = None) -> None:
        await interaction.response.send_modal(EmbedModal(canal or interaction.channel))

    @app_commands.command(name="say", description="Hace que el bot diga algo.")
    @app_commands.describe(texto="Lo que debe decir.", canal="Canal de destino.")
    @app_commands.guild_only()
    @staff_only()
    async def say(self, interaction: discord.Interaction, texto: str,
                  canal: discord.TextChannel | None = None) -> None:
        target = canal or interaction.channel
        await target.send(texto[:2000],
                          allowed_mentions=discord.AllowedMentions(users=True))
        await interaction.response.send_message(
            embed=embeds.ok(f"Mensaje enviado a {target.mention}."), ephemeral=True)

    @app_commands.command(name="recordatorio", description="Te aviso por privado dentro de un rato.")
    @app_commands.describe(cuando="Ej: 10m, 2h, 1d.", texto="Que quieres recordar.")
    async def recordatorio(self, interaction: discord.Interaction, cuando: str,
                           texto: str) -> None:
        seconds = parse_duration(cuando)
        if not seconds or seconds > 7 * 86400:
            await interaction.response.send_message(
                embed=embeds.error("Usa una duracion entre 1 minuto y 7 dias, por ejemplo `2h`."),
                ephemeral=True)
            return
        await interaction.response.send_message(
            embed=embeds.ok(f"Te avisare en **{human_duration(seconds)}**."), ephemeral=True)

        async def remind() -> None:
            await asyncio.sleep(seconds)
            await helpers.try_dm(
                interaction.user,
                embed=embeds.base("Recordatorio", texto[:2000], config.COLOR_INFO))

        self.bot.loop.create_task(remind())

    @app_commands.command(name="ayuda", description="Lista de todo lo que sabe hacer el bot.")
    async def ayuda(self, interaction: discord.Interaction) -> None:
        embed = embeds.base(
            "Guia rapida",
            "Escribe `/` en el chat para ver todos los comandos con su descripcion.",
            config.COLOR_PRIMARY)
        embed.add_field(
            name="Tickets",
            value="`/panel` crear y publicar paneles · `/ticket` gestionar tickets",
            inline=False)
        embed.add_field(
            name="Moderacion",
            value="`/ban` `/kick` `/timeout` `/warn` `/warns` `/purge` `/lock` `/lockdown` "
                  "`/caso` `/historial` `/rol`",
            inline=False)
        embed.add_field(
            name="Seguridad",
            value="`/antinuke` `/antiraid` `/antispam` `/palabra` `/verificacion`",
            inline=False)
        embed.add_field(
            name="Servidor",
            value="`/config` `/logs` `/ignorar` `/backup` `/bienvenida` `/despedida` "
                  "`/autorole` `/rolemenu`",
            inline=False)
        embed.add_field(
            name="Comunidad",
            value="`/nivel` `/ranking` `/niveles` `/userinfo` `/serverinfo` `/avatar` "
                  "`/recordatorio`",
            inline=False)
        embed.set_footer(text="Los comandos de administracion solo los ve quien tiene permiso.")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Utility(bot))
