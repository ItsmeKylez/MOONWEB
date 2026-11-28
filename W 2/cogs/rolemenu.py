"""Menus de roles que los miembros se asignan solos."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds
from utils.checks import admin_only


class RoleMenuSelect(discord.ui.DynamicItem[discord.ui.Select],
                     template=r"rm:(?P<mid>[0-9]+)"):
    def __init__(self, menu_id: int, options: list[discord.SelectOption],
                 max_values: int = 1):
        super().__init__(
            discord.ui.Select(custom_id=f"rm:{menu_id}",
                              placeholder="Elige tus roles",
                              min_values=0, max_values=max_values, options=options)
        )
        self.menu_id = menu_id

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction,
                             item: discord.ui.Select, match, /):
        return cls(int(match["mid"]), item.options, item.max_values)

    async def callback(self, interaction: discord.Interaction) -> None:
        cog: RoleMenus = interaction.client.get_cog("Roles")
        await cog.apply(interaction, self.menu_id, [int(v) for v in self.item.values])


class RoleMenus(commands.Cog, name="Roles"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def cog_load(self) -> None:
        self.bot.add_dynamic_items(RoleMenuSelect)

    async def apply(self, interaction: discord.Interaction, menu_id: int,
                    chosen: list[int]) -> None:
        options = await self.bot.db.fetchall(
            "SELECT role_id FROM role_menu_options WHERE menu_id=?", (menu_id,))
        if not options:
            await interaction.response.send_message(
                embed=embeds.error("Este menu ya no existe."), ephemeral=True)
            return

        guild = interaction.guild
        member = interaction.user
        managed = {o["role_id"] for o in options}
        me_top = guild.me.top_role

        to_add, to_remove = [], []
        for role_id in managed:
            role = guild.get_role(role_id)
            if role is None or role >= me_top:
                continue
            if role_id in chosen and role not in member.roles:
                to_add.append(role)
            elif role_id not in chosen and role in member.roles:
                to_remove.append(role)

        try:
            if to_add:
                await member.add_roles(*to_add, reason="Menu de roles")
            if to_remove:
                await member.remove_roles(*to_remove, reason="Menu de roles")
        except discord.HTTPException:
            await interaction.response.send_message(
                embed=embeds.error("No he podido cambiar tus roles. Avisa a un admin."),
                ephemeral=True)
            return

        partes = []
        if to_add:
            partes.append("Añadidos: " + " ".join(r.mention for r in to_add))
        if to_remove:
            partes.append("Quitados: " + " ".join(r.mention for r in to_remove))
        await interaction.response.send_message(
            embed=embeds.ok("\n".join(partes) if partes else "No ha cambiado nada."),
            ephemeral=True)

    # =====================================================================
    rolemenu = app_commands.Group(
        name="rolemenu", description="Menus de roles autoasignables.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @rolemenu.command(name="crear", description="Crea un menu de roles vacio.")
    @app_commands.describe(titulo="Titulo del embed.", descripcion="Texto del embed.",
                           maximo="Cuantos roles puede elegir cada persona (0 = todos).")
    @admin_only()
    async def crear(self, interaction: discord.Interaction, titulo: str,
                    descripcion: str | None = None,
                    maximo: app_commands.Range[int, 0, 25] = 0) -> None:
        menu_id = await self.bot.db.execute(
            "INSERT INTO role_menus (guild_id, title, description, max_roles) VALUES (?,?,?,?)",
            (interaction.guild.id, titulo[:200], descripcion, maximo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Menu creado con la ID `{menu_id}`. Añade roles con "
                            f"`/rolemenu opcion` y publicalo con `/rolemenu publicar`."),
            ephemeral=True)

    @rolemenu.command(name="opcion", description="Añade un rol al menu.")
    @app_commands.describe(menu_id="ID del menu.", rol="Rol que podran elegir.",
                           nombre="Texto de la opcion.", emoji="Emoji de la opcion.",
                           descripcion="Descripcion corta.")
    @admin_only()
    async def opcion(self, interaction: discord.Interaction, menu_id: int,
                     rol: discord.Role, nombre: str | None = None,
                     emoji: str | None = None, descripcion: str | None = None) -> None:
        menu = await self._menu(interaction.guild.id, menu_id)
        if menu is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese menu no existe."), ephemeral=True)
            return
        if rol >= interaction.guild.me.top_role:
            await interaction.response.send_message(
                embed=embeds.error("Ese rol esta por encima del mio, no podria darlo."),
                ephemeral=True)
            return
        count = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM role_menu_options WHERE menu_id=?", (menu_id,), 0)
        if count >= 25:
            await interaction.response.send_message(
                embed=embeds.error("Un menu admite 25 opciones como maximo."), ephemeral=True)
            return
        await self.bot.db.execute(
            "INSERT INTO role_menu_options (menu_id, role_id, label, emoji, description) "
            "VALUES (?,?,?,?,?)",
            (menu_id, rol.id, (nombre or rol.name)[:100], emoji, descripcion))
        await interaction.response.send_message(
            embed=embeds.ok(f"{rol.mention} añadido al menu ({count + 1}/25)."), ephemeral=True)

    @rolemenu.command(name="publicar", description="Publica el menu en un canal.")
    @app_commands.describe(menu_id="ID del menu.", canal="Canal donde publicarlo.")
    @admin_only()
    async def publicar(self, interaction: discord.Interaction, menu_id: int,
                       canal: discord.TextChannel) -> None:
        menu = await self._menu(interaction.guild.id, menu_id)
        if menu is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese menu no existe."), ephemeral=True)
            return
        options = await self.bot.db.fetchall(
            "SELECT * FROM role_menu_options WHERE menu_id=? ORDER BY id", (menu_id,))
        if not options:
            await interaction.response.send_message(
                embed=embeds.error("Añade al menos un rol antes de publicarlo."), ephemeral=True)
            return

        select_options = [
            discord.SelectOption(label=o["label"][:100], value=str(o["role_id"]),
                                 description=o["description"], emoji=o["emoji"] or None)
            for o in options
        ]
        maximo = menu["max_roles"] or len(select_options)
        embed = embeds.base(menu["title"], menu["description"], config.COLOR_PRIMARY)
        embed.set_footer(text="Deselecciona una opcion para quitarte el rol.")

        view = discord.ui.View(timeout=None)
        view.add_item(RoleMenuSelect(menu_id, select_options, min(maximo, len(select_options))))
        try:
            message = await canal.send(embed=embed, view=view)
        except discord.Forbidden:
            await interaction.response.send_message(
                embed=embeds.error(f"No puedo escribir en {canal.mention}."), ephemeral=True)
            return

        if menu["channel_id"] and menu["message_id"]:
            old = interaction.guild.get_channel(menu["channel_id"])
            if old is not None:
                try:
                    await (await old.fetch_message(menu["message_id"])).delete()
                except discord.HTTPException:
                    pass

        await self.bot.db.execute(
            "UPDATE role_menus SET channel_id=?, message_id=? WHERE id=?",
            (canal.id, message.id, menu_id))
        await interaction.response.send_message(
            embed=embeds.ok(f"Menu publicado en {canal.mention}."), ephemeral=True)

    @rolemenu.command(name="lista", description="Lista los menus de roles.")
    @admin_only()
    async def lista(self, interaction: discord.Interaction) -> None:
        menus = await self.bot.db.fetchall(
            "SELECT * FROM role_menus WHERE guild_id=? ORDER BY id", (interaction.guild.id,))
        if not menus:
            await interaction.response.send_message(
                embed=embeds.info("No hay ningun menu de roles."), ephemeral=True)
            return
        embed = embeds.base("Menus de roles", color=config.COLOR_PRIMARY)
        for menu in menus:
            options = await self.bot.db.fetchall(
                "SELECT role_id FROM role_menu_options WHERE menu_id=?", (menu["id"],))
            embed.add_field(
                name=f"`{menu['id']}` · {menu['title']}",
                value=(" ".join(f"<@&{o['role_id']}>" for o in options) or "sin roles"),
                inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @rolemenu.command(name="borrar", description="Borra un menu de roles.")
    @app_commands.describe(menu_id="ID del menu.")
    @admin_only()
    async def borrar(self, interaction: discord.Interaction, menu_id: int) -> None:
        menu = await self._menu(interaction.guild.id, menu_id)
        if menu is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese menu no existe."), ephemeral=True)
            return
        await self.bot.db.execute("DELETE FROM role_menu_options WHERE menu_id=?", (menu_id,))
        await self.bot.db.execute("DELETE FROM role_menus WHERE id=?", (menu_id,))
        await interaction.response.send_message(
            embed=embeds.ok("Menu borrado."), ephemeral=True)

    async def _menu(self, guild_id: int, menu_id: int) -> dict | None:
        return await self.bot.db.fetchone(
            "SELECT * FROM role_menus WHERE id=? AND guild_id=?", (menu_id, guild_id))


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(RoleMenus(bot))
