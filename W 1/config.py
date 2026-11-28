"""Constantes globales.

Todo lo que sea "estetico" o un valor por defecto vive aqui, para no tener
que buscarlo repartido por los cogs cuando quieras cambiar un color o un
emoji.  Los ajustes que cambian POR SERVIDOR no estan aqui: esos viven en la
base de datos y se editan con /config desde Discord.
"""

# --- Colores ---------------------------------------------------------------
COLOR_PRIMARY = 0x5865F2
COLOR_OK = 0x2ECC71
COLOR_WARN = 0xF1C40F
COLOR_ERROR = 0xE74C3C
COLOR_INFO = 0x3498DB
COLOR_MOD = 0xE67E22
COLOR_SECURITY = 0x992D22
COLOR_TICKET = 0x9B59B6
COLOR_MUTED = 0x2B2D31

# --- Emojis ----------------------------------------------------------------
E_OK = "✅"
E_ERROR = "❌"
E_WARN = "⚠️"
E_INFO = "ℹ️"
E_LOCK = "\U0001f512"
E_UNLOCK = "\U0001f513"
E_SHIELD = "\U0001f6e1️"
E_TICKET = "\U0001f3ab"
E_TRASH = "\U0001f5d1️"
E_HAMMER = "\U0001f528"
E_BOOT = "\U0001f462"
E_MUTE = "\U0001f507"
E_STAR = "⭐"
E_CLOCK = "⏰"
E_FIRE = "\U0001f525"

# --- Categorias de log -----------------------------------------------------
# Clave interna -> nombre legible.  Cada categoria puede tener su propio canal.
LOG_CATEGORIES = {
    "mensajes": "Mensajes editados, borrados y purgas",
    "miembros": "Entradas, salidas, apodos, roles y avatares",
    "servidor": "Canales, roles, emojis, webhooks e invitaciones",
    "voz": "Actividad en canales de voz",
    "moderacion": "Sanciones aplicadas (casos)",
    "tickets": "Apertura y cierre de tickets + transcripts",
    "seguridad": "Anti-nuke, anti-raid y anti-spam",
}

# --- Prioridades de ticket -------------------------------------------------
PRIORITIES = {
    "baja": ("\U0001f7e2", 0x2ECC71),
    "media": ("\U0001f7e1", 0xF1C40F),
    "alta": ("\U0001f7e0", 0xE67E22),
    "urgente": ("\U0001f534", 0xE74C3C),
}

# --- Permisos considerados "peligrosos" por el anti-nuke -------------------
DANGEROUS_PERMISSIONS = (
    "administrator",
    "manage_guild",
    "manage_roles",
    "manage_channels",
    "manage_webhooks",
    "ban_members",
    "kick_members",
    "mention_everyone",
    "manage_messages",
)

# --- Varios ----------------------------------------------------------------
MAX_TRANSCRIPT_MESSAGES = 2000   # techo para no comerse la memoria
DB_BACKUP_KEEP = 14              # cuantas copias del .db se conservan
XP_COOLDOWN = 60                 # segundos entre mensajes que dan XP
