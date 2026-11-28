"""Manejo global de errores.

Cualquier excepcion no controlada dentro de un comando termina aqui: el
usuario recibe un mensaje comprensible y la traza completa va al archivo de
log. El bot nunca se cae por un comando fallido.
"""

from __future__ import annotations

import logging
import traceback

import discord
from discord import app_commands
from discord.ext import commands

from utils import checks, embeds
from utils.time_parser import human_duration

log = logging.getLogger("bot.errors")


class ErrorHandler(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._previous = bot.tree.on_error
        bot.tree.on_error = self.on_app_command_error

    async def cog_unload(self) -> None:
        self.bot.tree.on_error = self._previous

    async def on_app_command_error(self, interaction: discord.Interaction,
                                   error: app_commands.AppCommandError) -> None:
        error = getattr(error, "original", error)

        if isinstance(error, checks.NotStaff):
            message = ("Este comando es solo para el staff. Pide a un administrador "
                       "que te asigne el rol configurado con `/config staff`.")
        elif isinstance(error, checks.NotAdmin):
            message = "Este comando es solo para administradores del servidor."
        elif isinstance(error, app_commands.NoPrivateMessage):
            message = "Este comando solo funciona dentro de un servidor."
        elif isinstance(error, app_commands.CommandOnCooldown):
            message = f"Espera {human_duration(int(error.retry_after) + 1)} antes de repetirlo."
        elif isinstance(error, app_commands.MissingPermissions):
            perms = ", ".join(error.missing_permissions)
            message = f"Te faltan permisos: `{perms}`."
        elif isinstance(error, app_commands.BotMissingPermissions):
            perms = ", ".join(error.missing_permissions)
            message = f"Me faltan permisos: `{perms}`."
        elif isinstance(error, discord.Forbidden):
            message = ("Discord me ha denegado esa accion. Revisa mis permisos y que "
                       "mi rol este por encima del rol del usuario afectado.")
        elif isinstance(error, discord.NotFound):
            message = "Ese objeto ya no existe (mensaje, canal o usuario borrado)."
        elif isinstance(error, app_commands.CheckFailure):
            message = "No cumples los requisitos para usar este comando."
        else:
            message = ("Ha ocurrido un error inesperado. Ya ha quedado registrado "
                       "en el log del bot.")
            command = interaction.command.qualified_name if interaction.command else "?"
            log.error(
                "Error en /%s (servidor %s)\n%s",
                command,
                interaction.guild_id,
                "".join(traceback.format_exception(type(error), error, error.__traceback__)),
            )

        embed = embeds.error(message)
        try:
            if interaction.response.is_done():
                await interaction.followup.send(embed=embed, ephemeral=True)
            else:
                await interaction.response.send_message(embed=embed, ephemeral=True)
        except discord.HTTPException:
            pass

    @commands.Cog.listener()
    async def on_command_error(self, ctx: commands.Context, error: Exception) -> None:
        if isinstance(error, (commands.CommandNotFound, commands.CheckFailure)):
            return
        if isinstance(error, commands.MissingRequiredArgument):
            await ctx.reply(f"Falta el argumento `{error.param.name}`.")
            return
        log.error(
            "Error en el comando de texto %s\n%s",
            ctx.command,
            "".join(traceback.format_exception(type(error), error, error.__traceback__)),
        )


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(ErrorHandler(bot))
