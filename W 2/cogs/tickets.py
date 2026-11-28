"""Sistema de tickets.

Un panel puede tener varias categorias; cada categoria tiene su propio canal
de destino, su rol de staff, su mensaje de apertura y hasta cinco preguntas
que se piden en un formulario antes de abrir el ticket.

Los botones son DynamicItem, asi que siguen funcionando despues de reiniciar
el bot sin necesidad de volver a publicar los paneles.
"""

from __future__ import annotations

import asyncio
import io
import logging
import time

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, transcripts
from utils.checks import admin_only, staff_only
from utils.paginator import send_pages

log = logging.getLogger("bot.tickets")


class TicketError(Exception):
    """Error controlado al crear un ticket; el texto se muestra al usuario."""


PRIORITY_CHOICES = [
    app_commands.Choice(name="baja", value="baja"),
    app_commands.Choice(name="media", value="media"),
    app_commands.Choice(name="alta", value="alta"),
    app_commands.Choice(name="urgente", value="urgente"),
]


# ===========================================================================
#  COMPONENTES PERSISTENTES
# ===========================================================================
class OpenTicketButton(discord.ui.DynamicItem[discord.ui.Button],
                       template=r"tk:open:(?P<cid>[0-9]+)"):
    """Boton de un panel en modo 'buttons'."""

    def __init__(self, category_id: int, label: str,
                 emoji: str | discord.PartialEmoji | None = None):
        super().__init__(
            discord.ui.Button(label=label[:80], emoji=emoji,
                              style=discord.ButtonStyle.primary,
                              custom_id=f"tk:open:{category_id}")
        )
        self.category_id = category_id

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction,
                             item: discord.ui.Button, match, /):
        return cls(int(match["cid"]), item.label or "Abrir ticket", item.emoji)

    async def callback(self, interaction: discord.Interaction) -> None:
        cog: Tickets = interaction.client.get_cog("Tickets")
        await cog.start_ticket(interaction, self.category_id)


class PanelSelect(discord.ui.DynamicItem[discord.ui.Select],
                  template=r"tk:panel:(?P<pid>[0-9]+)"):
    """Menu desplegable de un panel en modo 'select'."""

    def __init__(self, panel_id: int, options: list[discord.SelectOption]):
        super().__init__(
            discord.ui.Select(custom_id=f"tk:panel:{panel_id}",
                              placeholder="Elige el motivo de tu ticket",
                              min_values=1, max_values=1, options=options)
        )

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction,
                             item: discord.ui.Select, match, /):
        return cls(int(match["pid"]), item.options)

    async def callback(self, interaction: discord.Interaction) -> None:
        cog: Tickets = interaction.client.get_cog("Tickets")
        await cog.start_ticket(interaction, int(self.item.values[0]))


class RateSelect(discord.ui.DynamicItem[discord.ui.Select],
                 template=r"tk:rate:(?P<tid>[0-9]+)"):
    """Encuesta de valoracion que se envia por DM al cerrar."""

    def __init__(self, ticket_id: int):
        options = [
            discord.SelectOption(label=f"{n} de 5", value=str(n), emoji=config.E_STAR)
            for n in range(1, 6)
        ]
        super().__init__(
            discord.ui.Select(custom_id=f"tk:rate:{ticket_id}",
                              placeholder="¿Que tal te han atendido?",
                              options=options)
        )
        self.ticket_id = ticket_id

    @classmethod
    async def from_custom_id(cls, interaction: discord.Interaction,
                             item: discord.ui.Select, match, /):
        return cls(int(match["tid"]))

    async def callback(self, interaction: discord.Interaction) -> None:
        cog: Tickets = interaction.client.get_cog("Tickets")
        await cog.save_rating(interaction, self.ticket_id, int(self.item.values[0]))


