"""Generacion de imagenes con Pillow: banner de bienvenida y captcha.

Si Pillow no esta instalado o no hay ninguna fuente utilizable, las funciones
devuelven None y el cog que las llama envia solo texto.
"""

from __future__ import annotations

import io
import os
import random

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    PIL_AVAILABLE = True
except Exception:                                    # pragma: no cover
    PIL_AVAILABLE = False

CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # sin I, O, 0, 1

_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)


def _font(size: int):
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size)          # Pillow >= 10.1
    except Exception:
        return ImageFont.load_default()


def _centered(draw, box, text, font, fill):
    x0, y0, x1, y1 = box
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    x = x0 + (x1 - x0 - (right - left)) / 2 - left
    y = y0 + (y1 - y0 - (bottom - top)) / 2 - top
    draw.text((x, y), text, font=font, fill=fill)


# --- Bienvenida ------------------------------------------------------------
def welcome_banner(avatar_bytes: bytes | None, username: str, guild_name: str,
                   member_count: int, goodbye: bool = False) -> io.BytesIO | None:
    if not PIL_AVAILABLE:
        return None

    width, height = 900, 300
    accent = (231, 76, 60) if goodbye else (88, 101, 242)

    card = Image.new("RGB", (width, height), (32, 34, 37))
    draw = ImageDraw.Draw(card)

    # Degradado suave de fondo hacia el color de acento.
    for y in range(height):
        ratio = y / height
        draw.line(
            [(0, y), (width, y)],
            fill=(
                int(32 + accent[0] * 0.18 * ratio),
                int(34 + accent[1] * 0.18 * ratio),
                int(37 + accent[2] * 0.18 * ratio),
            ),
        )
    draw.rectangle([0, 0, width, 6], fill=accent)
    draw.rectangle([0, height - 6, width, height], fill=accent)

    # Avatar recortado en circulo, con aro del color de acento.
    if avatar_bytes:
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA").resize((160, 160))
            mask = Image.new("L", (160, 160), 0)
            ImageDraw.Draw(mask).ellipse([0, 0, 160, 160], fill=255)
            draw.ellipse([56, 66, 224, 234], fill=accent)
            card.paste(avatar, (60, 70), mask)
        except Exception:
            pass

    title = "ADIOS" if goodbye else "BIENVENIDO"
    draw.text((250, 82), title, font=_font(30), fill=accent)
    name = username if len(username) <= 22 else username[:21] + "…"
    draw.text((250, 122), name, font=_font(42), fill=(255, 255, 255))
    subtitle = (f"Ya no esta en {guild_name}" if goodbye
                else f"Miembro numero {member_count} de {guild_name}")
    if len(subtitle) > 46:
        subtitle = subtitle[:45] + "…"
    draw.text((250, 182), subtitle, font=_font(22), fill=(185, 187, 190))

    buffer = io.BytesIO()
    card.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer


# --- Captcha ---------------------------------------------------------------
def new_captcha_code(length: int = 6) -> str:
    return "".join(random.choice(CAPTCHA_ALPHABET) for _ in range(length))


def captcha_image(code: str) -> io.BytesIO | None:
    if not PIL_AVAILABLE:
        return None

    width, height = 320, 120
    image = Image.new("RGB", (width, height), (43, 45, 49))
    draw = ImageDraw.Draw(image)

    for _ in range(600):
        draw.point(
            (random.randint(0, width), random.randint(0, height)),
            fill=tuple(random.randint(50, 90) for _ in range(3)),
        )
    for _ in range(6):
        draw.line(
            [
                (random.randint(0, width), random.randint(0, height)),
                (random.randint(0, width), random.randint(0, height)),
            ],
            fill=tuple(random.randint(70, 130) for _ in range(3)),
            width=2,
        )

    font = _font(56)
    step = width // (len(code) + 1)
    for index, char in enumerate(code):
        layer = Image.new("RGBA", (70, 90), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text(
            (10, 10), char, font=font,
            fill=(random.randint(180, 255), random.randint(180, 255), random.randint(180, 255)),
        )
        layer = layer.rotate(random.randint(-28, 28), resample=Image.BICUBIC, expand=False)
        image.paste(layer, (step * (index + 1) - 40, random.randint(6, 24)), layer)

    image = image.filter(ImageFilter.SMOOTH)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return buffer
