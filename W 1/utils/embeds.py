"""Fabricas de embeds para que todo el bot hable con el mismo estilo."""

from __future__ import annotations

import discord

import config


def base(title: str | None = None, description: str | None = None,
         color: int = config.COLOR_PRIMARY) -> discord.Embed:
    embed = discord.Embed(title=title, description=description, color=color)
    embed.timestamp = discord.utils.utcnow()
    return embed


def ok(description: str, title: str | None = None) -> discord.Embed:
    return base(title, f"{config.E_OK} {description}", config.COLOR_OK)


def error(description: str, title: str | None = None) -> discord.Embed:
    return base(title, f"{config.E_ERROR} {description}", config.COLOR_ERROR)


def warn(description: str, title: str | None = None) -> discord.Embed:
    return base(title, f"{config.E_WARN} {description}", config.COLOR_WARN)


def info(description: str, title: str | None = None) -> discord.Embed:
    return base(title, f"{config.E_INFO} {description}", config.COLOR_INFO)


def log(title: str, color: int, description: str | None = None) -> discord.Embed:
    return base(title, description, color)


def author_field(embed: discord.Embed, user: discord.abc.User) -> discord.Embed:
    """Pone al usuario en el 'author' del embed con su avatar."""
    embed.set_author(name=f"{user} ({user.id})", icon_url=user.display_avatar.url)
    return embed
