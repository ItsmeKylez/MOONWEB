"""Bienvenidas, despedidas y rol automatico."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, images
from utils.checks import admin_only


def render(template: str, member: discord.Member) -> str:
    return (template
            .replace("{mention}", member.mention)
            .replace("{user}", str(member))
            .replace("{server}", member.guild.name)
            .replace("{count}", str(member.guild.member_count))
            .replace("{id}", str(member.id)))


class Welcome(commands.Cog, name="Bienvenidas"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # =====================================================================
    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        cfg = await self.bot.db.get("welcome_config", member.guild.id)

        if cfg["welcome_enabled"] and cfg["welcome_channel"]:
            channel = member.guild.get_channel(cfg["welcome_channel"])
            if channel is not None:
                await self._send(channel, member, cfg["welcome_message"],
                                 bool(cfg["welcome_image"]), goodbye=False)

        if cfg["dm_enabled"] and cfg["dm_message"]:
            await helpers.try_dm(
                member,
                embed=embeds.base(f"Bienvenido a {member.guild.name}",
                                  render(cfg["dm_message"], member), config.COLOR_OK))

        guild_cfg = await self.bot.db.get("guild_config", member.guild.id)
        role_id = guild_cfg.get("autorole")
        if role_id and not member.bot:
            role = member.guild.get_role(role_id)
            if role is not None and role < member.guild.me.top_role:
                try:
                    await member.add_roles(role, reason="Autorole")
                except discord.HTTPException:
                    pass

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member) -> None:
        cfg = await self.bot.db.get("welcome_config", member.guild.id)
        if not (cfg["goodbye_enabled"] and cfg["goodbye_channel"]):
            return
        channel = member.guild.get_channel(cfg["goodbye_channel"])
        if channel is not None:
            await self._send(channel, member, cfg["goodbye_message"],
                             bool(cfg["welcome_image"]), goodbye=True)

    async def _send(self, channel: discord.TextChannel, member: discord.Member,
                    template: str, with_image: bool, goodbye: bool) -> None:
        text = render(template or "{mention}", member)
        embed = embeds.base(
            "Hasta luego" if goodbye else f"Bienvenido a {member.guild.name}",
            text, config.COLOR_ERROR if goodbye else config.COLOR_OK)
        embed.set_thumbnail(url=member.display_avatar.url)

        file = None
        if with_image:
            try:
                avatar = await member.display_avatar.replace(size=256, format="png").read()
            except discord.HTTPException:
                avatar = None
            buffer = images.welcome_banner(avatar, member.display_name, member.guild.name,
                                           member.guild.member_count or 0, goodbye)
            if buffer is not None:
                file = discord.File(buffer, filename="banner.png")
                embed.set_image(url="attachment://banner.png")

        try:
            await channel.send(content=member.mention if not goodbye else None,
                               embed=embed, file=file,
                               allowed_mentions=discord.AllowedMentions(users=True))
        except discord.HTTPException:
            pass

    # =====================================================================
    #  COMANDOS
    # =====================================================================
    bienvenida = app_commands.Group(
        name="bienvenida", description="Mensaje de bienvenida.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @bienvenida.command(name="canal", description="Canal donde se anuncian las entradas.")
    @app_commands.describe(canal="Canal de bienvenida. Deja vacio para desactivarlo.")
    @admin_only()
    async def bienvenida_canal(self, interaction: discord.Interaction,
                               canal: discord.TextChannel | None = None) -> None:
        await self.bot.db.set("welcome_config", interaction.guild.id,
                              welcome_channel=canal.id if canal else None,
                              welcome_enabled=int(canal is not None))
        await interaction.response.send_message(
            embed=embeds.ok(f"Bienvenidas en {canal.mention}." if canal
                            else "Bienvenidas desactivadas."),
            ephemeral=True)

    @bienvenida.command(name="mensaje", description="Texto de la bienvenida.")
    @app_commands.describe(texto="Admite {mention} {user} {server} {count} {id}.")
    @admin_only()
    async def bienvenida_mensaje(self, interaction: discord.Interaction, texto: str) -> None:
        await self.bot.db.set("welcome_config", interaction.guild.id,
                              welcome_message=texto[:1500])
        ejemplo = render(texto, interaction.user)
        await interaction.response.send_message(
            embed=embeds.ok(f"Mensaje guardado. Asi se veria:\n\n{ejemplo}"), ephemeral=True)

    @bienvenida.command(name="imagen", description="Generar una tarjeta de bienvenida con imagen.")
    @app_commands.describe(activo="True para incluir la imagen.")
    @admin_only()
    async def bienvenida_imagen(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("welcome_config", interaction.guild.id,
                              welcome_image=int(activo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Imagen de bienvenida: **{'si' if activo else 'no'}**."),
            ephemeral=True)

    @bienvenida.command(name="privado", description="Mensaje privado al entrar.")
    @app_commands.describe(texto="Texto del DM. Deja vacio para desactivarlo.")
    @admin_only()
    async def bienvenida_dm(self, interaction: discord.Interaction,
                            texto: str | None = None) -> None:
        await self.bot.db.set("welcome_config", interaction.guild.id,
                              dm_message=texto, dm_enabled=int(bool(texto)))
        await interaction.response.send_message(
            embed=embeds.ok("Mensaje privado guardado." if texto
                            else "Mensaje privado desactivado."),
            ephemeral=True)

    @bienvenida.command(name="probar", description="Envia una bienvenida de prueba contigo.")
    @admin_only()
    async def bienvenida_probar(self, interaction: discord.Interaction) -> None:
        cfg = await self.bot.db.get("welcome_config", interaction.guild.id)
        if not cfg["welcome_channel"]:
            await interaction.response.send_message(
                embed=embeds.error("Primero configura el canal con `/bienvenida canal`."),
                ephemeral=True)
            return
        channel = interaction.guild.get_channel(cfg["welcome_channel"])
        await interaction.response.defer(ephemeral=True, thinking=True)
        await self._send(channel, interaction.user, cfg["welcome_message"],
                         bool(cfg["welcome_image"]), goodbye=False)
        await interaction.followup.send(embed=embeds.ok("Prueba enviada."), ephemeral=True)

    despedida = app_commands.Group(
        name="despedida", description="Mensaje de despedida.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @despedida.command(name="canal", description="Canal donde se anuncian las salidas.")
    @app_commands.describe(canal="Canal de despedidas. Deja vacio para desactivarlo.")
    @admin_only()
    async def despedida_canal(self, interaction: discord.Interaction,
                              canal: discord.TextChannel | None = None) -> None:
        await self.bot.db.set("welcome_config", interaction.guild.id,
                              goodbye_channel=canal.id if canal else None,
                              goodbye_enabled=int(canal is not None))
        await interaction.response.send_message(
            embed=embeds.ok(f"Despedidas en {canal.mention}." if canal
                            else "Despedidas desactivadas."),
            ephemeral=True)

    @despedida.command(name="mensaje", description="Texto de la despedida.")
    @app_commands.describe(texto="Admite {user} {server} {count}.")
    @admin_only()
    async def despedida_mensaje(self, interaction: discord.Interaction, texto: str) -> None:
        await self.bot.db.set("welcome_config", interaction.guild.id,
                              goodbye_message=texto[:1500])
        await interaction.response.send_message(
            embed=embeds.ok("Mensaje de despedida guardado."), ephemeral=True)

    @app_commands.command(name="autorole",
                          description="Rol que se da automaticamente a quien entra.")
    @app_commands.describe(rol="Rol a dar. Deja vacio para desactivarlo.")
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    @admin_only()
    async def autorole(self, interaction: discord.Interaction,
                       rol: discord.Role | None = None) -> None:
        if rol is not None and rol >= interaction.guild.me.top_role:
            await interaction.response.send_message(
                embed=embeds.error("Ese rol esta por encima del mio, no podria darlo."),
                ephemeral=True)
            return
        await self.bot.db.set("guild_config", interaction.guild.id,
                              autorole=rol.id if rol else None)
        await interaction.response.send_message(
            embed=embeds.ok(f"Autorole: {rol.mention}." if rol else "Autorole desactivado."),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Welcome(bot))
