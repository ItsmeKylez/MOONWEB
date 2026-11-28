"""Anti-spam y filtro de contenido.

Funciona con un sistema de puntos ("calor"): cada infraccion suma puntos que
se van enfriando con el tiempo. El castigo depende del total acumulado, no de
una sola infraccion, asi que un desliz no expulsa a nadie pero un ataque
sostenido si.
"""

from __future__ import annotations

import logging
import re
import time
from collections import defaultdict, deque
from datetime import timedelta

import discord
from discord import app_commands
from discord.ext import commands

import config
from utils import embeds, helpers, modlog
from utils.checks import admin_only, staff_only

log = logging.getLogger("bot.antispam")

# Puntos que suma cada tipo de infraccion.
POINTS = {
    "rate": 3,
    "duplicados": 3,
    "menciones": 4,
    "everyone": 4,
    "mayusculas": 1,
    "emojis": 1,
    "saltos": 1,
    "adjuntos": 2,
    "invitacion": 4,
    "enlace": 2,
    "caracteres": 2,
    "palabra": 3,
}


class AntiSpam(commands.Cog, name="Anti-spam"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._heat: dict[tuple[int, int], tuple[float, float]] = {}
        self._recent: dict[tuple[int, int], deque] = defaultdict(lambda: deque(maxlen=15))
        self._words: dict[int, list[tuple[re.Pattern, str]]] = {}

    # -- calor --------------------------------------------------------------
    def _add_heat(self, guild_id: int, user_id: int, amount: int, decay: int) -> float:
        key = (guild_id, user_id)
        now = time.time()
        points, last = self._heat.get(key, (0.0, now))
        if decay > 0:
            points = max(0.0, points - (now - last) / decay)
        points += amount
        self._heat[key] = (points, now)
        return points

    def _reset_heat(self, guild_id: int, user_id: int) -> None:
        self._heat.pop((guild_id, user_id), None)
        self._recent.pop((guild_id, user_id), None)

    # -- filtro de palabras -------------------------------------------------
    async def _patterns(self, guild_id: int) -> list[tuple[re.Pattern, str]]:
        cached = self._words.get(guild_id)
        if cached is not None:
            return cached
        rows = await self.bot.db.fetchall(
            "SELECT word, is_regex FROM filtered_words WHERE guild_id=?", (guild_id,))
        patterns: list[tuple[re.Pattern, str]] = []
        for row in rows:
            word = row["word"]
            try:
                if row["is_regex"]:
                    patterns.append((re.compile(word, re.I), word))
                else:
                    # Se compara contra el texto normalizado, que ya viene sin
                    # separadores ni sustituciones tipo 4 -> a.
                    patterns.append((re.compile(re.escape(helpers.normalize(word))), word))
            except re.error:
                continue
        self._words[guild_id] = patterns
        return patterns

    def invalidate_words(self, guild_id: int) -> None:
        self._words.pop(guild_id, None)

    # =====================================================================
    #  ANALISIS
    # =====================================================================
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot:
            return
        if not isinstance(message.author, discord.Member):
            return

        cfg = await self.bot.db.get("antispam_config", message.guild.id)
        if not cfg["enabled"]:
            return
        if await helpers.is_staff(self.bot, message.author):
            return
        if await helpers.is_ignored(self.bot, message.guild.id, message.channel, message.author):
            return

        violations = await self._inspect(message, cfg)
        if not violations:
            return

        points = sum(POINTS[v] for v in violations)
        total = self._add_heat(message.guild.id, message.author.id, points, cfg["decay"])

        if cfg["delete_message"]:
            try:
                await message.delete()
            except discord.HTTPException:
                pass

        await self._enforce(message, cfg, violations, total)

    async def _inspect(self, message: discord.Message, cfg: dict) -> list[str]:
        content = message.content or ""
        found: list[str] = []
        key = (message.guild.id, message.author.id)
        now = time.time()

        history = self._recent[key]
        history.append((now, content, message.channel.id))

        # Ritmo de mensajes.
        window_start = now - cfg["msg_window"]
        recent = [entry for entry in history if entry[0] >= window_start]
        if len(recent) > cfg["msg_rate"]:
            found.append("rate")

        # Mensajes repetidos o casi identicos.
        if content and cfg["dup_limit"] > 0:
            similar = sum(1 for _, text, _ in recent
                          if text and helpers.similarity(text, content) > 0.9)
            if similar >= cfg["dup_limit"]:
                found.append("duplicados")

        # Menciones.
        mentions = len(message.mentions) + len(message.role_mentions)
        if cfg["mention_limit"] > 0 and mentions >= cfg["mention_limit"]:
            found.append("menciones")
        if cfg["block_everyone"] and ("@everyone" in content or "@here" in content) \
                and not message.author.guild_permissions.mention_everyone:
            found.append("everyone")

        # Formato del mensaje.
        if cfg["caps_percent"] > 0 and len(content) >= cfg["caps_min_len"] \
                and helpers.caps_ratio(content) * 100 >= cfg["caps_percent"]:
            found.append("mayusculas")
        if cfg["emoji_limit"] > 0 and helpers.count_emojis(content) > cfg["emoji_limit"]:
            found.append("emojis")
        if cfg["newline_limit"] > 0 and content.count("\n") > cfg["newline_limit"]:
            found.append("saltos")
        if cfg["attach_limit"] > 0 and len(message.attachments) > cfg["attach_limit"]:
            found.append("adjuntos")

        # Enlaces.
        if cfg["block_invites"] and helpers.INVITE_RE.search(content):
            found.append("invitacion")
        elif cfg["block_links"] and helpers.URL_RE.search(content):
            found.append("enlace")

        # Caracteres raros.
        if cfg["block_zalgo"] and (len(helpers.ZALGO_RE.findall(content)) > 8
                                   or helpers.INVISIBLE_RE.search(content)):
            found.append("caracteres")

        # Palabras prohibidas.
        patterns = await self._patterns(message.guild.id)
        if patterns and content:
            normalized = helpers.normalize(content)
            for pattern, original in patterns:
                if pattern.search(normalized) or pattern.search(content):
                    found.append("palabra")
                    break

        return found

    async def _enforce(self, message: discord.Message, cfg: dict,
                       violations: list[str], total: float) -> None:
        member = message.author
        guild = message.guild
        reason = f"Anti-spam: {', '.join(violations)} ({int(total)} puntos)"
        action = None

        if cfg["ban_at"] and total >= cfg["ban_at"]:
            action = "ban"
        elif cfg["kick_at"] and total >= cfg["kick_at"]:
            action = "kick"
        elif cfg["mute_at"] and total >= cfg["mute_at"]:
            action = "timeout"
        elif cfg["warn_at"] and total >= cfg["warn_at"]:
            action = "warn"

        if action is None:
            return

        try:
            if action == "ban":
                await guild.ban(member, reason=reason, delete_message_seconds=3600)
            elif action == "kick":
                await member.kick(reason=reason)
            elif action == "timeout":
                await member.timeout(timedelta(minutes=cfg["mute_minutes"]), reason=reason)
        except discord.HTTPException:
            log.warning("No se pudo aplicar %s a %s", action, member.id)
            return

        duration = cfg["mute_minutes"] * 60 if action == "timeout" else None
        await modlog.create_case(self.bot, guild, action, member, self.bot.user,
                                 reason, duration)
        self._reset_heat(guild.id, member.id)

        if action == "warn":
            try:
                await message.channel.send(
                    f"{member.mention} baja el ritmo: **{', '.join(violations)}**.",
                    delete_after=8)
            except discord.HTTPException:
                pass

        embed = embeds.base(f"{config.E_SHIELD} Anti-spam", color=config.COLOR_SECURITY)
        embeds.author_field(embed, member)
        embed.add_field(name="Canal", value=message.channel.mention, inline=True)
        embed.add_field(name="Puntos", value=str(int(total)), inline=True)
        embed.add_field(name="Accion", value=action, inline=True)
        embed.add_field(name="Infracciones", value=", ".join(violations), inline=False)
        embed.add_field(name="Mensaje",
                        value=helpers.truncate(message.content, 500), inline=False)
        await helpers.send_log(self.bot, guild, "seguridad", embed)

    # =====================================================================
    #  COMANDOS
    # =====================================================================
    antispam = app_commands.Group(
        name="antispam", description="Control de spam y contenido.",
        guild_only=True, default_permissions=discord.Permissions(administrator=True))

    @antispam.command(name="estado", description="Muestra la configuracion del anti-spam.")
    @admin_only()
    async def estado(self, interaction: discord.Interaction) -> None:
        cfg = await self.bot.db.get("antispam_config", interaction.guild.id)
        words = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM filtered_words WHERE guild_id=?",
            (interaction.guild.id,), 0)
        activo = "ACTIVADO" if cfg["enabled"] else "DESACTIVADO"
        embed = embeds.base(f"{config.E_SHIELD} Anti-spam: {activo}",
                            color=config.COLOR_SECURITY if cfg["enabled"] else config.COLOR_MUTED)
        embed.add_field(
            name="Limites",
            value=(f"Ritmo: {cfg['msg_rate']} mensajes / {cfg['msg_window']}s\n"
                   f"Repetidos: {cfg['dup_limit']}\n"
                   f"Menciones: {cfg['mention_limit']}\n"
                   f"Mayusculas: {cfg['caps_percent']}% (min. {cfg['caps_min_len']} letras)\n"
                   f"Emojis: {cfg['emoji_limit']}\n"
                   f"Saltos de linea: {cfg['newline_limit']}\n"
                   f"Adjuntos: {cfg['attach_limit']}"),
            inline=False)
        embed.add_field(
            name="Bloqueos",
            value=(f"Invitaciones: {'si' if cfg['block_invites'] else 'no'}\n"
                   f"Enlaces: {'si' if cfg['block_links'] else 'no'}\n"
                   f"@everyone: {'si' if cfg['block_everyone'] else 'no'}\n"
                   f"Texto corrupto: {'si' if cfg['block_zalgo'] else 'no'}\n"
                   f"Palabras filtradas: {words}"),
            inline=False)
        embed.add_field(
            name="Castigos por puntos",
            value=(f"Aviso: {cfg['warn_at']}\nAislamiento: {cfg['mute_at']} "
                   f"({cfg['mute_minutes']} min)\nExpulsion: {cfg['kick_at']}\n"
                   f"Baneo: {cfg['ban_at']}\nUn punto se enfria cada {cfg['decay']}s"),
            inline=False)
        embed.set_footer(text="El staff y los canales ignorados no se analizan.")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @antispam.command(name="activar", description="Activa o desactiva el anti-spam.")
    @app_commands.describe(activo="True para activarlo.")
    @admin_only()
    async def activar(self, interaction: discord.Interaction, activo: bool) -> None:
        await self.bot.db.set("antispam_config", interaction.guild.id, enabled=int(activo))
        await interaction.response.send_message(
            embed=embeds.ok(f"Anti-spam **{'activado' if activo else 'desactivado'}**."),
            ephemeral=True)

    @antispam.command(name="limites", description="Ajusta los limites de deteccion.")
    @app_commands.describe(
        ritmo="Mensajes permitidos por ventana.", ventana="Segundos de la ventana.",
        repetidos="Mensajes iguales seguidos permitidos.", menciones="Menciones por mensaje.",
        mayusculas="Porcentaje de mayusculas (0 desactiva).", emojis="Emojis por mensaje.",
        saltos="Saltos de linea por mensaje.", adjuntos="Archivos por mensaje.")
    @admin_only()
    async def limites(self, interaction: discord.Interaction,
                      ritmo: app_commands.Range[int, 0, 30] | None = None,
                      ventana: app_commands.Range[int, 1, 60] | None = None,
                      repetidos: app_commands.Range[int, 0, 20] | None = None,
                      menciones: app_commands.Range[int, 0, 50] | None = None,
                      mayusculas: app_commands.Range[int, 0, 100] | None = None,
                      emojis: app_commands.Range[int, 0, 100] | None = None,
                      saltos: app_commands.Range[int, 0, 100] | None = None,
                      adjuntos: app_commands.Range[int, 0, 10] | None = None) -> None:
        values = {}
        for value, column in ((ritmo, "msg_rate"), (ventana, "msg_window"),
                              (repetidos, "dup_limit"), (menciones, "mention_limit"),
                              (mayusculas, "caps_percent"), (emojis, "emoji_limit"),
                              (saltos, "newline_limit"), (adjuntos, "attach_limit")):
            if value is not None:
                values[column] = value
        if not values:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos un limite."), ephemeral=True)
            return
        await self.bot.db.set("antispam_config", interaction.guild.id, **values)
        await interaction.response.send_message(
            embed=embeds.ok(f"{len(values)} limite(s) actualizados."), ephemeral=True)

    @antispam.command(name="bloqueos", description="Que tipos de contenido se bloquean.")
    @app_commands.describe(invitaciones="Bloquear invitaciones a otros servidores.",
                           enlaces="Bloquear cualquier enlace.",
                           everyone="Bloquear intentos de @everyone.",
                           texto_corrupto="Bloquear zalgo y caracteres invisibles.",
                           borrar="Borrar el mensaje infractor.")
    @admin_only()
    async def bloqueos(self, interaction: discord.Interaction,
                       invitaciones: bool | None = None, enlaces: bool | None = None,
                       everyone: bool | None = None, texto_corrupto: bool | None = None,
                       borrar: bool | None = None) -> None:
        values = {}
        for value, column in ((invitaciones, "block_invites"), (enlaces, "block_links"),
                              (everyone, "block_everyone"), (texto_corrupto, "block_zalgo"),
                              (borrar, "delete_message")):
            if value is not None:
                values[column] = int(value)
        if not values:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos una opcion."), ephemeral=True)
            return
        await self.bot.db.set("antispam_config", interaction.guild.id, **values)
        await interaction.response.send_message(
            embed=embeds.ok("Bloqueos actualizados."), ephemeral=True)

    @antispam.command(name="castigos", description="Puntos necesarios para cada castigo.")
    @app_commands.describe(aviso="Puntos para avisar.", aislar="Puntos para aislar.",
                           expulsar="Puntos para expulsar.", banear="Puntos para banear.",
                           minutos="Minutos de aislamiento.",
                           enfriamiento="Segundos que tarda en bajar un punto.")
    @admin_only()
    async def castigos(self, interaction: discord.Interaction,
                       aviso: app_commands.Range[int, 0, 100] | None = None,
                       aislar: app_commands.Range[int, 0, 100] | None = None,
                       expulsar: app_commands.Range[int, 0, 100] | None = None,
                       banear: app_commands.Range[int, 0, 100] | None = None,
                       minutos: app_commands.Range[int, 1, 10080] | None = None,
                       enfriamiento: app_commands.Range[int, 5, 3600] | None = None) -> None:
        values = {}
        for value, column in ((aviso, "warn_at"), (aislar, "mute_at"), (expulsar, "kick_at"),
                              (banear, "ban_at"), (minutos, "mute_minutes"),
                              (enfriamiento, "decay")):
            if value is not None:
                values[column] = value
        if not values:
            await interaction.response.send_message(
                embed=embeds.error("Indica al menos un valor."), ephemeral=True)
            return
        await self.bot.db.set("antispam_config", interaction.guild.id, **values)
        await interaction.response.send_message(
            embed=embeds.ok("Umbrales actualizados."), ephemeral=True)

    # -- filtro de palabras -------------------------------------------------
    palabra = app_commands.Group(
        name="palabra", description="Filtro de palabras prohibidas.",
        guild_only=True, default_permissions=discord.Permissions(manage_messages=True))

    @palabra.command(name="agregar", description="Prohibe una palabra o una expresion regular.")
    @app_commands.describe(texto="Palabra a prohibir.",
                           es_regex="True si lo que escribes es una expresion regular.")
    @staff_only()
    async def palabra_add(self, interaction: discord.Interaction, texto: str,
                          es_regex: bool = False) -> None:
        if es_regex:
            try:
                re.compile(texto)
            except re.error as exc:
                await interaction.response.send_message(
                    embed=embeds.error(f"Expresion invalida: `{exc}`"), ephemeral=True)
                return
        await self.bot.db.execute(
            "INSERT INTO filtered_words (guild_id, word, is_regex) VALUES (?,?,?)",
            (interaction.guild.id, texto.lower()[:200], int(es_regex)))
        self.invalidate_words(interaction.guild.id)
        await interaction.response.send_message(
            embed=embeds.ok(f"`{texto}` añadida al filtro."), ephemeral=True)

    @palabra.command(name="quitar", description="Quita una palabra del filtro.")
    @app_commands.describe(texto="Palabra exacta tal y como la añadiste.")
    @staff_only()
    async def palabra_del(self, interaction: discord.Interaction, texto: str) -> None:
        await self.bot.db.execute(
            "DELETE FROM filtered_words WHERE guild_id=? AND word=?",
            (interaction.guild.id, texto.lower()))
        self.invalidate_words(interaction.guild.id)
        await interaction.response.send_message(
            embed=embeds.ok(f"`{texto}` retirada del filtro."), ephemeral=True)

    @palabra.command(name="lista", description="Muestra las palabras filtradas.")
    @staff_only()
    async def palabra_list(self, interaction: discord.Interaction) -> None:
        rows = await self.bot.db.fetchall(
            "SELECT word, is_regex FROM filtered_words WHERE guild_id=? ORDER BY word",
            (interaction.guild.id,))
        if not rows:
            await interaction.response.send_message(
                embed=embeds.info("No hay ninguna palabra filtrada."), ephemeral=True)
            return
        texto = "\n".join(f"`{r['word']}`" + (" *(regex)*" if r["is_regex"] else "")
                          for r in rows)
        await interaction.response.send_message(
            embed=embeds.base(f"Palabras filtradas ({len(rows)})",
                              helpers.truncate(texto, 3500), config.COLOR_SECURITY),
            ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(AntiSpam(bot))
