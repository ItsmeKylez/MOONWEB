"""Description of every setting the dashboard can edit.

One table drives both sides: the API validates incoming values against it and
the browser renders the forms from it, so adding a setting to the bot only
needs one new line here.

Field kinds:  bool | int | enum | role | channel | category | text | longtext
              | regex | color
"""

from __future__ import annotations

import re
from typing import Any


def F(key, label, kind, help="", **extra):
    return {"key": key, "label": label, "kind": kind, "help": help, **extra}


ACTIONS = [["none", "Do nothing"], ["quarantine", "Quarantine"],
           ["kick", "Kick"], ["ban", "Ban"]]

SECTIONS: dict[str, dict] = {
    "general": {
        "table": "guild_config",
        "title": "General",
        "intro": "Roles the bot relies on and how it treats punished members.",
        "groups": [
            ("Roles", [
                F("staff_role", "Staff role", "role", "Can use moderation commands."),
                F("admin_role", "Admin role", "role",
                  "Can use admin commands and this dashboard, on top of real administrators."),
                F("quarantine_role", "Quarantine role", "role",
                  "Given to members the bot quarantines."),
                F("verified_role", "Verified role", "role", "Given after verification."),
                F("autorole", "Auto role", "role", "Given to every new member."),
            ]),
            ("Behavior", [
                F("dm_on_punish", "DM members when punished", "bool",
                  "Send a private message with the reason."),
                F("embed_color", "Embed color", "color", "Color of the bot's embeds."),
            ]),
        ],
    },
    "antinuke": {
        "table": "antinuke_config",
        "title": "Anti-nuke",
        "intro": "Stops anyone from mass-deleting channels, roles or members, and undoes the damage.",
        "groups": [
            ("Protection", [
                F("enabled", "Anti-nuke enabled", "bool"),
                F("punishment", "Punishment", "enum", "What happens to whoever trips a limit.",
                  options=[["strip", "Remove all roles"], ["kick", "Kick"], ["ban", "Ban"]]),
                F("window", "Time window (seconds)", "int", "Actions are counted inside this window.",
                  min=10, max=3600),
                F("alert_owner", "Alert the server owner", "bool"),
                F("restore", "Restore deleted channels and roles", "bool"),
            ]),
            ("Limits per window", [
                F("lim_channel_delete", "Channels deleted", "int", min=1, max=50),
                F("lim_channel_create", "Channels created", "int", min=1, max=50),
                F("lim_role_delete", "Roles deleted", "int", min=1, max=50),
                F("lim_role_create", "Roles created", "int", min=1, max=50),
                F("lim_ban", "Bans", "int", min=1, max=50),
                F("lim_kick", "Kicks", "int", min=1, max=50),
                F("lim_webhook", "Webhooks created", "int", min=1, max=50),
                F("lim_emoji_delete", "Emojis deleted", "int", min=1, max=50),
                F("lim_perm_update", "Permission changes", "int", min=1, max=50),
            ]),
            ("Blocks", [
                F("block_dangerous_roles", "Block dangerous permissions on roles", "bool"),
                F("block_bots", "Block unapproved bots", "bool"),
                F("block_guild_update", "Block server setting changes", "bool"),
            ]),
        ],
    },
    "antiraid": {
        "table": "antiraid_config",
        "title": "Anti-raid",
        "intro": "Detects join waves and filters suspicious accounts.",
        "groups": [
            ("Detection", [
                F("enabled", "Anti-raid enabled", "bool"),
                F("join_count", "Joins that count as a raid", "int", min=2, max=100),
                F("join_window", "Within (seconds)", "int", min=2, max=300),
                F("panic", "Panic mode", "bool", "Treat every new member as a raider until turned off."),
            ]),
            ("Filters", [
                F("min_age_days", "Minimum account age (days)", "int", "0 turns the filter off.",
                  min=0, max=365),
                F("age_action", "Action on young accounts", "enum", options=ACTIONS),
                F("no_avatar_action", "Action on default avatars", "enum", options=ACTIONS),
                F("name_regex", "Blocked name pattern", "regex",
                  "Regular expression matched against usernames."),
            ]),
            ("Response", [
                F("raid_action", "Action on raiders", "enum", options=ACTIONS),
                F("lockdown", "Lock channels during a raid", "bool"),
                F("lockdown_minutes", "Lockdown length (minutes)", "int", min=1, max=1440),
                F("alert_role", "Role to ping", "role"),
            ]),
        ],
    },
    "antispam": {
        "table": "antispam_config",
        "title": "Anti-spam",
        "intro": "Gives each offense points, then escalates the punishment as they add up.",
        "groups": [
            ("Protection", [
                F("enabled", "Anti-spam enabled", "bool"),
                F("delete_message", "Delete offending messages", "bool"),
                F("decay", "Points fade after (seconds)", "int", min=5, max=3600),
            ]),
            ("Detection", [
                F("msg_rate", "Messages per window", "int", min=2, max=50),
                F("msg_window", "Window (seconds)", "int", min=1, max=60),
                F("dup_limit", "Repeated messages", "int", min=2, max=30),
                F("mention_limit", "Mentions per message", "int", min=2, max=50),
                F("caps_percent", "Capital letters (%)", "int", min=30, max=100),
                F("caps_min_len", "Minimum length for caps check", "int", min=3, max=200),
                F("emoji_limit", "Emojis per message", "int", min=2, max=100),
                F("newline_limit", "Line breaks per message", "int", min=2, max=100),
                F("attach_limit", "Attachments per message", "int", min=1, max=20),
            ]),
            ("Content rules", [
                F("block_invites", "Block Discord invites", "bool"),
                F("block_links", "Block all links", "bool"),
                F("block_everyone", "Block @everyone and @here", "bool"),
                F("block_zalgo", "Block glitch text", "bool"),
            ]),
            ("Escalation (points)", [
                F("warn_at", "Warn at", "int", min=1, max=200),
                F("mute_at", "Mute at", "int", min=1, max=200),
                F("kick_at", "Kick at", "int", min=1, max=500),
                F("ban_at", "Ban at", "int", min=1, max=1000),
                F("mute_minutes", "Mute length (minutes)", "int", min=1, max=40320),
            ]),
        ],
    },
    "welcome": {
        "table": "welcome_config",
        "title": "Welcome & goodbye",
        "intro": "Greet new members. Placeholders: {mention} {user} {server} {count}.",
        "groups": [
            ("Welcome message", [
                F("welcome_enabled", "Welcome enabled", "bool"),
                F("welcome_channel", "Channel", "channel"),
                F("welcome_message", "Message", "longtext", max=1500),
                F("welcome_image", "Attach a banner image", "bool"),
            ]),
            ("Goodbye message", [
                F("goodbye_enabled", "Goodbye enabled", "bool"),
                F("goodbye_channel", "Channel", "channel"),
                F("goodbye_message", "Message", "longtext", max=1500),
            ]),
            ("Direct message", [
                F("dm_enabled", "DM new members", "bool"),
                F("dm_message", "Message", "longtext", max=1500),
            ]),
        ],
    },
    "levels": {
        "table": "level_config",
        "title": "Levels",
        "intro": "Members earn XP by chatting, at most once a minute.",
        "groups": [
            ("Levels", [
                F("enabled", "Levels enabled", "bool"),
                F("announce", "Announce level-ups", "bool"),
                F("channel_id", "Announcement channel", "channel",
                  "Leave empty to announce in the channel where they chatted."),
                F("xp_min", "XP per message (min)", "int", min=1, max=500),
                F("xp_max", "XP per message (max)", "int", min=1, max=500),
            ]),
        ],
    },
    "tickets": {
        "table": "ticket_config",
        "title": "Ticket settings",
        "intro": "Global rules for every ticket panel.",
        "groups": [
            ("Rules", [
                F("max_open", "Open tickets per member", "int", min=1, max=20),
                F("autoclose_hours", "Close after inactivity (hours)", "int", "0 turns it off.",
                  min=0, max=720),
                F("archive_category", "Archive category", "category",
                  "Closed tickets move here."),
            ]),
            ("After closing", [
                F("transcript_dm", "DM the transcript to the member", "bool"),
                F("ask_rating", "Ask for a rating", "bool"),
            ]),
        ],
    },
}


