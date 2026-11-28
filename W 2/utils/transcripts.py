"""Generacion de transcripts de ticket en HTML y en texto plano.

El HTML es autocontenido (CSS en linea, sin recursos externos salvo los
avatares y adjuntos que sirve el propio CDN de Discord), asi que se puede
abrir desde el disco o adjuntar a un mensaje sin depender de ningun servicio.
"""

from __future__ import annotations

import html
import re
from datetime import timezone

import discord

import config

_HTML_HEAD = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:#313338; color:#dbdee1;
         font-family:"gg sans","Segoe UI",Helvetica,Arial,sans-serif; font-size:15px; }}
  .wrap {{ max-width:900px; margin:0 auto; padding:24px 16px 64px; }}
  header {{ border-bottom:1px solid #3f4147; padding-bottom:16px; margin-bottom:20px; }}
  header h1 {{ margin:0 0 6px; font-size:22px; color:#fff; }}
  header p {{ margin:2px 0; color:#b5bac1; font-size:13px; }}
  .meta {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px 20px; margin-top:12px; }}
  .meta div span {{ color:#949ba4; }}
  .msg {{ display:flex; gap:14px; padding:8px 4px; border-radius:6px; }}
  .msg:hover {{ background:#2e3035; }}
  .avatar {{ width:40px; height:40px; border-radius:50%; flex:0 0 40px; background:#1e1f22; }}
  .body {{ min-width:0; flex:1; }}
  .name {{ font-weight:600; color:#f2f3f5; }}
  .bot {{ background:#5865f2; color:#fff; font-size:10px; padding:1px 4px; border-radius:3px;
          margin-left:6px; vertical-align:middle; }}
  .time {{ color:#949ba4; font-size:12px; margin-left:8px; }}
  .content {{ white-space:pre-wrap; word-wrap:break-word; overflow-wrap:anywhere; margin-top:2px; }}
  .embed {{ border-left:4px solid #5865f2; background:#2b2d31; border-radius:4px;
            padding:8px 12px; margin:6px 0; max-width:520px; }}
  .embed .etitle {{ font-weight:600; color:#fff; }}
  .embed .efield {{ margin-top:6px; }}
  .embed .efield b {{ display:block; color:#fff; font-size:14px; }}
  .att {{ display:block; margin-top:4px; }}
  .att img {{ max-width:400px; border-radius:6px; }}
  .sys {{ color:#949ba4; font-style:italic; }}
  code {{ background:#1e1f22; padding:1px 4px; border-radius:3px; font-family:Consolas,monospace; }}
  a {{ color:#00a8fc; text-decoration:none; }}
  footer {{ margin-top:32px; padding-top:14px; border-top:1px solid #3f4147;
            color:#949ba4; font-size:12px; text-align:center; }}
</style>
</head>
<body><div class="wrap">
"""

_MD_CODE = re.compile(r"`([^`\n]+)`")
_MD_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_MD_ITALIC = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")
_MD_LINK = re.compile(r"(https?://[^\s<]+)")


def _render(text: str) -> str:
    """Escapa el texto y traduce el markdown basico de Discord a HTML."""
    out = html.escape(text or "")
    out = _MD_CODE.sub(r"<code>\1</code>", out)
    out = _MD_BOLD.sub(r"<b>\1</b>", out)
    out = _MD_ITALIC.sub(r"<i>\1</i>", out)
    out = _MD_LINK.sub(r'<a href="\1" target="_blank" rel="noopener">\1</a>', out)
    return out


def _embed_html(embed: discord.Embed) -> str:
    color = f"#{embed.color.value:06x}" if embed.color else "#5865f2"
    parts = [f'<div class="embed" style="border-left-color:{color}">']
    if embed.author and embed.author.name:
        parts.append(f'<div class="etitle">{html.escape(embed.author.name)}</div>')
    if embed.title:
        parts.append(f'<div class="etitle">{html.escape(embed.title)}</div>')
    if embed.description:
        parts.append(f'<div class="content">{_render(embed.description)}</div>')
    for field in embed.fields:
        parts.append(
            f'<div class="efield"><b>{html.escape(field.name)}</b>'
            f'<div class="content">{_render(field.value)}</div></div>'
        )
    if embed.image and embed.image.url:
        parts.append(f'<div class="att"><img src="{html.escape(embed.image.url)}" alt=""></div>')
    if embed.footer and embed.footer.text:
        parts.append(f'<div class="time">{html.escape(embed.footer.text)}</div>')
    parts.append("</div>")
    return "".join(parts)


async def collect_messages(channel: discord.abc.Messageable,
                           limit: int = config.MAX_TRANSCRIPT_MESSAGES) -> list[discord.Message]:
    messages: list[discord.Message] = []
    async for message in channel.history(limit=limit, oldest_first=True):
        messages.append(message)
    return messages


def build_html(messages: list[discord.Message], title: str,
               meta: dict[str, str]) -> str:
    parts = [_HTML_HEAD.format(title=html.escape(title))]
    parts.append(f"<header><h1>{html.escape(title)}</h1><div class='meta'>")
    for key, value in meta.items():
        parts.append(f"<div><span>{html.escape(key)}:</span> {html.escape(str(value))}</div>")
    parts.append("</div></header>")

    for message in messages:
        stamp = message.created_at.astimezone(timezone.utc).strftime("%d/%m/%Y %H:%M")
        avatar = message.author.display_avatar.replace(size=64, static_format="png").url
        bot_tag = '<span class="bot">BOT</span>' if message.author.bot else ""
        parts.append('<div class="msg">')
        parts.append(f'<img class="avatar" src="{html.escape(avatar)}" alt="">')
        parts.append('<div class="body">')
        parts.append(
            f'<div><span class="name">{html.escape(str(message.author.display_name))}</span>'
            f'{bot_tag}<span class="time">{stamp}</span></div>'
        )
        if message.content:
            parts.append(f'<div class="content">{_render(message.content)}</div>')
        for embed in message.embeds:
            parts.append(_embed_html(embed))
        for att in message.attachments:
            if att.content_type and att.content_type.startswith("image/"):
                parts.append(
                    f'<div class="att"><img src="{html.escape(att.url)}" alt=""></div>'
                )
            else:
                parts.append(
                    f'<div class="att"><a href="{html.escape(att.url)}" target="_blank" '
                    f'rel="noopener">{html.escape(att.filename)}</a></div>'
                )
        parts.append("</div></div>")

    parts.append(
        f"<footer>{len(messages)} mensajes · transcript generado automaticamente</footer>"
    )
    parts.append("</div></body></html>")
    return "".join(parts)


def build_text(messages: list[discord.Message], title: str, meta: dict[str, str]) -> str:
    lines = [title, "=" * len(title)]
    lines += [f"{k}: {v}" for k, v in meta.items()]
    lines.append("")
    for message in messages:
        stamp = message.created_at.astimezone(timezone.utc).strftime("%d/%m/%Y %H:%M")
        lines.append(f"[{stamp}] {message.author} ({message.author.id}):")
        if message.content:
            lines.append(f"    {message.content}")
        for embed in message.embeds:
            if embed.title:
                lines.append(f"    [embed] {embed.title}")
            if embed.description:
                lines.append(f"    [embed] {embed.description}")
            for field in embed.fields:
                lines.append(f"    [embed] {field.name}: {field.value}")
        for att in message.attachments:
            lines.append(f"    [adjunto] {att.filename} -> {att.url}")
        lines.append("")
    lines.append(f"-- {len(messages)} mensajes --")
    return "\n".join(lines)
