"""Eventos adicionales de log + /eventos para activarlos o desactivarlos.
No toca cogs/logs.py: los eventos ya existentes siguen alli, sin duplicarse."""

from __future__ import annotations

import functools
import logging

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, eventtrack as et, helpers
from utils.checks import admin_only, staff_only

log = logging.getLogger("bot.eventlogs")
EVENT_CHOICES = [app_commands.Choice(name=k, value=k) for k in et.EVENTS]


def safe(func):
    """Un fallo al registrar un evento nunca debe propagarse."""
    @functools.wraps(func)
    async def wrapper(self, *args, **kwargs):
        try:
            return await func(self, *args, **kwargs)
        except Exception:
            log.exception("Fallo en el listener %s", func.__name__)
    return wrapper


class EventLogs(commands.Cog, name="Eventos de log"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.dedupe = et.Deduper()

    # ------------------------------------------------------------ hilos
    @commands.Cog.listener()
    @safe
    async def on_thread_update(self, before: discord.Thread, after: discord.Thread) -> None:
        changes = et.diff_attrs(before, after, et.THREAD_ATTRS)
        if not changes or self.dedupe.seen(("thread", after.id, tuple(c[2] for c in changes))):
            return
        embed = et.change_embed("Hilo modificado", config.COLOR_INFO, changes)
        embed.add_field(name="Hilo", value=after.mention, inline=True)
        await et.emit(self.bot, after.guild, "thread_update", embed, channel=after.parent)

    @commands.Cog.listener()
    @safe
    async def on_thread_member_join(self, member: discord.ThreadMember) -> None:
        await self._thread_member(member, "Entra a un hilo", config.COLOR_OK)

    @commands.Cog.listener()
    @safe
    async def on_thread_member_remove(self, member: discord.ThreadMember) -> None:
        await self._thread_member(member, "Sale de un hilo", config.COLOR_MUTED)

    async def _thread_member(self, tm, title, color) -> None:
        thread = tm.thread
        embed = embeds.base(title, color=color)
        embed.add_field(name="Hilo", value=thread.mention, inline=True)
        embed.add_field(name="Usuario", value=f"<@{tm.id}> (`{tm.id}`)", inline=True)
        await et.emit(self.bot, thread.guild, "thread_member", embed, channel=thread.parent)

    # ------------------------------------------------------------ stage
    @commands.Cog.listener()
    @safe
    async def on_stage_instance_create(self, stage: discord.StageInstance) -> None:
        embed = embeds.base("Stage iniciado", color=config.COLOR_OK)
        embed.add_field(name="Canal", value=stage.channel.mention, inline=True)
        embed.add_field(name="Tema", value=helpers.truncate(stage.topic, 300), inline=False)
        await et.emit(self.bot, stage.guild, "stage", embed, channel=stage.channel)

    @commands.Cog.listener()
    @safe
    async def on_stage_instance_update(self, before, after: discord.StageInstance) -> None:
        changes = et.diff_attrs(before, after, {"topic": "Tema"})
        if not changes:
            return
        embed = et.change_embed("Stage editado", config.COLOR_INFO, changes)
        embed.add_field(name="Canal", value=after.channel.mention, inline=True)
        await et.emit(self.bot, after.guild, "stage", embed, channel=after.channel)

    @commands.Cog.listener()
    @safe
    async def on_stage_instance_delete(self, stage: discord.StageInstance) -> None:
        embed = embeds.base("Stage terminado", color=config.COLOR_MUTED)
        embed.add_field(name="Canal", value=stage.channel.mention, inline=True)
        embed.add_field(name="Tema", value=helpers.truncate(stage.topic, 300), inline=False)
        await et.emit(self.bot, stage.guild, "stage", embed, channel=stage.channel)

    # ------------------------------------------------ eventos programados
    def _sched_embed(self, title, color, ev) -> discord.Embed:
        embed = embeds.base(title, color=color)
        embed.add_field(name="Evento", value=helpers.truncate(ev.name, 200), inline=False)
        if getattr(ev, "start_time", None):
            embed.add_field(name="Inicio", value=helpers.ts(ev.start_time, "F"), inline=True)
        if getattr(ev, "creator", None) is not None:
            embed.add_field(name="Creador", value=helpers.fmt_user(ev.creator), inline=False)
        return embed

    @commands.Cog.listener()
    @safe
    async def on_scheduled_event_create(self, ev: discord.ScheduledEvent) -> None:
        if self.dedupe.seen(("sev_c", ev.id)):
            return
        await et.emit(self.bot, ev.guild, "scheduled_event",
                      self._sched_embed("Evento programado creado", config.COLOR_OK, ev))

    @commands.Cog.listener()
    @safe
    async def on_scheduled_event_update(self, before, after: discord.ScheduledEvent) -> None:
        changes = et.diff_attrs(before, after, et.EVENT_ATTRS)
        if not changes or self.dedupe.seen(("sev_u", after.id, tuple(c[2] for c in changes))):
            return
        embed = et.change_embed("Evento programado editado", config.COLOR_INFO, changes)
        embed.add_field(name="Evento", value=helpers.truncate(after.name, 200), inline=False)
        await et.emit(self.bot, after.guild, "scheduled_event", embed)

    @commands.Cog.listener()
    @safe
    async def on_scheduled_event_delete(self, ev: discord.ScheduledEvent) -> None:
        if self.dedupe.seen(("sev_d", ev.id)):
            return
        await et.emit(self.bot, ev.guild, "scheduled_event",
                      self._sched_embed("Evento programado borrado", config.COLOR_ERROR, ev))

    # ------------------------------------------------------------ automod
    async def _rule(self, rule: discord.AutoModRule, title, color, audit) -> None:
        if self.dedupe.seen(("rule", title, rule.id)):
            return
        embed = embeds.base(title, color=color)
        embed.add_field(name="Regla", value=helpers.truncate(rule.name, 200), inline=True)
        embed.add_field(name="Activa", value="si" if rule.enabled else "no", inline=True)
        entry = await helpers.find_audit(rule.guild, audit, rule.id)
        by = entry.user if entry is not None and entry.user is not None else None
        embed.add_field(name="Por", value=helpers.fmt_user(by), inline=False)
        await et.emit(self.bot, rule.guild, "automod_rule", embed)

    @commands.Cog.listener()
    @safe
    async def on_automod_rule_create(self, rule: discord.AutoModRule) -> None:
        await self._rule(rule, "Regla de AutoMod creada", config.COLOR_OK,
                         discord.AuditLogAction.auto_moderation_rule_create)

    @commands.Cog.listener()
    @safe
    async def on_automod_rule_update(self, rule: discord.AutoModRule) -> None:
        await self._rule(rule, "Regla de AutoMod editada", config.COLOR_INFO,
                         discord.AuditLogAction.auto_moderation_rule_update)

    @commands.Cog.listener()
    @safe
    async def on_automod_rule_delete(self, rule: discord.AutoModRule) -> None:
        await self._rule(rule, "Regla de AutoMod borrada", config.COLOR_ERROR,
                         discord.AuditLogAction.auto_moderation_rule_delete)

    @commands.Cog.listener()
    @safe
    async def on_automod_action(self, execution: discord.AutoModAction) -> None:
        if self.dedupe.seen(("amx", execution.guild.id, execution.user_id,
                             execution.message_id, execution.rule_id)):
            return
        embed = embeds.base(f"{config.E_SHIELD} AutoMod actuo", color=config.COLOR_SECURITY)
        embed.add_field(name="Usuario", value=f"<@{execution.user_id}> (`{execution.user_id}`)", inline=False)
        embed.add_field(name="Accion", value=str(getattr(execution.action.type, "name", execution.action.type)), inline=True)
        embed.add_field(name="Regla", value=f"`{execution.rule_id}`", inline=True)
        if execution.channel_id:
            embed.add_field(name="Canal", value=f"<#{execution.channel_id}>", inline=True)
        if execution.matched_keyword:
            embed.add_field(name="Coincidencia", value=helpers.truncate(execution.matched_keyword, 200), inline=False)
        if execution.content:
            embed.add_field(name="Contenido", value=helpers.truncate(execution.content, 500), inline=False)
        await et.emit(self.bot, execution.guild, "automod_action", embed,
                      channel=execution.guild.get_channel(execution.channel_id or 0),
                      member=execution.member)

    # ---------------------------------------------------- reacciones, pines
    @commands.Cog.listener()
    @safe
    async def on_raw_reaction_clear(self, payload: discord.RawReactionClearEvent) -> None:
        await self._reaction_clear(payload, None)

    @commands.Cog.listener()
    @safe
    async def on_raw_reaction_clear_emoji(self, payload: discord.RawReactionClearEmojiEvent) -> None:
        await self._reaction_clear(payload, str(payload.emoji))

    async def _reaction_clear(self, payload, emoji) -> None:
        guild = self.bot.get_guild(payload.guild_id) if payload.guild_id else None
        if guild is None or self.dedupe.seen(("rclr", payload.message_id, emoji)):
            return
        embed = embeds.base("Reacciones eliminadas", color=config.COLOR_WARN)
        embed.add_field(name="Mensaje", value=f"[Ir al mensaje](https://discord.com/channels/"
                        f"{guild.id}/{payload.channel_id}/{payload.message_id})", inline=True)
        embed.add_field(name="Canal", value=f"<#{payload.channel_id}>", inline=True)
        embed.add_field(name="Emoji", value=emoji or "todas", inline=True)
        await et.emit(self.bot, guild, "reaction_clear", embed,
                      channel=guild.get_channel(payload.channel_id))

    @commands.Cog.listener()
    @safe
    async def on_guild_channel_pins_update(self, channel, last_pin) -> None:
        guild = getattr(channel, "guild", None)
        if guild is None or self.dedupe.seen(("pins", channel.id, last_pin)):
            return
        embed = embeds.base("Pines actualizados", color=config.COLOR_INFO)
        embed.add_field(name="Canal", value=channel.mention, inline=True)
        embed.add_field(name="Ultimo pin", value=helpers.ts(last_pin, "R"), inline=True)
        await et.emit(self.bot, guild, "pins", embed, channel=channel)

    # ----------------------------------------------------------------- voz
    @commands.Cog.listener()
    @safe
    async def on_voice_state_update(self, member, before, after) -> None:
        channel = after.channel or before.channel
        for key, changes, title, color in (
            ("voice_server", et.voice_server_changes(before, after), "Voz moderada", config.COLOR_WARN),
            ("voice_stream", et.voice_stream_changes(before, after), "Transmision en voz", config.COLOR_MUTED),
        ):
            if not changes or not await et.is_enabled(self.bot, member.guild.id, key):
                continue
            if self.dedupe.seen((key, member.id, tuple(changes))):
                continue
            embed = embeds.base(title, color=color)
            embeds.author_field(embed, member)
            embed.add_field(name="Cambio", value="\n".join(changes), inline=False)
            if channel is not None:
                embed.add_field(name="Canal", value=channel.mention, inline=True)
            if key == "voice_server":
                entry = await helpers.find_audit(
                    member.guild, discord.AuditLogAction.member_update, member.id)
                if entry is not None and entry.user is not None:
                    embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
            await et.emit(self.bot, member.guild, key, embed, channel=channel, member=member)

    # ------------------------------------------------------------ miembros
    @commands.Cog.listener()
    @safe
    async def on_member_update(self, before: discord.Member, after: discord.Member) -> None:
        guild = after.guild
        if before.premium_since != after.premium_since:
            started = after.premium_since is not None
            embed = embeds.base("Nuevo boost" if started else "Boost retirado",
                                color=config.COLOR_OK if started else config.COLOR_MUTED)
            embeds.author_field(embed, after)
            if not self.dedupe.seen(("boost", after.id, started)):
                await et.emit(self.bot, guild, "boost", embed)
        if before.timed_out_until and not after.timed_out_until \
                and not self.dedupe.seen(("untimeout", after.id)):
            embed = embeds.base(f"{config.E_OK} Aislamiento retirado", color=config.COLOR_OK)
            embeds.author_field(embed, after)
            entry = await helpers.find_audit(guild, discord.AuditLogAction.member_update, after.id)
            if entry is not None and entry.user is not None:
                embed.add_field(name="Por", value=helpers.fmt_user(entry.user), inline=False)
            else:
                embed.add_field(name="Por", value="desconocido o caducado", inline=False)
            await et.emit(self.bot, guild, "timeout_removed", embed)

    # ------------------------------------------------------------ comandos
    eventos = app_commands.Group(
        name="eventos", description="Eventos adicionales de los logs.", guild_only=True)

    @eventos.command(name="listar", description="Estado de los eventos adicionales.")
    @staff_only()
    async def listar(self, interaction: discord.Interaction) -> None:
        state = await et.status(self.bot, interaction.guild.id)
        lines = [f"{'🟢' if on else '⚫'} `{k}` → **{et.EVENTS[k][1]}** · {et.EVENTS[k][0]}"
                 for k, on in state.items()]
        embed = embeds.base("Eventos adicionales de log", "\n".join(lines), config.COLOR_PRIMARY)
        embed.set_footer(text="Se envian al canal de su categoria (/config logs). Sin canal, no se envia.")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @eventos.command(name="activar", description="Activa un evento adicional.")
    @app_commands.describe(evento="Evento a activar.")
    @app_commands.choices(evento=EVENT_CHOICES)
    @admin_only()
    async def activar(self, interaction: discord.Interaction, evento: app_commands.Choice[str]) -> None:
        await self._toggle(interaction, evento.value, True)

    @eventos.command(name="desactivar", description="Desactiva un evento adicional.")
    @app_commands.describe(evento="Evento a desactivar.")
    @app_commands.choices(evento=EVENT_CHOICES)
    @admin_only()
    async def desactivar(self, interaction: discord.Interaction, evento: app_commands.Choice[str]) -> None:
        await self._toggle(interaction, evento.value, False)

    async def _toggle(self, interaction, key: str, enabled: bool) -> None:
        if not await et.set_enabled(self.bot, interaction.guild.id, key, enabled):
            await interaction.response.send_message(embed=embeds.error("Evento desconocido."), ephemeral=True)
            return
        cat = et.EVENTS[key][1]
        extra = ""
        if enabled:
            channels = await self.bot.db.get_log_channels(interaction.guild.id)
            if not helpers.log_channel_candidates(channels, cat):
                extra = f" Aviso: la categoria **{cat}** no tiene canal; no se enviara nada hasta configurarlo."
        await interaction.response.send_message(
            embed=embeds.ok(f"Evento `{key}` {'activado' if enabled else 'desactivado'}.{extra}"),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(EventLogs(bot))
