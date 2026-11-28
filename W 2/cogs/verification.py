"""Verificacion de miembros con captcha.

El usuario pulsa un boton, recibe una imagen con un codigo y lo escribe en un
formulario. Al acertar se le da el rol de verificado. Es suficiente para
frenar bots de raid, que no leen imagenes.
"""

from __future__ import annotations

import logging
import time

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, images
from utils.checks import admin_only

log = logging.getLogger("bot.verification")

CAPTCHA_TTL = 300      # segundos que vale un codigo
MAX_ATTEMPTS = 3


class VerifyView(discord.ui.View):
    """Vista persistente del panel de verificacion."""

    def __init__(self) -> None:
        super().__init__(timeout=None)

    @discord.ui.button(label="Verificarme", emoji=config.E_OK,
                       style=discord.ButtonStyle.success, custom_id="vf:start")
    async def start(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        cog: Verification = interaction.client.get_cog("Verificacion")
        await cog.begin(interaction)


class CaptchaModal(discord.ui.Modal, title="Escribe el codigo de la imagen"):
    codigo = discord.ui.TextInput(label="Codigo", placeholder="6 caracteres",
                                  min_length=4, max_length=8)

    def __init__(self, cog: "Verification"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await self.cog.check_code(interaction, str(self.codigo.value))


class CaptchaView(discord.ui.View):
    """Acompaña a la imagen del captcha; es efimera y de vida corta."""

    def __init__(self, cog: "Verification"):
        super().__init__(timeout=CAPTCHA_TTL)
        self.cog = cog

    @discord.ui.button(label="Escribir el codigo", style=discord.ButtonStyle.primary)
    async def write(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.send_modal(CaptchaModal(self.cog))


class Verification(commands.Cog, name="Verificacion"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # user_id -> (codigo, caduca_en, intentos)
        self._pending: dict[int, tuple[str, float, int]] = {}

    async def cog_load(self) -> None:
        self.bot.add_view(VerifyView())

    # =====================================================================
    async def begin(self, interaction: discord.Interaction) -> None:
        panel = await self.bot.db.fetchone(
            "SELECT * FROM verification_panels WHERE guild_id=?", (interaction.guild_id,))
        if panel is None or not panel["role_id"]:
            await interaction.response.send_message(
                embed=embeds.error("La verificacion no esta configurada en este servidor."),
                ephemeral=True)
            return

        role = interaction.guild.get_role(panel["role_id"])
        if role is None:
            await interaction.response.send_message(
                embed=embeds.error("El rol de verificado ya no existe. Avisa a un admin."),
                ephemeral=True)
            return
        if role in interaction.user.roles:
            await interaction.response.send_message(
                embed=embeds.info("Ya estas verificado."), ephemeral=True)
            return
        if role >= interaction.guild.me.top_role:
            await interaction.response.send_message(
                embed=embeds.error("No puedo dar ese rol: esta por encima del mio."),
                ephemeral=True)
            return

        if not panel["captcha"]:
            await self._grant(interaction, role)
            return

        code = images.new_captcha_code()
        buffer = images.captcha_image(code)
        if buffer is None:
            # Sin Pillow no hay imagen: se verifica directamente.
            await self._grant(interaction, role)
            return

        self._pending[interaction.user.id] = (code, time.time() + CAPTCHA_TTL, 0)
        embed = embeds.base("Verificacion", "Escribe el codigo que ves en la imagen. "
                            f"Caduca en {CAPTCHA_TTL // 60} minutos.", config.COLOR_PRIMARY)
        embed.set_image(url="attachment://captcha.png")
        await interaction.response.send_message(
            embed=embed, file=discord.File(buffer, filename="captcha.png"),
            view=CaptchaView(self), ephemeral=True)

    async def check_code(self, interaction: discord.Interaction, typed: str) -> None:
        entry = self._pending.get(interaction.user.id)
        if entry is None:
            await interaction.response.send_message(
                embed=embeds.error("No tienes ningun captcha pendiente. Pulsa "
                                   "*Verificarme* otra vez."), ephemeral=True)
            return

        code, expires, attempts = entry
        if time.time() > expires:
            self._pending.pop(interaction.user.id, None)
            await interaction.response.send_message(
                embed=embeds.error("El codigo ha caducado. Vuelve a intentarlo."),
                ephemeral=True)
            return

        if typed.strip().upper() != code:
            attempts += 1
            if attempts >= MAX_ATTEMPTS:
                self._pending.pop(interaction.user.id, None)
                await interaction.response.send_message(
                    embed=embeds.error("Demasiados fallos. Pulsa *Verificarme* para "
                                       "pedir otro codigo."), ephemeral=True)
                return
            self._pending[interaction.user.id] = (code, expires, attempts)
            await interaction.response.send_message(
                embed=embeds.error(f"Codigo incorrecto. Te quedan "
                                   f"{MAX_ATTEMPTS - attempts} intento(s)."), ephemeral=True)
            return

        self._pending.pop(interaction.user.id, None)
        panel = await self.bot.db.fetchone(
            "SELECT * FROM verification_panels WHERE guild_id=?", (interaction.guild_id,))
        role = interaction.guild.get_role(panel["role_id"]) if panel else None
        if role is None:
            await interaction.response.send_message(
                embed=embeds.error("El rol de verificado ya no existe."), ephemeral=True)
            return
        await self._grant(interaction, role)

    async def _grant(self, interaction: discord.Interaction, role: discord.Role) -> None:
        try:
            await interaction.user.add_roles(role, reason="Verificacion superada")
        except discord.HTTPException:
            await interaction.response.send_message(
                embed=embeds.error("No he podido darte el rol. Avisa a un administrador."),
                ephemeral=True)
            return

        await interaction.response.send_message(
            embed=embeds.ok(f"Verificado. Ya tienes acceso a {interaction.guild.name}."),
            ephemeral=True)

        embed = embeds.base("Miembro verificado", color=config.COLOR_OK)
        embeds.author_field(embed, interaction.user)
        await helpers.send_log(self.bot, interaction.guild, "miembros", embed)

    # =====================================================================
    #  COMANDOS
    # =====================================================================
    verificacion = app_commands.Group(
        name="verificacion", description="Verificacion de miembros.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @verificacion.command(name="configurar", description="Define el rol de verificado.")
    @app_commands.describe(rol="Rol que se dara al verificarse.",
                           captcha="Pedir un captcha de imagen (recomendado).")
    @admin_only()
    async def configurar(self, interaction: discord.Interaction, rol: discord.Role,
                         captcha: bool = True) -> None:
        if rol >= interaction.guild.me.top_role:
            await interaction.response.send_message(
                embed=embeds.error("Ese rol esta por encima del mio."), ephemeral=True)
            return
        await self.bot.db.execute(
            "INSERT INTO verification_panels (guild_id, role_id, captcha) VALUES (?,?,?) "
            "ON CONFLICT(guild_id) DO UPDATE SET role_id=excluded.role_id, "
            "captcha=excluded.captcha",
            (interaction.guild.id, rol.id, int(captcha)))
        await self.bot.db.set("guild_config", interaction.guild.id, verified_role=rol.id)
        await interaction.response.send_message(
            embed=embeds.ok(f"Rol de verificado: {rol.mention}. Captcha: "
                            f"**{'si' if captcha else 'no'}**.\n"
                            f"Publica el panel con `/verificacion panel`."),
            ephemeral=True)

    @verificacion.command(name="panel", description="Publica el boton de verificacion.")
    @app_commands.describe(canal="Canal donde publicarlo.", titulo="Titulo del embed.",
                           texto="Texto explicativo.")
    @admin_only()
    async def panel(self, interaction: discord.Interaction, canal: discord.TextChannel,
                    titulo: str | None = None, texto: str | None = None) -> None:
        row = await self.bot.db.fetchone(
            "SELECT * FROM verification_panels WHERE guild_id=?", (interaction.guild.id,))
        if row is None or not row["role_id"]:
            await interaction.response.send_message(
                embed=embeds.error("Primero usa `/verificacion configurar`."), ephemeral=True)
            return

        embed = embeds.base(
            titulo or "Verificacion",
            texto or ("Pulsa el boton para verificarte y acceder al resto del servidor.\n"
                      "Tendras que escribir el codigo de una imagen."),
            config.COLOR_PRIMARY)
        try:
            message = await canal.send(embed=embed, view=VerifyView())
        except discord.Forbidden:
            await interaction.response.send_message(
                embed=embeds.error(f"No puedo escribir en {canal.mention}."), ephemeral=True)
            return

        await self.bot.db.execute(
            "UPDATE verification_panels SET channel_id=?, message_id=? WHERE guild_id=?",
            (canal.id, message.id, interaction.guild.id))
        await interaction.response.send_message(
            embed=embeds.ok(f"Panel de verificacion publicado en {canal.mention}."),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Verification(bot))