class TicketControls(discord.ui.View):
    """Botones que aparecen dentro de cada ticket. custom_id fijo: la vista se
    registra una sola vez y sirve para todos los tickets."""

    def __init__(self) -> None:
        super().__init__(timeout=None)

    @discord.ui.button(label="Cerrar", emoji=config.E_LOCK,
                       style=discord.ButtonStyle.danger, custom_id="tk:close")
    async def close(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        cog: Tickets = interaction.client.get_cog("Tickets")
        await cog.ask_close(interaction)

    @discord.ui.button(label="Atender", emoji="\U0001f64b",
                       style=discord.ButtonStyle.success, custom_id="tk:claim")
    async def claim(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        cog: Tickets = interaction.client.get_cog("Tickets")
        await cog.claim_ticket(interaction)

    @discord.ui.button(label="Transcript", emoji="\U0001f4c4",
                       style=discord.ButtonStyle.secondary, custom_id="tk:transcript")
    async def transcript(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        cog: Tickets = interaction.client.get_cog("Tickets")
        await cog.send_transcript(interaction)


class ConfirmClose(discord.ui.View):
    def __init__(self, author_id: int):
        super().__init__(timeout=60)
        self.author_id = author_id
        self.reason: str | None = None
        self.confirmed = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.author_id

    @discord.ui.button(label="Si, cerrar", style=discord.ButtonStyle.danger)
    async def yes(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        self.confirmed = True
        await interaction.response.edit_message(
            embed=embeds.info("Cerrando el ticket..."), view=None)
        self.stop()

    @discord.ui.button(label="Cancelar", style=discord.ButtonStyle.secondary)
    async def no(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.edit_message(
            embed=embeds.info("El ticket sigue abierto."), view=None)
        self.stop()


class QuestionsModal(discord.ui.Modal):
    """Formulario previo a la apertura, con las preguntas de la categoria."""

    def __init__(self, cog: "Tickets", category: dict, questions: list[dict]):
        super().__init__(title=f"Ticket · {category['label']}"[:45])
        self.cog = cog
        self.category = category
        self.inputs: list[discord.ui.TextInput] = []
        for question in questions[:5]:
            field = discord.ui.TextInput(
                label=question["label"][:45],
                placeholder=(question["placeholder"] or "")[:100] or None,
                style=(discord.TextStyle.paragraph if question["style"] == "long"
                       else discord.TextStyle.short),
                required=bool(question["required"]),
                max_length=1000,
            )
            self.inputs.append(field)
            self.add_item(field)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        answers = [(field.label, field.value or "*sin respuesta*") for field in self.inputs]
        await self.cog.create_ticket(interaction, self.category, answers)


# ===========================================================================
#  COG
# ===========================================================================
class Tickets(commands.Cog, name="Tickets"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._channels: set[int] = set()      # canales que son tickets abiertos

    async def cog_load(self) -> None:
        self.bot.add_dynamic_items(OpenTicketButton, PanelSelect, RateSelect)
        self.bot.add_view(TicketControls())
        rows = await self.bot.db.fetchall(
            "SELECT channel_id FROM tickets WHERE status='open' AND channel_id IS NOT NULL")
        self._channels = {r["channel_id"] for r in rows}

    # =====================================================================
    #  APERTURA
    # =====================================================================
    async def start_ticket(self, interaction: discord.Interaction, category_id: int) -> None:
        category = await self.bot.db.fetchone(
            "SELECT * FROM ticket_categories WHERE id=?", (category_id,))
        if category is None or category["guild_id"] != interaction.guild_id:
            await interaction.response.send_message(
                embed=embeds.error("Esta categoria ya no existe. Avisa a un administrador."),
                ephemeral=True)
            return

        blocked = await self.bot.db.fetchone(
            "SELECT reason FROM ticket_blacklist WHERE guild_id=? AND user_id=?",
            (interaction.guild_id, interaction.user.id))
        if blocked is not None:
            await interaction.response.send_message(
                embed=embeds.error(f"No puedes abrir tickets.\nMotivo: "
                                   f"{blocked['reason'] or 'no indicado'}"),
                ephemeral=True)
            return

        cfg = await self.bot.db.get("ticket_config", interaction.guild_id)
        open_count = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM tickets WHERE guild_id=? AND user_id=? AND status='open'",
            (interaction.guild_id, interaction.user.id), 0)
        if cfg["max_open"] and open_count >= cfg["max_open"]:
            await interaction.response.send_message(
                embed=embeds.error(f"Ya tienes {open_count} ticket(s) abierto(s). "
                                   "Cierra alguno antes de abrir otro."),
                ephemeral=True)
            return

        questions = await self.bot.db.fetchall(
            "SELECT * FROM ticket_questions WHERE category_id=? ORDER BY position, id",
            (category_id,))
        if questions:
            await interaction.response.send_modal(QuestionsModal(self, category, questions))
        else:
            await interaction.response.defer(ephemeral=True, thinking=True)
            await self.create_ticket(interaction, category, [])

    async def create_ticket(self, interaction: discord.Interaction, category: dict,
                            answers: list[tuple[str, str]]) -> None:
        if not interaction.response.is_done():
            await interaction.response.defer(ephemeral=True, thinking=True)

        guild = interaction.guild
        member = interaction.user
        number = await self.bot.db.next_counter(guild.id, "ticket_counter")
        staff_role = guild.get_role(category["staff_role"]) if category["staff_role"] else None

        try:
            channel, thread = await self._make_channel(guild, member, category,
                                                       number, staff_role)
        except discord.Forbidden:
            await interaction.followup.send(
                embed=embeds.error("Me faltan permisos para crear el canal del ticket. "
                                   "Necesito *Gestionar canales* en esa categoria."),
                ephemeral=True)
            return
        except TicketError as exc:
            await interaction.followup.send(
                embed=embeds.error(f"No se pudo crear el ticket: {exc}"), ephemeral=True)
            return
        except discord.HTTPException as exc:
            await interaction.followup.send(
                embed=embeds.error(f"Discord ha rechazado la creacion del canal: `{exc}`"),
                ephemeral=True)
            return

        target = thread or channel
        now = int(time.time())
        ticket_id = await self.bot.db.execute(
            "INSERT INTO tickets (guild_id, number, channel_id, user_id, category_id, "
            "category_name, opened_at, last_activity) VALUES (?,?,?,?,?,?,?,?)",
            (guild.id, number, target.id, member.id, category["id"], category["label"],
             now, now))
        self._channels.add(target.id)

        embed = embeds.base(
            f"{config.E_TICKET} Ticket #{number:04d} · {category['label']}",
            category["open_message"] or
            "Cuenta tu problema con el mayor detalle posible. El staff te atendera aqui.",
            config.COLOR_TICKET)
        embed.add_field(name="Abierto por", value=helpers.fmt_user(member), inline=False)
        for label, value in answers:
            embed.add_field(name=label, value=helpers.truncate(value, 1000), inline=False)
        embed.set_footer(text=f"Ticket #{number:04d} · usa los botones de abajo")

        mention = f"{member.mention}"
        if staff_role is not None:
            mention += f" {staff_role.mention}"
        await target.send(
            content=mention, embed=embed, view=TicketControls(),
            allowed_mentions=discord.AllowedMentions(users=True, roles=True))

        await interaction.followup.send(
            embed=embeds.ok(f"Ticket creado: {target.mention}"), ephemeral=True)

        log_embed = embeds.base(f"{config.E_TICKET} Ticket abierto", color=config.COLOR_TICKET)
        log_embed.add_field(name="Numero", value=f"#{number:04d}", inline=True)
        log_embed.add_field(name="Categoria", value=category["label"], inline=True)
        log_embed.add_field(name="Canal", value=target.mention, inline=True)
        log_embed.add_field(name="Usuario", value=helpers.fmt_user(member), inline=False)
        await helpers.send_log(self.bot, guild, "tickets", log_embed)
        log.info("Ticket #%s abierto en %s por %s", number, guild.id, member.id)
        return ticket_id

    async def _make_channel(self, guild: discord.Guild, member: discord.Member,
                            category: dict, number: int,
                            staff_role: discord.Role | None):
        """Crea el canal (o el hilo privado) del ticket con sus permisos."""
        name = f"ticket-{number:04d}"
        parent = guild.get_channel(category["category_id"]) if category["category_id"] else None

        if category["use_threads"]:
            base = parent if isinstance(parent, discord.TextChannel) else None
            if base is None:
                base = guild.system_channel or next(iter(guild.text_channels), None)
            if base is None:
                raise TicketError("no hay ningun canal de texto donde crear el hilo")
            thread = await base.create_thread(
                name=name, type=discord.ChannelType.private_thread,
                invitable=False, reason=f"Ticket de {member}")
            await thread.add_user(member)
            if staff_role is not None:
                await thread.send(
                    staff_role.mention, delete_after=2,
                    allowed_mentions=discord.AllowedMentions(roles=True))
            return base, thread

        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            guild.me: discord.PermissionOverwrite(
                view_channel=True, send_messages=True, manage_channels=True,
                manage_messages=True, embed_links=True, attach_files=True,
                read_message_history=True),
            member: discord.PermissionOverwrite(
                view_channel=True, send_messages=True, embed_links=True,
                attach_files=True, read_message_history=True),
        }
        if staff_role is not None:
            overwrites[staff_role] = discord.PermissionOverwrite(
                view_channel=True, send_messages=True, manage_messages=True,
                embed_links=True, attach_files=True, read_message_history=True)

        channel = await guild.create_text_channel(
            name=name,
            category=parent if isinstance(parent, discord.CategoryChannel) else None,
            overwrites=overwrites,
            topic=f"Ticket #{number:04d} · {category['label']} · abierto por {member}",
            reason=f"Ticket de {member}")
        return channel, None

    # =====================================================================
    #  GESTION
    # =====================================================================
    async def _ticket_of(self, channel_id: int) -> dict | None:
        return await self.bot.db.fetchone(
            "SELECT * FROM tickets WHERE channel_id=? AND status='open'", (channel_id,))

    async def claim_ticket(self, interaction: discord.Interaction) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        if not await helpers.is_staff(self.bot, interaction.user):
            await interaction.response.send_message(
                embed=embeds.error("Solo el staff puede atender tickets."), ephemeral=True)
            return
        if ticket["claimed_by"]:
            await interaction.response.send_message(
                embed=embeds.error(f"Ya lo esta atendiendo <@{ticket['claimed_by']}>."),
                ephemeral=True)
            return

        await self.bot.db.execute("UPDATE tickets SET claimed_by=? WHERE id=?",
                                  (interaction.user.id, ticket["id"]))
        await interaction.response.send_message(
            embed=embeds.ok(f"{interaction.user.mention} se hace cargo de este ticket."))

    async def ask_close(self, interaction: discord.Interaction) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        is_owner = interaction.user.id == ticket["user_id"]
        if not is_owner and not await helpers.is_staff(self.bot, interaction.user):
            await interaction.response.send_message(
                embed=embeds.error("Solo el autor del ticket o el staff pueden cerrarlo."),
                ephemeral=True)
            return

        view = ConfirmClose(interaction.user.id)
        await interaction.response.send_message(
            embed=embeds.warn("Se guardara el transcript y el canal se borrara. ¿Cerrar?"),
            view=view, ephemeral=True)
        await view.wait()
        if view.confirmed:
            await self.close_ticket(interaction.channel, interaction.user, None)

    async def close_ticket(self, channel: discord.abc.GuildChannel,
                           closer: discord.abc.User, reason: str | None) -> None:
        ticket = await self._ticket_of(channel.id)
        if ticket is None:
            return

        guild = channel.guild
        await self.bot.db.execute(
            "UPDATE tickets SET status='closed', closed_at=?, closed_by=?, close_reason=? "
            "WHERE id=?",
            (int(time.time()), closer.id, (reason or "")[:500], ticket["id"]))
        self._channels.discard(channel.id)

        cfg = await self.bot.db.get("ticket_config", guild.id)
        opener = guild.get_member(ticket["user_id"]) or await self._safe_user(ticket["user_id"])

        html_file, text_file = await self._build_files(channel, ticket, opener, closer, reason)

        log_embed = embeds.base(f"{config.E_TICKET} Ticket cerrado", color=config.COLOR_MUTED)
        log_embed.add_field(name="Numero", value=f"#{ticket['number']:04d}", inline=True)
        log_embed.add_field(name="Categoria", value=ticket["category_name"] or "-", inline=True)
        log_embed.add_field(name="Duracion",
                            value=f"<t:{ticket['opened_at']}:R>", inline=True)
        log_embed.add_field(name="Abierto por",
                            value=helpers.fmt_user(opener) if opener else str(ticket["user_id"]),
                            inline=False)
        log_embed.add_field(name="Cerrado por", value=helpers.fmt_user(closer), inline=False)
        if reason:
            log_embed.add_field(name="Motivo", value=helpers.truncate(reason, 500), inline=False)
        await helpers.send_log(self.bot, guild, "tickets", log_embed, file=html_file)

        if opener is not None and cfg["transcript_dm"]:
            dm_embed = embeds.base(
                f"Tu ticket #{ticket['number']:04d} en {guild.name} se ha cerrado",
                "Adjunto tienes la copia completa de la conversacion.",
                config.COLOR_TICKET)
            await helpers.try_dm(opener, embed=dm_embed, file=text_file)
            if cfg["ask_rating"]:
                view = discord.ui.View(timeout=None)
                view.add_item(RateSelect(ticket["id"]))
                await helpers.try_dm(
                    opener,
                    embed=embeds.info("Tu opinion nos ayuda a mejorar la atencion."),
                    view=view)

        archive_id = cfg["archive_category"]
        archive = guild.get_channel(archive_id) if archive_id else None
        if isinstance(archive, discord.CategoryChannel) and isinstance(channel, discord.TextChannel):
            try:
                await channel.edit(category=archive, name=f"cerrado-{ticket['number']:04d}",
                                   overwrites={guild.default_role:
                                               discord.PermissionOverwrite(view_channel=False)},
                                   reason="Ticket cerrado")
                await channel.send(embed=embeds.info("Ticket archivado."))
                return
            except discord.HTTPException:
                pass

        try:
            await channel.send(embed=embeds.info("Este canal se borrara en 8 segundos."))
            await asyncio.sleep(8)
            await channel.delete(reason=f"Ticket cerrado por {closer}")
        except discord.HTTPException:
            pass

    async def _safe_user(self, user_id: int):
        try:
            return await self.bot.fetch_user(user_id)
        except discord.HTTPException:
            return None

    async def _build_files(self, channel, ticket: dict, opener, closer,
                           reason: str | None) -> tuple[discord.File, discord.File]:
        messages = await transcripts.collect_messages(channel)
        title = f"Ticket #{ticket['number']:04d} · {ticket['category_name'] or 'sin categoria'}"
        meta = {
            "Servidor": channel.guild.name,
            "Abierto por": str(opener) if opener else str(ticket["user_id"]),
            "Cerrado por": str(closer),
            "Abierto": time.strftime("%d/%m/%Y %H:%M", time.localtime(ticket["opened_at"])),
            "Cerrado": time.strftime("%d/%m/%Y %H:%M", time.localtime()),
            "Motivo del cierre": reason or "no indicado",
            "Mensajes": str(len(messages)),
        }
        html = transcripts.build_html(messages, title, meta)
        text = transcripts.build_text(messages, title, meta)
        base = f"ticket-{ticket['number']:04d}"
        return (
            discord.File(io.BytesIO(html.encode("utf-8")), filename=f"{base}.html"),
            discord.File(io.BytesIO(text.encode("utf-8")), filename=f"{base}.txt"),
        )

    async def send_transcript(self, interaction: discord.Interaction) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        if not await helpers.is_staff(self.bot, interaction.user):
            await interaction.response.send_message(
                embed=embeds.error("Solo el staff puede pedir el transcript."), ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        opener = interaction.guild.get_member(ticket["user_id"])
        html_file, _ = await self._build_files(interaction.channel, ticket, opener,
                                               interaction.user, "copia en curso")
        await interaction.followup.send(
            embed=embeds.ok("Copia de la conversacion hasta este momento."),
            file=html_file, ephemeral=True)

    async def save_rating(self, interaction: discord.Interaction, ticket_id: int,
                          score: int) -> None:
        row = await self.bot.db.fetchone("SELECT * FROM tickets WHERE id=?", (ticket_id,))
        if row is None or row["user_id"] != interaction.user.id:
            await interaction.response.send_message(
                "Esta encuesta no es tuya.", ephemeral=True)
            return
        await self.bot.db.execute("UPDATE tickets SET rating=? WHERE id=?", (score, ticket_id))
        await interaction.response.edit_message(
            embed=embeds.ok(f"Gracias. Has valorado la atencion con {score} "
                            f"{config.E_STAR}."),
            view=None)

        guild = self.bot.get_guild(row["guild_id"])
        if guild is not None:
            embed = embeds.base("Valoracion recibida", color=config.COLOR_TICKET)
            embed.add_field(name="Ticket", value=f"#{row['number']:04d}", inline=True)
            embed.add_field(name="Nota", value=f"{score}/5", inline=True)
            if row["claimed_by"]:
                embed.add_field(name="Atendido por", value=f"<@{row['claimed_by']}>", inline=True)
            await helpers.send_log(self.bot, guild, "tickets", embed)

    # -- actividad ----------------------------------------------------------
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        """Refresca la ultima actividad para el auto-cierre por inactividad."""
        if message.guild is None or message.author.bot:
            return
        if message.channel.id not in self._channels:
            return
        await self.bot.db.execute(
            "UPDATE tickets SET last_activity=? WHERE channel_id=? AND status='open'",
            (int(time.time()), message.channel.id))
        if await helpers.is_staff(self.bot, message.author):
            await self.bot.db.execute(
                "UPDATE tickets SET first_reply=? WHERE channel_id=? AND status='open' "
                "AND first_reply IS NULL",
                (int(time.time()), message.channel.id))

    @commands.Cog.listener()
    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        if channel.id in self._channels:
            self._channels.discard(channel.id)
            await self.bot.db.execute(
                "UPDATE tickets SET status='deleted', closed_at=? WHERE channel_id=? "
                "AND status='open'", (int(time.time()), channel.id))

    # =====================================================================
    #  COMANDOS DE PANEL
    # =====================================================================
    panel = app_commands.Group(
        name="panel", description="Paneles de tickets.", guild_only=True,
        default_permissions=discord.Permissions(administrator=True))

    @panel.command(name="crear", description="Crea un panel de tickets vacio.")
    @app_commands.describe(nombre="Nombre interno para identificarlo.",
                           titulo="Titulo del embed.", descripcion="Texto del embed.",
                           color="Color en hexadecimal, por ejemplo #9b59b6.",
                           estilo="Botones o menu desplegable.")
    @app_commands.choices(estilo=[
        app_commands.Choice(name="botones", value="buttons"),
        app_commands.Choice(name="menu desplegable", value="select"),
    ])
    @admin_only()
    async def panel_crear(self, interaction: discord.Interaction, nombre: str,
                          titulo: str | None = None, descripcion: str | None = None,
                          color: str | None = None,
                          estilo: app_commands.Choice[str] | None = None) -> None:
        value = self._parse_color(color) or config.COLOR_TICKET
        panel_id = await self.bot.db.execute(
            "INSERT INTO ticket_panels (guild_id, name, title, description, color, style) "
            "VALUES (?,?,?,?,?,?)",
            (interaction.guild.id, nombre[:80], titulo or "Soporte",
             descripcion or "Pulsa el boton para abrir un ticket.", value,
             estilo.value if estilo else "buttons"))
        await interaction.response.send_message(
            embed=embeds.ok(f"Panel **{nombre}** creado con la ID `{panel_id}`.\n"
                            f"Ahora añade categorias con `/panel categoria` y publicalo "
                            f"con `/panel publicar`."),
            ephemeral=True)

    @panel.command(name="lista", description="Lista los paneles del servidor.")
    @admin_only()
    async def panel_lista(self, interaction: discord.Interaction) -> None:
        panels = await self.bot.db.fetchall(
            "SELECT * FROM ticket_panels WHERE guild_id=? ORDER BY id", (interaction.guild.id,))
        if not panels:
            await interaction.response.send_message(
                embed=embeds.info("No hay ningun panel. Crea uno con `/panel crear`."),
                ephemeral=True)
            return
        embed = embeds.base("Paneles de tickets", color=config.COLOR_TICKET)
        for panel in panels:
            cats = await self.bot.db.fetchall(
                "SELECT label FROM ticket_categories WHERE panel_id=?", (panel["id"],))
            estado = "publicado" if panel["message_id"] else "sin publicar"
            embed.add_field(
                name=f"`{panel['id']}` · {panel['name']}",
                value=(f"Titulo: {panel['title']}\nEstilo: {panel['style']}\n"
                       f"Estado: {estado}\n"
                       f"Categorias: {', '.join(c['label'] for c in cats) or 'ninguna'}"),
                inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @panel.command(name="editar", description="Cambia el aspecto de un panel.")
    @app_commands.describe(panel_id="ID del panel (mirala en /panel lista).",
                           titulo="Nuevo titulo.", descripcion="Nueva descripcion.",
                           color="Color hexadecimal.", imagen="URL de la imagen grande.",
                           miniatura="URL de la miniatura.", pie="Texto del pie.")
    @admin_only()
    async def panel_editar(self, interaction: discord.Interaction, panel_id: int,
                           titulo: str | None = None, descripcion: str | None = None,
                           color: str | None = None, imagen: str | None = None,
                           miniatura: str | None = None, pie: str | None = None) -> None:
        panel = await self._panel(interaction.guild.id, panel_id)
        if panel is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese panel no existe."), ephemeral=True)
            return
        updates, params = [], []
        for value, column in ((titulo, "title"), (descripcion, "description"),
                              (imagen, "image"), (miniatura, "thumbnail"), (pie, "footer")):
            if value is not None:
                updates.append(f"{column}=?")
                params.append(value)
        if color is not None:
            parsed = self._parse_color(color)
            if parsed is None:
                await interaction.response.send_message(
                    embed=embeds.error("Color no valido. Usa formato `#5865F2`."), ephemeral=True)
                return
            updates.append("color=?")
            params.append(parsed)
        if not updates:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos un campo a cambiar."), ephemeral=True)
            return
        params.append(panel_id)
        await self.bot.db.execute(
            f"UPDATE ticket_panels SET {', '.join(updates)} WHERE id=?", params)
        await interaction.response.send_message(
            embed=embeds.ok("Panel actualizado. Vuelve a publicarlo para ver los cambios."),
            ephemeral=True)

    @panel.command(name="categoria", description="Añade una categoria de ticket a un panel.")
    @app_commands.describe(panel_id="ID del panel.", nombre="Texto del boton u opcion.",
                           categoria="Categoria de Discord donde se crearan los canales.",
                           rol_staff="Rol que podra ver estos tickets.",
                           emoji="Emoji del boton.", descripcion="Descripcion corta.",
                           mensaje="Mensaje que se muestra al abrir el ticket.",
                           usar_hilos="Crear hilos privados en vez de canales.")
    @admin_only()
    async def panel_categoria(self, interaction: discord.Interaction, panel_id: int,
                              nombre: str, categoria: discord.CategoryChannel | None = None,
                              rol_staff: discord.Role | None = None,
                              emoji: str | None = None, descripcion: str | None = None,
                              mensaje: str | None = None, usar_hilos: bool = False) -> None:
        panel = await self._panel(interaction.guild.id, panel_id)
        if panel is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese panel no existe."), ephemeral=True)
            return
        count = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM ticket_categories WHERE panel_id=?", (panel_id,), 0)
        if count >= 20:
            await interaction.response.send_message(
                embed=embeds.error("Un panel admite como maximo 20 categorias."), ephemeral=True)
            return

        category_id = await self.bot.db.execute(
            "INSERT INTO ticket_categories (panel_id, guild_id, label, emoji, description, "
            "category_id, staff_role, open_message, use_threads, position) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (panel_id, interaction.guild.id, nombre[:80], emoji, descripcion,
             categoria.id if categoria else None, rol_staff.id if rol_staff else None,
             mensaje, int(usar_hilos), count))
        await interaction.response.send_message(
            embed=embeds.ok(f"Categoria **{nombre}** añadida (ID `{category_id}`).\n"
                            f"Puedes añadirle preguntas con `/panel pregunta`."),
            ephemeral=True)

    @panel.command(name="quitarcategoria", description="Borra una categoria de un panel.")
    @app_commands.describe(categoria_id="ID de la categoria (mirala en /panel lista).")
    @admin_only()
    async def panel_quitar_categoria(self, interaction: discord.Interaction,
                                     categoria_id: int) -> None:
        row = await self.bot.db.fetchone(
            "SELECT * FROM ticket_categories WHERE id=? AND guild_id=?",
            (categoria_id, interaction.guild.id))
        if row is None:
            await interaction.response.send_message(
                embed=embeds.error("Esa categoria no existe."), ephemeral=True)
            return
        await self.bot.db.execute("DELETE FROM ticket_categories WHERE id=?", (categoria_id,))
        await interaction.response.send_message(
            embed=embeds.ok(f"Categoria **{row['label']}** borrada. Vuelve a publicar el panel."),
            ephemeral=True)

    @panel.command(name="pregunta", description="Añade una pregunta al formulario de una categoria.")
    @app_commands.describe(categoria_id="ID de la categoria.", pregunta="Texto de la pregunta.",
                           ayuda="Texto de ejemplo dentro del campo.",
                           larga="True para una caja de texto grande.",
                           obligatoria="Si el usuario debe responderla.")
    @admin_only()
    async def panel_pregunta(self, interaction: discord.Interaction, categoria_id: int,
                             pregunta: str, ayuda: str | None = None,
                             larga: bool = False, obligatoria: bool = True) -> None:
        row = await self.bot.db.fetchone(
            "SELECT * FROM ticket_categories WHERE id=? AND guild_id=?",
            (categoria_id, interaction.guild.id))
        if row is None:
            await interaction.response.send_message(
                embed=embeds.error("Esa categoria no existe."), ephemeral=True)
            return
        count = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM ticket_questions WHERE category_id=?", (categoria_id,), 0)
        if count >= 5:
            await interaction.response.send_message(
                embed=embeds.error("Discord solo permite 5 preguntas por formulario."),
                ephemeral=True)
            return
        await self.bot.db.execute(
            "INSERT INTO ticket_questions (category_id, label, placeholder, style, required, "
            "position) VALUES (?,?,?,?,?,?)",
            (categoria_id, pregunta[:45], ayuda, "long" if larga else "short",
             int(obligatoria), count))
        await interaction.response.send_message(
            embed=embeds.ok(f"Pregunta añadida ({count + 1}/5)."), ephemeral=True)

    @panel.command(name="preguntas", description="Lista y borra preguntas de una categoria.")
    @app_commands.describe(categoria_id="ID de la categoria.",
                           borrar_id="ID de la pregunta que quieres borrar.")
    @admin_only()
    async def panel_preguntas(self, interaction: discord.Interaction, categoria_id: int,
                              borrar_id: int | None = None) -> None:
        if borrar_id is not None:
            await self.bot.db.execute(
                "DELETE FROM ticket_questions WHERE id=? AND category_id=?",
                (borrar_id, categoria_id))
        rows = await self.bot.db.fetchall(
            "SELECT * FROM ticket_questions WHERE category_id=? ORDER BY position, id",
            (categoria_id,))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("Esa categoria no tiene preguntas: el ticket se abrira "
                                  "directamente."), ephemeral=True)
            return
        texto = "\n".join(
            f"`{r['id']}` · {r['label']}" + ("" if r["required"] else " *(opcional)*")
            for r in rows)
        await interaction.response.send_message(
            embed=embeds.base("Preguntas del formulario", texto, config.COLOR_TICKET),
            ephemeral=True)

    @panel.command(name="publicar", description="Publica el panel en un canal.")
    @app_commands.describe(panel_id="ID del panel.", canal="Canal donde publicarlo.")
    @admin_only()
    async def panel_publicar(self, interaction: discord.Interaction, panel_id: int,
                             canal: discord.TextChannel) -> None:
        panel = await self._panel(interaction.guild.id, panel_id)
        if panel is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese panel no existe."), ephemeral=True)
            return
        categories = await self.bot.db.fetchall(
            "SELECT * FROM ticket_categories WHERE panel_id=? ORDER BY position, id",
            (panel_id,))
        if not categories:
            await interaction.response.send_message(
                embed=embeds.error("Añade al menos una categoria antes de publicar."),
                ephemeral=True)
            return

        embed = embeds.base(panel["title"], panel["description"], panel["color"])
        if panel["image"]:
            embed.set_image(url=panel["image"])
        if panel["thumbnail"]:
            embed.set_thumbnail(url=panel["thumbnail"])
        if panel["footer"]:
            embed.set_footer(text=panel["footer"])

        view = discord.ui.View(timeout=None)
        if panel["style"] == "select":
            options = [
                discord.SelectOption(
                    label=c["label"][:100], value=str(c["id"]),
                    description=(c["description"] or None),
                    emoji=c["emoji"] or None)
                for c in categories[:25]
            ]
            view.add_item(PanelSelect(panel_id, options))
        else:
            for cat in categories[:25]:
                view.add_item(OpenTicketButton(cat["id"], cat["label"], cat["emoji"] or None))

        try:
            message = await canal.send(embed=embed, view=view)
        except discord.Forbidden:
            await interaction.response.send_message(
                embed=embeds.error(f"No puedo escribir en {canal.mention}."), ephemeral=True)
            return

        # Borra la publicacion anterior para no dejar paneles zombis.
        if panel["channel_id"] and panel["message_id"]:
            old = interaction.guild.get_channel(panel["channel_id"])
            if old is not None:
                try:
                    await (await old.fetch_message(panel["message_id"])).delete()
                except discord.HTTPException:
                    pass

        await self.bot.db.execute(
            "UPDATE ticket_panels SET channel_id=?, message_id=? WHERE id=?",
            (canal.id, message.id, panel_id))
        await interaction.response.send_message(
            embed=embeds.ok(f"Panel publicado en {canal.mention}."), ephemeral=True)

    @panel.command(name="borrar", description="Borra un panel y sus categorias.")
    @app_commands.describe(panel_id="ID del panel.")
    @admin_only()
    async def panel_borrar(self, interaction: discord.Interaction, panel_id: int) -> None:
        panel = await self._panel(interaction.guild.id, panel_id)
        if panel is None:
            await interaction.response.send_message(
                embed=embeds.error("Ese panel no existe."), ephemeral=True)
            return
        await self.bot.db.execute("DELETE FROM ticket_panels WHERE id=?", (panel_id,))
        await self.bot.db.execute("DELETE FROM ticket_categories WHERE panel_id=?", (panel_id,))
        await interaction.response.send_message(
            embed=embeds.ok(f"Panel **{panel['name']}** borrado."), ephemeral=True)

    async def _panel(self, guild_id: int, panel_id: int) -> dict | None:
        return await self.bot.db.fetchone(
            "SELECT * FROM ticket_panels WHERE id=? AND guild_id=?", (panel_id, guild_id))

    @staticmethod
    def _parse_color(text: str | None) -> int | None:
        if not text:
            return None
        try:
            return int(text.lstrip("#"), 16)
        except ValueError:
            return None

    # =====================================================================
    #  COMANDOS DE TICKET
    # =====================================================================
    ticket = app_commands.Group(name="ticket", description="Gestion de tickets.",
                                guild_only=True)

    @ticket.command(name="cerrar", description="Cierra el ticket de este canal.")
    @app_commands.describe(razon="Motivo del cierre.")
    async def ticket_cerrar(self, interaction: discord.Interaction,
                            razon: str | None = None) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        if interaction.user.id != ticket["user_id"] and \
                not await helpers.is_staff(self.bot, interaction.user):
            await interaction.response.send_message(
                embed=embeds.error("No puedes cerrar este ticket."), ephemeral=True)
            return
        await interaction.response.send_message(embed=embeds.info("Cerrando el ticket..."))
        await self.close_ticket(interaction.channel, interaction.user, razon)

    @ticket.command(name="agregar", description="Añade a alguien al ticket.")
    @app_commands.describe(usuario="Persona a añadir.")
    @staff_only()
    async def ticket_add(self, interaction: discord.Interaction,
                         usuario: discord.Member) -> None:
        if await self._ticket_of(interaction.channel_id) is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        if isinstance(interaction.channel, discord.Thread):
            await interaction.channel.add_user(usuario)
        else:
            await interaction.channel.set_permissions(
                usuario, view_channel=True, send_messages=True, read_message_history=True,
                reason=f"añadido por {interaction.user}")
        await interaction.response.send_message(
            embed=embeds.ok(f"{usuario.mention} añadido al ticket."))

    @ticket.command(name="quitar", description="Saca a alguien del ticket.")
    @app_commands.describe(usuario="Persona a quitar.")
    @staff_only()
    async def ticket_remove(self, interaction: discord.Interaction,
                            usuario: discord.Member) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        if usuario.id == ticket["user_id"]:
            await interaction.response.send_message(
                embed=embeds.error("No puedes sacar al autor del ticket."), ephemeral=True)
            return
        if isinstance(interaction.channel, discord.Thread):
            await interaction.channel.remove_user(usuario)
        else:
            await interaction.channel.set_permissions(usuario, overwrite=None,
                                                      reason=f"quitado por {interaction.user}")
        await interaction.response.send_message(
            embed=embeds.ok(f"{usuario.mention} ya no tiene acceso al ticket."))

    @ticket.command(name="renombrar", description="Cambia el nombre del canal del ticket.")
    @app_commands.describe(nombre="Nuevo nombre.")
    @staff_only()
    async def ticket_rename(self, interaction: discord.Interaction, nombre: str) -> None:
        if await self._ticket_of(interaction.channel_id) is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        await interaction.channel.edit(name=nombre[:100], reason=f"{interaction.user}")
        await interaction.response.send_message(
            embed=embeds.ok(f"Canal renombrado a `{nombre}`."))

    @ticket.command(name="prioridad", description="Marca la urgencia del ticket.")
    @app_commands.choices(nivel=PRIORITY_CHOICES)
    @staff_only()
    async def ticket_priority(self, interaction: discord.Interaction,
                              nivel: app_commands.Choice[str]) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        emoji, color = config.PRIORITIES[nivel.value]
        await self.bot.db.execute("UPDATE tickets SET priority=? WHERE id=?",
                                  (nivel.value, ticket["id"]))
        try:
            await interaction.channel.edit(
                name=f"{emoji}-ticket-{ticket['number']:04d}"[:100],
                reason=f"prioridad {nivel.value}")
        except discord.HTTPException:
            pass
        await interaction.response.send_message(
            embed=embeds.base(f"{emoji} Prioridad: {nivel.value.upper()}", color=color))

    @ticket.command(name="transferir", description="Pasa el ticket a otro miembro del staff.")
    @app_commands.describe(usuario="Nuevo responsable.")
    @staff_only()
    async def ticket_transfer(self, interaction: discord.Interaction,
                              usuario: discord.Member) -> None:
        ticket = await self._ticket_of(interaction.channel_id)
        if ticket is None:
            await interaction.response.send_message(
                embed=embeds.error("Este canal no es un ticket abierto."), ephemeral=True)
            return
        await self.bot.db.execute("UPDATE tickets SET claimed_by=? WHERE id=?",
                                  (usuario.id, ticket["id"]))
        await interaction.response.send_message(
            embed=embeds.ok(f"Ticket transferido a {usuario.mention}."))

    @ticket.command(name="bloquear", description="Impide que alguien abra tickets.")
    @app_commands.describe(usuario="Usuario a bloquear.", razon="Motivo.")
    @staff_only()
    async def ticket_block(self, interaction: discord.Interaction, usuario: discord.User,
                           razon: str | None = None) -> None:
        await self.bot.db.execute(
            "INSERT INTO ticket_blacklist (guild_id, user_id, reason, added_by) VALUES (?,?,?,?) "
            "ON CONFLICT(guild_id, user_id) DO UPDATE SET reason=excluded.reason",
            (interaction.guild.id, usuario.id, razon, interaction.user.id))
        await interaction.response.send_message(
            embed=embeds.ok(f"**{usuario}** ya no puede abrir tickets."), ephemeral=True)

    @ticket.command(name="desbloquear", description="Permite de nuevo abrir tickets.")
    @app_commands.describe(usuario="Usuario a desbloquear.")
    @staff_only()
    async def ticket_unblock(self, interaction: discord.Interaction,
                             usuario: discord.User) -> None:
        await self.bot.db.execute(
            "DELETE FROM ticket_blacklist WHERE guild_id=? AND user_id=?",
            (interaction.guild.id, usuario.id))
        await interaction.response.send_message(
            embed=embeds.ok(f"**{usuario}** vuelve a poder abrir tickets."), ephemeral=True)

    @ticket.command(name="stats", description="Estadisticas del sistema de tickets.")
    @staff_only()
    async def ticket_stats(self, interaction: discord.Interaction) -> None:
        guild_id = interaction.guild.id
        total = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM tickets WHERE guild_id=?", (guild_id,), 0)
        abiertos = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM tickets WHERE guild_id=? AND status='open'", (guild_id,), 0)
        media = await self.bot.db.fetchval(
            "SELECT AVG(rating) FROM tickets WHERE guild_id=? AND rating IS NOT NULL",
            (guild_id,), None)
        respuesta = await self.bot.db.fetchval(
            "SELECT AVG(first_reply - opened_at) FROM tickets WHERE guild_id=? "
            "AND first_reply IS NOT NULL", (guild_id,), None)
        staff = await self.bot.db.fetchall(
            "SELECT claimed_by, COUNT(*) AS total FROM tickets WHERE guild_id=? "
            "AND claimed_by IS NOT NULL GROUP BY claimed_by ORDER BY total DESC LIMIT 10",
            (guild_id,))

        embed = embeds.base(f"{config.E_TICKET} Estadisticas de tickets",
                            color=config.COLOR_TICKET)
        embed.add_field(name="Total", value=str(total), inline=True)
        embed.add_field(name="Abiertos ahora", value=str(abiertos), inline=True)
        embed.add_field(name="Valoracion media",
                        value=f"{media:.2f}/5" if media else "sin datos", inline=True)
        embed.add_field(name="Primera respuesta (media)",
                        value=f"{int(respuesta // 60)} min" if respuesta else "sin datos",
                        inline=True)
        if staff:
            embed.add_field(
                name="Tickets atendidos",
                value="\n".join(f"<@{r['claimed_by']}> — **{r['total']}**" for r in staff),
                inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @ticket.command(name="lista", description="Tickets abiertos ahora mismo.")
    @staff_only()
    async def ticket_list(self, interaction: discord.Interaction) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT * FROM tickets WHERE guild_id=? AND status='open' ORDER BY number",
            (interaction.guild.id,))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("No hay ningun ticket abierto."), ephemeral=True)
            return
        pages = []
        for group in helpers.chunk(rows, 10):
            embed = embeds.base(f"Tickets abiertos ({len(rows)})", color=config.COLOR_TICKET)
            for row in group:
                emoji = config.PRIORITIES.get(row["priority"], ("", 0))[0]
                claimed = f"<@{row['claimed_by']}>" if row["claimed_by"] else "sin atender"
                embed.add_field(
                    name=f"{emoji} #{row['number']:04d} · {row['category_name'] or '-'}",
                    value=f"<#{row['channel_id']}> · <@{row['user_id']}> · {claimed}\n"
                          f"Abierto <t:{row['opened_at']}:R>",
                    inline=False)
            pages.append(embed)
        await send_pages(interaction, pages, ephemeral=True)

    @ticket.command(name="config", description="Ajustes generales del sistema de tickets.")
    @app_commands.describe(maximo="Tickets abiertos a la vez por usuario (0 = sin limite).",
                           transcript_dm="Enviar el transcript por privado al cerrar.",
                           valoracion="Pedir una valoracion al cerrar.",
                           autocierre="Horas de inactividad antes de cerrar solo (0 = nunca).",
                           archivo="Categoria donde archivar en vez de borrar el canal.")
    @admin_only()
    async def ticket_config(self, interaction: discord.Interaction,
                            maximo: app_commands.Range[int, 0, 20] | None = None,
                            transcript_dm: bool | None = None,
                            valoracion: bool | None = None,
                            autocierre: app_commands.Range[int, 0, 720] | None = None,
                            archivo: discord.CategoryChannel | None = None) -> None:
        values = {}
        if maximo is not None:
            values["max_open"] = maximo
        if transcript_dm is not None:
            values["transcript_dm"] = int(transcript_dm)
        if valoracion is not None:
            values["ask_rating"] = int(valoracion)
        if autocierre is not None:
            values["autoclose_hours"] = autocierre
        if archivo is not None:
            values["archive_category"] = archivo.id
        if not values:
            cfg = await self.bot.db.get("ticket_config", interaction.guild.id)
            embed = embeds.base("Configuracion de tickets", color=config.COLOR_TICKET)
            embed.add_field(name="Maximo por usuario", value=str(cfg["max_open"]), inline=True)
            embed.add_field(name="Transcript por DM",
                            value="si" if cfg["transcript_dm"] else "no", inline=True)
            embed.add_field(name="Pedir valoracion",
                            value="si" if cfg["ask_rating"] else "no", inline=True)
            embed.add_field(name="Auto-cierre",
                            value=(f"{cfg['autoclose_hours']}h" if cfg["autoclose_hours"]
                                   else "desactivado"), inline=True)
            embed.add_field(name="Categoria de archivo",
                            value=(f"<#{cfg['archive_category']}>" if cfg["archive_category"]
                                   else "se borra el canal"), inline=True)
            await interaction.response.send_message(embed=embed, ephemeral=True)
            return
        await self.bot.db.set("ticket_config", interaction.guild.id, **values)
        await interaction.response.send_message(
            embed=embeds.ok("Configuracion de tickets actualizada."), ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Tickets(bot))
