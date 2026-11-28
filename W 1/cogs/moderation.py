"""Moderacion clasica: sanciones, avisos, notas, purgas y bloqueo de canales."""

from __future__ import annotations

import time
from datetime import timedelta

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, modlog
from utils.checks import staff_only
from utils.paginator import send_pages
from utils.time_parser import human_duration, parse_duration

PURGE_FILTERS = [
    app_commands.Choice(name="todos", value="all"),
    app_commands.Choice(name="solo bots", value="bots"),
    app_commands.Choice(name="solo humanos", value="humans"),
    app_commands.Choice(name="con enlaces", value="links"),
    app_commands.Choice(name="con imagenes o archivos", value="attachments"),
    app_commands.Choice(name="con menciones", value="mentions"),
    app_commands.Choice(name="con embeds", value="embeds"),
]


def _matches(message: discord.Message, mode: str, user: discord.User | None) -> bool:
    if user is not None and message.author.id != user.id:
        return False
    if mode == "bots":
        return message.author.bot
    if mode == "humans":
        return not message.author.bot
    if mode == "links":
        return bool(helpers.URL_RE.search(message.content or ""))
    if mode == "attachments":
        return bool(message.attachments)
    if mode == "mentions":
        return bool(message.mentions or message.role_mentions or message.mention_everyone)
    if mode == "embeds":
        return bool(message.embeds)
    return True