def fields_of(section: str) -> dict[str, dict]:
    return {f["key"]: f for _, fs in SECTIONS[section]["groups"] for f in fs}


class ValidationError(ValueError):
    pass


def clean(field: dict, value: Any, guild) -> Any:
    """Validate one value and return what should be stored in SQLite."""
    kind = field["kind"]
    label = field["label"]

    if kind == "bool":
        if not isinstance(value, bool):
            raise ValidationError(f"{label}: expected on or off.")
        return int(value)

    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValidationError(f"{label}: expected a whole number.")
        if not field["min"] <= value <= field["max"]:
            raise ValidationError(f"{label}: must be between {field['min']} and {field['max']}.")
        return value

    if kind == "enum":
        if value not in {o[0] for o in field["options"]}:
            raise ValidationError(f"{label}: pick one of the listed options.")
        return value

    if kind in ("role", "channel", "category"):
        if value in (None, ""):
            return None
        try:
            ident = int(value)
        except (TypeError, ValueError):
            raise ValidationError(f"{label}: invalid selection.")
        if kind == "role":
            ok = guild.get_role(ident) is not None and ident != guild.id
        elif kind == "category":
            ok = any(c.id == ident for c in guild.categories)
        else:
            ok = any(c.id == ident for c in guild.text_channels)
        if not ok:
            raise ValidationError(f"{label}: that {kind} no longer exists in the server.")
        return ident

    if kind == "color":
        if isinstance(value, str):
            value = value.lstrip("#")
            if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
                raise ValidationError(f"{label}: use a hex color like #5865F2.")
            return int(value, 16)
        if isinstance(value, int) and 0 <= value <= 0xFFFFFF:
            return value
        raise ValidationError(f"{label}: invalid color.")

    if kind in ("text", "longtext", "regex"):
        if value in (None, ""):
            return None
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected text.")
        value = value.strip()
        limit = field.get("max", 200 if kind != "longtext" else 1500)
        if len(value) > limit:
            raise ValidationError(f"{label}: at most {limit} characters.")
        if kind == "regex":
            try:
                re.compile(value)
            except re.error as exc:
                raise ValidationError(f"{label}: invalid pattern ({exc}).")
        return value or None

    raise ValidationError(f"{label}: unsupported field.")


def public_schema() -> dict:
    """What the browser receives: the same table, minus the table names."""
    out = {}
    for name, sec in SECTIONS.items():
        out[name] = {
            "title": sec["title"],
            "intro": sec["intro"],
            "groups": [{"title": t, "fields": fs} for t, fs in sec["groups"]],
        }
    return out
