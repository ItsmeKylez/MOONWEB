"""Copias de seguridad de la estructura del servidor.

Se guarda la lista de roles, categorias y canales con sus permisos en un JSON
dentro de la base de datos. La restauracion recrea lo que falte; nunca borra
nada de lo que ya existe.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers
from utils.checks import admin_only

log = logging.getLogger("bot.backups")


def _dump_overwrites(channel: discord.abc.GuildChannel) -> list[dict]:
    data = []
    for target, overwrite in channel.overwrites.items():
        allow, deny = overwrite.pair()
        data.append({
            "type": "role" if isinstance(target, discord.Role) else "member",
            "name": target.name,
            "id": target.id,
            "allow": allow.value,
            "deny": deny.value,
        })
    return data


class Backups(commands.Cog, name="Backups"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    backup = app_commands.Group(
        name="backup", description="Copias de seguridad del servidor.",
        guild_only=True, default_permissions=discord.Permissions(administrator=True))

    # =====================================================================
    @backup.command(name="crear", description="Guarda la estructura actual del servidor.")
    @app_commands.describe(nombre="Nombre para reconocerla despues.")
    @admin_only()
    async def crear(self, interaction: discord.Interaction,
                    nombre: str | None = None) -> None:
        guild = interaction.guild
        await interaction.response.defer(ephemeral=True, thinking=True)

        data = {
            "guild_name": guild.name,
            "roles": [
                {
                    "name": role.name,
                    "permissions": role.permissions.value,
                    "color": role.color.value,
                    "hoist": role.hoist,
                    "mentionable": role.mentionable,
                    "position": role.position,
                }
                for role in sorted(guild.roles, key=lambda r: r.position, reverse=True)
                if not role.is_default() and not role.managed
            ],
            "categories": [
                {
                    "name": category.name,
                    "position": category.position,
                    "overwrites": _dump_overwrites(category),
                }
                for category in sorted(guild.categories, key=lambda c: c.position)
            ],
            "channels": [
                {
                    "name": channel.name,
                    "type": "text" if isinstance(channel, discord.TextChannel) else "voice",
                    "category": channel.category.name if channel.category else None,
                    "position": channel.position,
                    "topic": getattr(channel, "topic", None),
                    "nsfw": getattr(channel, "nsfw", False),
                    "slowmode": getattr(channel, "slowmode_delay", 0),
                    "overwrites": _dump_overwrites(channel),
                }
                for channel in sorted(guild.channels, key=lambda c: c.position)
                if isinstance(channel, (discord.TextChannel, discord.VoiceChannel))
            ],
        }

        backup_id = await self.bot.db.execute(
            "INSERT INTO backups (guild_id, name, data, created_at, created_by) "
            "VALUES (?,?,?,?,?)",
            (guild.id, nombre or f"backup-{int(time.time())}",
             json.dumps(data, ensure_ascii=False), int(time.time()), interaction.user.id))

        embed = embeds.ok(
            f"Copia guardada con la ID `{backup_id}`.\n"
            f"Roles: **{len(data['roles'])}** · Categorias: **{len(data['categories'])}** · "
            f"Canales: **{len(data['channels'])}**")
        await interaction.followup.send(embed=embed, ephemeral=True)

    @backup.command(name="lista", description="Lista las copias guardadas.")
    @admin_only()
    async def lista(self, interaction: discord.Interaction) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT id, name, created_at, created_by FROM backups WHERE guild_id=? "
            "ORDER BY id DESC LIMIT 25", (interaction.guild.id,))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("No hay ninguna copia. Crea una con `/backup crear`."),
                ephemeral=True)
            return
        texto = "\n".join(
            f"`{r['id']}` · **{r['name']}** · <t:{r['created_at']}:d> · <@{r['created_by']}>"
            for r in rows)
        await interaction.response.send_message(
            embed=embeds.base("Copias de seguridad", texto, config.COLOR_INFO), ephemeral=True)

    @backup.command(name="info", description="Detalles de una copia.")
    @app_commands.describe(backup_id="ID de la copia.")
    @admin_only()
    async def info(self, interaction: discord.Interaction, backup_id: int) -> None:
        row = await self._get(interaction.guild.id, backup_id)
        if row is None:
            await interaction.response.send_message(
                embed=embeds.error("Esa copia no existe."), ephemeral=True)
            return
        data = json.loads(row["data"])
        embed = embeds.base(f"Copia #{row['id']} · {row['name']}", color=config.COLOR_INFO)
        embed.add_field(name="Creada", value=f"<t:{row['created_at']}:F>", inline=False)
        embed.add_field(name="Roles", value=str(len(data["roles"])), inline=True)
        embed.add_field(name="Categorias", value=str(len(data["categories"])), inline=True)
        embed.add_field(name="Canales", value=str(len(data["channels"])), inline=True)
        embed.add_field(
            name="Roles guardados",
            value=helpers.truncate(", ".join(r["name"] for r in data["roles"]), 900),
            inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @backup.command(name="borrar", description="Borra una copia guardada.")
    @app_commands.describe(backup_id="ID de la copia.")
    @admin_only()
    async def borrar(self, interaction: discord.Interaction, backup_id: int) -> None:
        row = await self._get(interaction.guild.id, backup_id)
        if row is None:
            await interaction.response.send_message(
                embed=embeds.error("Esa copia no existe."), ephemeral=True)
            return
        await self.bot.db.execute("DELETE FROM backups WHERE id=?", (backup_id,))
        await interaction.response.send_message(
            embed=embeds.ok(f"Copia #{backup_id} borrada."), ephemeral=True)

    @backup.command(name="restaurar", description="Recrea los roles y canales que falten.")
    @app_commands.describe(backup_id="ID de la copia.",
                           roles="Restaurar los roles que falten.",
                           canales="Restaurar las categorias y canales que falten.")
    @admin_only()
    async def restaurar(self, interaction: discord.Interaction, backup_id: int,
                        roles: bool = True, canales: bool = True) -> None:
        if interaction.user.id != interaction.guild.owner_id:
            await interaction.response.send_message(
                embed=embeds.error("Solo el dueño del servidor puede restaurar una copia."),
                ephemeral=True)
            return
        row = await self._get(interaction.guild.id, backup_id)
        if row is None:
            await interaction.response.send_message(
                embed=embeds.error("Esa copia no existe."), ephemeral=True)
            return

        data = json.loads(row["data"])
        view = _Confirm(interaction.user.id)
        await interaction.response.send_message(
            embed=embeds.warn(
                f"Se van a recrear los elementos que falten de la copia **{row['name']}**.\n"
                f"No se borrara nada de lo que ya existe. Puede tardar varios minutos "
                f"por los limites de Discord.\n\n"
                f"Roles: {len(data['roles'])} · Canales: {len(data['channels'])}"),
            view=view, ephemeral=True)
        await view.wait()
        if not view.value:
            return

        report = await self._restore(interaction.guild, data, roles, canales)
        await interaction.followup.send(
            embed=embeds.ok("Restauracion terminada.\n" + report), ephemeral=True)

    async def _restore(self, guild: discord.Guild, data: dict,
                       do_roles: bool, do_channels: bool) -> str:
        created_roles = created_categories = created_channels = failed = 0
        role_map = {role.name: role for role in guild.roles}

        if do_roles:
            for entry in reversed(data["roles"]):
                if entry["name"] in role_map:
                    continue
                try:
                    role = await guild.create_role(
                        name=entry["name"],
                        permissions=discord.Permissions(entry["permissions"]),
                        colour=discord.Colour(entry["color"]),
                        hoist=entry["hoist"], mentionable=entry["mentionable"],
                        reason="Restauracion de copia de seguridad")
                    role_map[role.name] = role
                    created_roles += 1
                    await asyncio.sleep(0.6)
                except discord.HTTPException:
                    failed += 1

        if not do_channels:
            return (f"Roles creados: **{created_roles}** · Fallos: **{failed}**")

        category_map = {c.name: c for c in guild.categories}
        for entry in data["categories"]:
            if entry["name"] in category_map:
                continue
            try:
                category = await guild.create_category(
                    entry["name"],
                    overwrites=self._build_overwrites(guild, entry["overwrites"], role_map),
                    reason="Restauracion de copia de seguridad")
                category_map[category.name] = category
                created_categories += 1
                await asyncio.sleep(0.6)
            except discord.HTTPException:
                failed += 1

        existing = {(c.name, c.category.name if c.category else None) for c in guild.channels}
        for entry in data["channels"]:
            if (entry["name"], entry["category"]) in existing:
                continue
            parent = category_map.get(entry["category"]) if entry["category"] else None
            overwrites = self._build_overwrites(guild, entry["overwrites"], role_map)
            try:
                if entry["type"] == "text":
                    await guild.create_text_channel(
                        entry["name"], category=parent, overwrites=overwrites,
                        topic=entry["topic"], nsfw=entry["nsfw"],
                        slowmode_delay=entry["slowmode"] or 0,
                        reason="Restauracion de copia de seguridad")
                else:
                    await guild.create_voice_channel(
                        entry["name"], category=parent, overwrites=overwrites,
                        reason="Restauracion de copia de seguridad")
                created_channels += 1
                await asyncio.sleep(0.6)
            except discord.HTTPException:
                failed += 1

        return (f"Roles creados: **{created_roles}**\n"
                f"Categorias creadas: **{created_categories}**\n"
                f"Canales creados: **{created_channels}**\n"
                f"Fallos: **{failed}**")

    @staticmethod
    def _build_overwrites(guild: discord.Guild, entries: list[dict],
                          role_map: dict[str, discord.Role]) -> dict:
        """Traduce los permisos guardados a objetos actuales del servidor.
        Los miembros concretos se omiten: puede que ya no esten."""
        result = {}
        for entry in entries:
            if entry["type"] != "role":
                continue
            role = role_map.get(entry["name"])
            if role is None and entry["name"] == "@everyone":
                role = guild.default_role
            if role is None:
                continue
            result[role] = discord.PermissionOverwrite.from_pair(
                discord.Permissions(entry["allow"]), discord.Permissions(entry["deny"]))
        return result

    async def _get(self, guild_id: int, backup_id: int) -> dict | None:
        return await self.bot.db.fetchone(
            "SELECT * FROM backups WHERE id=? AND guild_id=?", (backup_id, guild_id))


class _Confirm(discord.ui.View):
    def __init__(self, author_id: int):
        super().__init__(timeout=120)
        self.author_id = author_id
        self.value = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.author_id

    @discord.ui.button(label="Restaurar", style=discord.ButtonStyle.danger)
    async def yes(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        self.value = True
        await interaction.response.edit_message(
            embed=embeds.info("Restaurando. No cierres Discord."), view=None)
        self.stop()

    @discord.ui.button(label="Cancelar", style=discord.ButtonStyle.secondary)
    async def no(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.edit_message(
            embed=embeds.info("Restauracion cancelada."), view=None)
        self.stop()


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Backups(bot))