class Moderation(commands.Cog, name="Moderacion"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # =====================================================================
    #  SANCIONES
    # =====================================================================
    @app_commands.command(name="ban", description="Banea a un usuario del servidor.")
    @app_commands.describe(
        usuario="Usuario a banear (acepta tambien una ID).",
        razon="Motivo que queda registrado en el caso.",
        duracion="Opcional. Ej: 30m, 12h, 7d. Si lo dejas vacio el baneo es permanente.",
        borrar="Horas de mensajes suyos que quieres borrar (0-168).",
    )
    @app_commands.guild_only()
    @staff_only()
    async def ban(self, interaction: discord.Interaction, usuario: discord.User,
                  razon: str | None = None, duracion: str | None = None,
                  borrar: app_commands.Range[int, 0, 168] = 0) -> None:
        guild = interaction.guild
        member = guild.get_member(usuario.id)
        if member is not None:
            problem = helpers.can_act_on(guild, interaction.user, member)
            if problem:
                await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
                return

        seconds = parse_duration(duracion) if duracion else None
        if duracion and seconds is None:
            await interaction.response.send_message(
                embed=embeds.error("No entiendo esa duracion. Usa por ejemplo `30m`, `12h` o `7d`."),
                ephemeral=True)
            return

        await interaction.response.defer()
        try:
            await guild.ban(usuario, reason=f"{interaction.user} · {razon or 'sin motivo'}",
                            delete_message_seconds=borrar * 3600)
        except discord.Forbidden:
            await interaction.followup.send(
                embed=embeds.error("No tengo permiso para banear a ese usuario."))
            return

        action = "tempban" if seconds else "ban"
        if seconds:
            await self.bot.db.execute(
                "INSERT INTO temp_actions (guild_id, user_id, action, expires_at) VALUES (?,?,?,?)",
                (guild.id, usuario.id, "ban", int(time.time()) + seconds),
            )
        number = await modlog.create_case(self.bot, guild, action, usuario,
                                          interaction.user, razon, seconds)
        text = f"**{usuario}** baneado. Caso #{number}."
        if seconds:
            text += f" Se levantara en {human_duration(seconds)}."
        await interaction.followup.send(embed=embeds.ok(text))

    @app_commands.command(name="unban", description="Retira el baneo de un usuario.")
    @app_commands.describe(id_usuario="ID del usuario baneado.", razon="Motivo.")
    @app_commands.guild_only()
    @staff_only()
    async def unban(self, interaction: discord.Interaction, id_usuario: str,
                    razon: str | None = None) -> None:
        if not id_usuario.isdigit():
            await interaction.response.send_message(
                embed=embeds.error("Eso no es una ID valida."), ephemeral=True)
            return
        user = discord.Object(id=int(id_usuario))
        await interaction.response.defer()
        try:
            await interaction.guild.unban(user, reason=f"{interaction.user} · {razon or ''}")
        except discord.NotFound:
            await interaction.followup.send(embed=embeds.error("Ese usuario no esta baneado."))
            return

        await self.bot.db.execute(
            "DELETE FROM temp_actions WHERE guild_id=? AND user_id=? AND action='ban'",
            (interaction.guild.id, int(id_usuario)),
        )
        target = await self.bot.fetch_user(int(id_usuario))
        number = await modlog.create_case(self.bot, interaction.guild, "unban", target,
                                          interaction.user, razon, notify=False)
        await interaction.followup.send(embed=embeds.ok(f"**{target}** desbaneado. Caso #{number}."))

    @app_commands.command(name="softban", description="Banea y desbanea para limpiar los mensajes de un usuario.")
    @app_commands.describe(usuario="Usuario afectado.", razon="Motivo.")
    @app_commands.guild_only()
    @staff_only()
    async def softban(self, interaction: discord.Interaction, usuario: discord.Member,
                      razon: str | None = None) -> None:
        problem = helpers.can_act_on(interaction.guild, interaction.user, usuario)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        await interaction.response.defer()
        await interaction.guild.ban(usuario, reason=f"softban · {interaction.user}",
                                    delete_message_seconds=86400)
        await interaction.guild.unban(usuario, reason="softban")
        number = await modlog.create_case(self.bot, interaction.guild, "softban", usuario,
                                          interaction.user, razon)
        await interaction.followup.send(
            embed=embeds.ok(f"Softban aplicado a **{usuario}**. Caso #{number}."))

    @app_commands.command(name="kick", description="Expulsa a un miembro del servidor.")
    @app_commands.describe(usuario="Miembro a expulsar.", razon="Motivo.")
    @app_commands.guild_only()
    @staff_only()
    async def kick(self, interaction: discord.Interaction, usuario: discord.Member,
                   razon: str | None = None) -> None:
        problem = helpers.can_act_on(interaction.guild, interaction.user, usuario)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        await interaction.response.defer()
        number = await modlog.create_case(self.bot, interaction.guild, "kick", usuario,
                                          interaction.user, razon)
        await usuario.kick(reason=f"{interaction.user} · {razon or 'sin motivo'}")
        await interaction.followup.send(
            embed=embeds.ok(f"**{usuario}** expulsado. Caso #{number}."))

    @app_commands.command(name="timeout", description="Aisla a un miembro (no puede hablar ni entrar a voz).")
    @app_commands.describe(usuario="Miembro a aislar.", duracion="Ej: 10m, 2h, 7d (maximo 28d).",
                           razon="Motivo.")
    @app_commands.guild_only()
    @staff_only()
    async def timeout(self, interaction: discord.Interaction, usuario: discord.Member,
                      duracion: str, razon: str | None = None) -> None:
        problem = helpers.can_act_on(interaction.guild, interaction.user, usuario)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        seconds = parse_duration(duracion)
        if not seconds:
            await interaction.response.send_message(
                embed=embeds.error("Duracion no valida. Usa `10m`, `2h`, `7d`..."), ephemeral=True)
            return
        if seconds > 28 * 86400:
            await interaction.response.send_message(
                embed=embeds.error("Discord no permite aislar mas de 28 dias."), ephemeral=True)
            return

        await interaction.response.defer()
        await usuario.timeout(timedelta(seconds=seconds),
                              reason=f"{interaction.user} · {razon or 'sin motivo'}")
        number = await modlog.create_case(self.bot, interaction.guild, "timeout", usuario,
                                          interaction.user, razon, seconds)
        await interaction.followup.send(embed=embeds.ok(
            f"**{usuario}** aislado {human_duration(seconds)}. Caso #{number}."))

    @app_commands.command(name="untimeout", description="Levanta el aislamiento de un miembro.")
    @app_commands.describe(usuario="Miembro aislado.", razon="Motivo.")
    @app_commands.guild_only()
    @staff_only()
    async def untimeout(self, interaction: discord.Interaction, usuario: discord.Member,
                        razon: str | None = None) -> None:
        if usuario.timed_out_until is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese miembro no esta aislado."), ephemeral=True)
            return
        await interaction.response.defer()
        await usuario.timeout(None, reason=f"{interaction.user} · {razon or ''}")
        number = await modlog.create_case(self.bot, interaction.guild, "untimeout", usuario,
                                          interaction.user, razon)
        await interaction.followup.send(
            embed=embeds.ok(f"Aislamiento retirado a **{usuario}**. Caso #{number}."))

    # =====================================================================
    #  AVISOS Y NOTAS
    # =====================================================================
    @app_commands.command(name="warn", description="Da un aviso a un miembro.")
    @app_commands.describe(usuario="Miembro avisado.", razon="Motivo del aviso.")
    @app_commands.guild_only()
    @staff_only()
    async def warn(self, interaction: discord.Interaction, usuario: discord.Member,
                   razon: str) -> None:
        problem = helpers.can_act_on(interaction.guild, interaction.user, usuario)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        await interaction.response.defer()
        await self.bot.db.execute(
            "INSERT INTO warns (guild_id, user_id, moderator_id, reason, created_at) "
            "VALUES (?,?,?,?,?)",
            (interaction.guild.id, usuario.id, interaction.user.id, razon[:900], int(time.time())),
        )
        total = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM warns WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, usuario.id), 0)
        number = await modlog.create_case(self.bot, interaction.guild, "warn", usuario,
                                          interaction.user, razon)
        await interaction.followup.send(embed=embeds.ok(
            f"**{usuario}** avisado. Ya acumula **{total}** aviso(s). Caso #{number}."))

    @app_commands.command(name="warns", description="Muestra los avisos de un miembro.")
    @app_commands.describe(usuario="Miembro a consultar.")
    @app_commands.guild_only()
    @staff_only()
    async def warns(self, interaction: discord.Interaction, usuario: discord.User) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT * FROM warns WHERE guild_id=? AND user_id=? ORDER BY id DESC",
            (interaction.guild.id, usuario.id))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info(f"**{usuario}** no tiene ningun aviso."), ephemeral=True)
            return

        pages = []
        for group in helpers.chunk(rows, 6):
            embed = embeds.base(f"Avisos de {usuario}", color=config.COLOR_WARN)
            embed.set_thumbnail(url=usuario.display_avatar.url)
            for row in group:
                moderator = interaction.guild.get_member(row["moderator_id"])
                embed.add_field(
                    name=f"#{row['id']} · <t:{row['created_at']}:d>",
                    value=f"{helpers.truncate(row['reason'], 200)}\n"
                          f"Por: {moderator.mention if moderator else row['moderator_id']}",
                    inline=False)
            embed.set_footer(text=f"Total: {len(rows)} aviso(s)")
            pages.append(embed)
        await send_pages(interaction, pages, ephemeral=True)

    @app_commands.command(name="delwarn", description="Borra un aviso concreto por su numero.")
    @app_commands.describe(id_aviso="Numero que aparece en /warns.")
    @app_commands.guild_only()
    @staff_only()
    async def delwarn(self, interaction: discord.Interaction, id_aviso: int) -> None:
        row = await self.bot.db.fetchone(
            "SELECT * FROM warns WHERE id=? AND guild_id=?", (id_aviso, interaction.guild.id))
        if not row:
            await interaction.response.send_message(
                embed=embeds.error("No existe ese aviso en este servidor."), ephemeral=True)
            return
        await self.bot.db.execute("DELETE FROM warns WHERE id=?", (id_aviso,))
        await interaction.response.send_message(
            embed=embeds.ok(f"Aviso #{id_aviso} borrado."), ephemeral=True)

    @app_commands.command(name="clearwarns", description="Borra todos los avisos de un miembro.")
    @app_commands.describe(usuario="Miembro a limpiar.")
    @app_commands.guild_only()
    @staff_only()
    async def clearwarns(self, interaction: discord.Interaction, usuario: discord.User) -> None:
        total = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM warns WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, usuario.id), 0)
        await self.bot.db.execute(
            "DELETE FROM warns WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, usuario.id))
        await interaction.response.send_message(
            embed=embeds.ok(f"Borrados {total} aviso(s) de **{usuario}**."), ephemeral=True)

    @app_commands.command(name="nota", description="Guarda una nota privada del staff sobre un usuario.")
    @app_commands.describe(usuario="Usuario.", texto="Contenido de la nota.")
    @app_commands.guild_only()
    @staff_only()
    async def nota(self, interaction: discord.Interaction, usuario: discord.User,
                   texto: str) -> None:
        await self.bot.db.execute(
            "INSERT INTO notes (guild_id, user_id, author_id, content, created_at) VALUES (?,?,?,?,?)",
            (interaction.guild.id, usuario.id, interaction.user.id, texto[:900], int(time.time())))
        await interaction.response.send_message(
            embed=embeds.ok(f"Nota guardada sobre **{usuario}**."), ephemeral=True)

    @app_commands.command(name="notas", description="Lee las notas del staff sobre un usuario.")
    @app_commands.describe(usuario="Usuario.")
    @app_commands.guild_only()
    @staff_only()
    async def notas(self, interaction: discord.Interaction, usuario: discord.User) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT * FROM notes WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 20",
            (interaction.guild.id, usuario.id))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("No hay notas sobre ese usuario."), ephemeral=True)
            return
        embed = embeds.base(f"Notas sobre {usuario}", color=config.COLOR_INFO)
        for row in rows[:10]:
            embed.add_field(
                name=f"#{row['id']} · <t:{row['created_at']}:d>",
                value=f"{helpers.truncate(row['content'], 300)}\n<@{row['author_id']}>",
                inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # =====================================================================
    #  HISTORIAL
    # =====================================================================
    @app_commands.command(name="caso", description="Consulta un caso de moderacion por su numero.")
    @app_commands.describe(numero="Numero del caso.")
    @app_commands.guild_only()
    @staff_only()
    async def caso(self, interaction: discord.Interaction, numero: int) -> None:
        row = await modlog.get_case(self.bot, interaction.guild.id, numero)
        if not row:
            await interaction.response.send_message(
                embed=embeds.error("Ese caso no existe."), ephemeral=True)
            return
        label, emoji, color = modlog.describe(row["action"])
        embed = embeds.base(f"{emoji} Caso #{numero} · {label}", color=color)
        embed.add_field(name="Usuario", value=f"<@{row['user_id']}> (`{row['user_id']}`)", inline=False)
        embed.add_field(name="Moderador", value=f"<@{row['moderator_id']}>", inline=False)
        embed.add_field(name="Fecha", value=f"<t:{row['created_at']}:F>", inline=False)
        if row["duration"]:
            embed.add_field(name="Duracion", value=human_duration(row["duration"]), inline=True)
        embed.add_field(name="Motivo", value=helpers.truncate(row["reason"], 900), inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="historial", description="Historial completo de sanciones de un usuario.")
    @app_commands.describe(usuario="Usuario a consultar.")
    @app_commands.guild_only()
    @staff_only()
    async def historial(self, interaction: discord.Interaction, usuario: discord.User) -> None:
        rows = await modlog.user_history(self.bot, interaction.guild.id, usuario.id)
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info(f"**{usuario}** no tiene sanciones registradas."), ephemeral=True)
            return
        pages = []
        for group in helpers.chunk(rows, 8):
            embed = embeds.base(f"Historial de {usuario}", color=config.COLOR_MOD)
            embed.set_thumbnail(url=usuario.display_avatar.url)
            for row in group:
                label, emoji, _ = modlog.describe(row["action"])
                embed.add_field(
                    name=f"#{row['number']} · {emoji} {label} · <t:{row['created_at']}:d>",
                    value=helpers.truncate(row["reason"], 180),
                    inline=False)
            embed.set_footer(text=f"{len(rows)} sancion(es) en total")
            pages.append(embed)
        await send_pages(interaction, pages, ephemeral=True)

    @app_commands.command(name="modstats", description="Cuantas sanciones ha puesto cada moderador.")
    @app_commands.guild_only()
    @staff_only()
    async def modstats(self, interaction: discord.Interaction) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT moderator_id, COUNT(*) AS total FROM cases WHERE guild_id=? "
            "GROUP BY moderator_id ORDER BY total DESC LIMIT 15", (interaction.guild.id,))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("Todavia no hay sanciones registradas."), ephemeral=True)
            return
        lines = [f"`{i:>2}.` <@{r['moderator_id']}> — **{r['total']}**"
                 for i, r in enumerate(rows, 1)]
        embed = embeds.base("Ranking de moderadores", "\n".join(lines), config.COLOR_MOD)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # =====================================================================
    #  CANALES
    # =====================================================================
    @app_commands.command(name="purge", description="Borra mensajes del canal, con filtros opcionales.")
    @app_commands.describe(cantidad="Cuantos mensajes borrar (1-500).",
                           usuario="Solo mensajes de este usuario.",
                           filtro="Tipo de mensaje a borrar.")
    @app_commands.choices(filtro=PURGE_FILTERS)
    @app_commands.guild_only()
    @staff_only()
    async def purge(self, interaction: discord.Interaction,
                    cantidad: app_commands.Range[int, 1, 500],
                    usuario: discord.User | None = None,
                    filtro: app_commands.Choice[str] | None = None) -> None:
        channel = interaction.channel
        if not channel.permissions_for(interaction.guild.me).manage_messages:
            await interaction.response.send_message(
                embed=embeds.error("Me falta el permiso *Gestionar mensajes* en este canal."),
                ephemeral=True)
            return

        mode = filtro.value if filtro else "all"
        await interaction.response.defer(ephemeral=True)

        cutoff = discord.utils.utcnow() - timedelta(days=13, hours=23)
        targets: list[discord.Message] = []
        too_old = 0
        async for message in channel.history(limit=min(cantidad * 5, 1000)):
            if len(targets) >= cantidad:
                break
            if not _matches(message, mode, usuario):
                continue
            if message.created_at < cutoff:
                too_old += 1
                continue
            if message.pinned:
                continue
            targets.append(message)

        deleted = 0
        for group in helpers.chunk(targets, 100):
            try:
                await channel.delete_messages(group, reason=f"purge · {interaction.user}")
                deleted += len(group)
            except discord.HTTPException:
                pass

        note = ""
        if too_old:
            note = (f"\nSe han omitido {too_old} mensaje(s) de mas de 14 dias: "
                    "Discord no permite borrarlos en bloque.")
        await interaction.followup.send(
            embed=embeds.ok(f"Borrados **{deleted}** mensaje(s).{note}"), ephemeral=True)

        if deleted:
            embed = embeds.base(f"{config.E_TRASH} Purga de mensajes", color=config.COLOR_MOD)
            embed.add_field(name="Canal", value=channel.mention, inline=True)
            embed.add_field(name="Cantidad", value=str(deleted), inline=True)
            embed.add_field(name="Moderador", value=helpers.fmt_user(interaction.user), inline=False)
            if usuario:
                embed.add_field(name="Filtrado por", value=helpers.fmt_user(usuario), inline=False)
            await helpers.send_log(self.bot, interaction.guild, "mensajes", embed)

    @app_commands.command(name="slowmode", description="Cambia el modo lento del canal.")
    @app_commands.describe(segundos="0 para desactivar, maximo 21600 (6 horas).")
    @app_commands.guild_only()
    @staff_only()
    async def slowmode(self, interaction: discord.Interaction,
                       segundos: app_commands.Range[int, 0, 21600]) -> None:
        await interaction.channel.edit(slowmode_delay=segundos,
                                       reason=f"slowmode · {interaction.user}")
        if segundos:
            await interaction.response.send_message(
                embed=embeds.ok(f"Modo lento: **{human_duration(segundos)}** entre mensajes."))
        else:
            await interaction.response.send_message(embed=embeds.ok("Modo lento desactivado."))

    @app_commands.command(name="lock", description="Impide que @everyone escriba en este canal.")
    @app_commands.describe(razon="Motivo que se anuncia en el canal.")
    @app_commands.guild_only()
    @staff_only()
    async def lock(self, interaction: discord.Interaction, razon: str | None = None) -> None:
        channel = interaction.channel
        if not isinstance(channel, (discord.TextChannel, discord.VoiceChannel,
                                    discord.ForumChannel, discord.StageChannel)):
            await interaction.response.send_message(
                embed=embeds.error("Esto solo funciona en un canal, no en un hilo."),
                ephemeral=True)
            return
        overwrite = channel.overwrites_for(interaction.guild.default_role)
        overwrite.send_messages = False
        await channel.set_permissions(interaction.guild.default_role, overwrite=overwrite,
                                      reason=f"lock · {interaction.user}")
        embed = embeds.base(f"{config.E_LOCK} Canal bloqueado",
                            razon or "Un moderador ha cerrado este canal temporalmente.",
                            config.COLOR_WARN)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="unlock", description="Vuelve a permitir escribir en este canal.")
    @app_commands.guild_only()
    @staff_only()
    async def unlock(self, interaction: discord.Interaction) -> None:
        channel = interaction.channel
        if not isinstance(channel, (discord.TextChannel, discord.VoiceChannel,
                                    discord.ForumChannel, discord.StageChannel)):
            await interaction.response.send_message(
                embed=embeds.error("Esto solo funciona en un canal, no en un hilo."),
                ephemeral=True)
            return
        overwrite = channel.overwrites_for(interaction.guild.default_role)
        overwrite.send_messages = None
        await channel.set_permissions(interaction.guild.default_role, overwrite=overwrite,
                                      reason=f"unlock · {interaction.user}")
        await interaction.response.send_message(
            embed=embeds.base(f"{config.E_UNLOCK} Canal desbloqueado", color=config.COLOR_OK))

    @app_commands.command(name="lockdown", description="Bloquea o desbloquea TODOS los canales de texto.")
    @app_commands.describe(estado="on para bloquear, off para desbloquear.")
    @app_commands.choices(estado=[
        app_commands.Choice(name="on", value="on"),
        app_commands.Choice(name="off", value="off"),
    ])
    @app_commands.guild_only()
    @staff_only()
    async def lockdown(self, interaction: discord.Interaction,
                       estado: app_commands.Choice[str]) -> None:
        await interaction.response.defer()
        locked = await self.apply_lockdown(interaction.guild, estado.value == "on",
                                           f"lockdown · {interaction.user}")
        verb = "bloqueados" if estado.value == "on" else "desbloqueados"
        await interaction.followup.send(
            embed=embeds.ok(f"{locked} canal(es) {verb}."))

    async def apply_lockdown(self, guild: discord.Guild, lock: bool, reason: str) -> int:
        """Usado tambien por el anti-raid cuando detecta una oleada."""
        default = guild.default_role
        changed = 0
        for channel in guild.text_channels:
            perms = channel.permissions_for(guild.me)
            if not perms.manage_roles:
                continue
            overwrite = channel.overwrites_for(default)
            new_value = False if lock else None
            if overwrite.send_messages == new_value:
                continue
            overwrite.send_messages = new_value
            try:
                await channel.set_permissions(default, overwrite=overwrite, reason=reason)
                changed += 1
            except discord.HTTPException:
                continue
        return changed

    @app_commands.command(name="clonar", description="Clona el canal y borra el original (limpieza total).")
    @app_commands.guild_only()
    @staff_only()
    async def clonar(self, interaction: discord.Interaction) -> None:
        channel = interaction.channel
        if not isinstance(channel, discord.TextChannel):
            await interaction.response.send_message(
                embed=embeds.error("Solo se pueden clonar canales de texto."), ephemeral=True)
            return
        view = ConfirmView(interaction.user.id)
        await interaction.response.send_message(
            embed=embeds.warn(f"Se va a borrar {channel.mention} y recrearlo identico. "
                              "Todos los mensajes se perderan. ¿Continuar?"),
            view=view, ephemeral=True)
        await view.wait()
        if not view.value:
            return
        position = channel.position
        clone = await channel.clone(reason=f"clonar · {interaction.user}")
        await channel.delete(reason=f"clonar · {interaction.user}")
        await clone.edit(position=position)
        await clone.send(embed=embeds.ok(f"Canal recreado por {interaction.user.mention}."))

    # =====================================================================
    #  ROLES
    # =====================================================================
    rol = app_commands.Group(name="rol", description="Gestion de roles.",
                             guild_only=True)

    @rol.command(name="dar", description="Da un rol a un miembro.")
    @app_commands.describe(usuario="Miembro.", rol="Rol a dar.")
    @staff_only()
    async def rol_dar(self, interaction: discord.Interaction, usuario: discord.Member,
                      rol: discord.Role) -> None:
        problem = self._role_problem(interaction, rol)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        if rol in usuario.roles:
            await interaction.response.send_message(
                embed=embeds.error("Ese miembro ya tiene el rol."), ephemeral=True)
            return
        await usuario.add_roles(rol, reason=f"{interaction.user}")
        await interaction.response.send_message(
            embed=embeds.ok(f"Rol {rol.mention} dado a **{usuario}**."))

    @rol.command(name="quitar", description="Quita un rol a un miembro.")
    @app_commands.describe(usuario="Miembro.", rol="Rol a quitar.")
    @staff_only()
    async def rol_quitar(self, interaction: discord.Interaction, usuario: discord.Member,
                         rol: discord.Role) -> None:
        problem = self._role_problem(interaction, rol)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return
        if rol not in usuario.roles:
            await interaction.response.send_message(
                embed=embeds.error("Ese miembro no tiene el rol."), ephemeral=True)
            return
        await usuario.remove_roles(rol, reason=f"{interaction.user}")
        await interaction.response.send_message(
            embed=embeds.ok(f"Rol {rol.mention} retirado a **{usuario}**."))

    @rol.command(name="masivo", description="Da o quita un rol a todos los miembros.")
    @app_commands.describe(accion="dar o quitar.", rol="Rol afectado.",
                           solo_humanos="Excluir bots (por defecto si).")
    @app_commands.choices(accion=[
        app_commands.Choice(name="dar", value="dar"),
        app_commands.Choice(name="quitar", value="quitar"),
    ])
    @staff_only()
    async def rol_masivo(self, interaction: discord.Interaction,
                         accion: app_commands.Choice[str], rol: discord.Role,
                         solo_humanos: bool = True) -> None:
        problem = self._role_problem(interaction, rol)
        if problem:
            await interaction.response.send_message(embed=embeds.error(problem), ephemeral=True)
            return

        members = [m for m in interaction.guild.members if not (solo_humanos and m.bot)]
        if accion.value == "dar":
            members = [m for m in members if rol not in m.roles]
        else:
            members = [m for m in members if rol in m.roles]

        view = ConfirmView(interaction.user.id)
        await interaction.response.send_message(
            embed=embeds.warn(f"Se va a **{accion.value}** el rol {rol.mention} a "
                              f"**{len(members)}** miembro(s). Puede tardar varios minutos."),
            view=view, ephemeral=True)
        await view.wait()
        if not view.value:
            return

        done = 0
        for member in members:
            try:
                if accion.value == "dar":
                    await member.add_roles(rol, reason=f"masivo · {interaction.user}")
                else:
                    await member.remove_roles(rol, reason=f"masivo · {interaction.user}")
                done += 1
            except discord.HTTPException:
                continue
        await interaction.followup.send(
            embed=embeds.ok(f"Listo: {done}/{len(members)} miembros actualizados."), ephemeral=True)

    def _role_problem(self, interaction: discord.Interaction, role: discord.Role) -> str | None:
        guild = interaction.guild
        if role >= guild.me.top_role:
            return "Ese rol esta por encima del mio. Sube mi rol en la lista."
        if role.managed:
            return "Ese rol lo gestiona una integracion y no se puede asignar a mano."
        if interaction.user.id != guild.owner_id and role >= interaction.user.top_role:
            return "Ese rol esta por encima del tuyo."
        return None


class ConfirmView(discord.ui.View):
    """Confirmacion de dos pasos para acciones destructivas."""

    def __init__(self, author_id: int, timeout: float = 60):
        super().__init__(timeout=timeout)
        self.author_id = author_id
        self.value = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("No es tu confirmacion.", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="Confirmar", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, _: discord.ui.Button):
        self.value = True
        for child in self.children:
            child.disabled = True
        await interaction.response.edit_message(view=self)
        self.stop()

    @discord.ui.button(label="Cancelar", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _: discord.ui.Button):
        self.value = False
        for child in self.children:
            child.disabled = True
        await interaction.response.edit_message(
            embed=embeds.info("Operacion cancelada."), view=self)
        self.stop()


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Moderation(bot))
