"""Comprobaciones reutilizables para los slash commands.

Se lanzan excepciones propias en vez de devolver False para que el manejador
global de errores pueda dar un mensaje concreto en vez de un generico
"no tienes permiso".
"""

from __future__ import annotations

import discord
from discord import app_commands

from . import helpers


class NotStaff(app_commands.CheckFailure):
    pass


class NotAdmin(app_commands.CheckFailure):
    pass


class NotInTicket(app_commands.CheckFailure):
    pass


def staff_only():
    async def predicate(interaction: discord.Interaction) -> bool:
        if interaction.guild is None:
            raise app_commands.NoPrivateMessage()
        if await helpers.is_staff(interaction.client, interaction.user):
            return True
        raise NotStaff()
    return app_commands.check(predicate)


def admin_only():
    async def predicate(interaction: discord.Interaction) -> bool:
        if interaction.guild is None:
            raise app_commands.NoPrivateMessage()
        if await helpers.is_admin(interaction.client, interaction.user):
            return True
        raise NotAdmin()
    return app_commands.check(predicate)
