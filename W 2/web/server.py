"""Web dashboard for the bot.

Runs inside the bot process (same event loop, same SQLite connection, same
in-memory caches), so a change made on the website takes effect immediately.

Security model
  * Sign in with Discord OAuth2 (scope: identify only).
  * Access to a server = the bot's own `is_admin` rule: Discord administrators,
    the server owner, or holders of the configured admin role.
  * Session cookie is random, HttpOnly and SameSite=Lax; every write request
    must also carry an `X-Requested-With` header, which cross-site forms and
    <img>/<script> tags cannot send.
  * All Discord IDs travel as strings (JavaScript cannot hold 64-bit ints).
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import time
from typing import Any
from urllib.parse import urlencode

import aiohttp
from aiohttp import web

import config
from utils import helpers

from . import schema

log = logging.getLogger("dashboard")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DISCORD_API = "https://discord.com/api/v10"
COOKIE = "zyn_session"
SESSION_TTL = 7 * 24 * 3600
PAGE_SIZE = 25
IGNORED_KINDS = ("channel", "role", "user")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def _sid(value: Any) -> str | None:
    return str(value) if value else None


def _to_int(value: Any, what: str = "id") -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ApiError(400, f"Invalid {what}.")
    if n <= 0 or n > 2**63 - 1:
        raise ApiError(400, f"Invalid {what}.")
    return n


class Dashboard:
    def __init__(self, bot, *, host: str, port: int, base_url: str,
                 client_id: str, client_secret: str):
        self.bot = bot
        self.host = host
        self.port = port
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.secure_cookie = self.base_url.startswith("https://")
        self.sessions: dict[str, dict] = {}
        self._states: dict[str, float] = {}
        self._runner: web.AppRunner | None = None
        self._http: aiohttp.ClientSession | None = None
        self.app = self._build_app()

    # ------------------------------------------------------------------
    #  lifecycle
    # ------------------------------------------------------------------
    def _build_app(self) -> web.Application:
        app = web.Application(middlewares=[self._middleware])
        r = app.router
        r.add_get("/", self.index)
        r.add_static("/static", STATIC_DIR, show_index=False)

        r.add_get("/auth/login", self.auth_login)
        r.add_get("/auth/callback", self.auth_callback)
        r.add_post("/auth/logout", self.auth_logout)

        r.add_get("/api/session", self.api_session)

        g = "/api/guilds/{gid}"
        r.add_get(g + "/meta", self.api_meta)
        r.add_get(g + "/overview", self.api_overview)
        r.add_get(g + "/config/{section}", self.api_config_get)
        r.add_patch(g + "/config/{section}", self.api_config_patch)
        r.add_get(g + "/logs", self.api_logs_get)
        r.add_put(g + "/logs", self.api_logs_put)

        r.add_get(g + "/whitelist", self.api_whitelist_get)
        r.add_post(g + "/whitelist", self.api_whitelist_add)
        r.add_delete(g + "/whitelist/{uid}", self.api_whitelist_del)

        r.add_get(g + "/ignored", self.api_ignored_get)
        r.add_post(g + "/ignored", self.api_ignored_add)
        r.add_delete(g + "/ignored/{kind}/{tid}", self.api_ignored_del)

        r.add_get(g + "/words", self.api_words_get)
        r.add_post(g + "/words", self.api_words_add)
        r.add_delete(g + "/words/{wid}", self.api_words_del)

        r.add_get(g + "/levels/leaderboard", self.api_leaderboard)
        r.add_get(g + "/levels/rewards", self.api_rewards_get)
        r.add_put(g + "/levels/rewards", self.api_rewards_put)
        r.add_delete(g + "/levels/rewards/{level}", self.api_rewards_del)

        r.add_get(g + "/tickets", self.api_tickets)
        r.add_get(g + "/tickets/panels", self.api_panels)
        r.add_get(g + "/tickets/blacklist", self.api_tblack_get)
        r.add_post(g + "/tickets/blacklist", self.api_tblack_add)
        r.add_delete(g + "/tickets/blacklist/{uid}", self.api_tblack_del)

        r.add_get(g + "/cases", self.api_cases)
        r.add_get(g + "/warns", self.api_warns)
        r.add_delete(g + "/warns/{wid}", self.api_warn_del)
        r.add_get(g + "/backups", self.api_backups)
        return app

    async def start(self) -> None:
        self._http = aiohttp.ClientSession()
        self._runner = web.AppRunner(self.app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        log.info("Dashboard listening on http://%s:%s (public URL %s)",
                 self.host, self.port, self.base_url)

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()
        if self._http:
            await self._http.close()

    # ------------------------------------------------------------------
    #  middleware: errors, auth, CSRF
    # ------------------------------------------------------------------
    @web.middleware
    async def _middleware(self, request: web.Request, handler):
        path = request.path
        try:
            if path.startswith("/api/"):
                if request.method not in ("GET", "HEAD") and \
                        request.headers.get("X-Requested-With") != "zyn-dashboard":
                    raise ApiError(403, "Missing request header.")
                request["session"] = self._session(request)
                if request["session"] is None:
                    raise ApiError(401, "Sign in to continue.")
                gid = request.match_info.get("gid")
                if gid is not None:
                    request["guild"] = await self._authorize(request["session"], gid)
            response = await handler(request)
        except ApiError as exc:
            response = web.json_response({"error": exc.message}, status=exc.status)
        except web.HTTPException:
            raise
        except Exception:
            log.exception("Unhandled error on %s %s", request.method, path)
            if path.startswith("/api/"):
                response = web.json_response({"error": "Something went wrong on the server."},
                                             status=500)
            else:
                raise
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def _session(self, request: web.Request) -> dict | None:
        token = request.cookies.get(COOKIE)
        sess = self.sessions.get(token) if token else None
        if sess is None:
            return None
        if sess["expires"] < time.time():
            self.sessions.pop(token, None)
            return None
        return sess

    async def _member(self, guild, user_id: int):
        member = guild.get_member(user_id)
        if member is None:
            try:
                member = await guild.fetch_member(user_id)
            except Exception:
                return None
        return member

    async def _can_manage(self, guild, user_id: int) -> bool:
        if self.bot.owner_id and user_id == self.bot.owner_id:
            return True
        member = await self._member(guild, user_id)
        return bool(member) and await helpers.is_admin(self.bot, member)

    async def _authorize(self, sess: dict, gid: str):
        guild = self.bot.get_guild(_to_int(gid, "server id"))
        # Same answer for "no such server" and "not allowed": don't leak which
        # servers the bot is in.
        if guild is None or not await self._can_manage(guild, sess["user_id"]):
            raise ApiError(404, "Server not found or you can't manage it.")
        return guild

    @staticmethod
    async def _body(request: web.Request) -> dict:
        try:
            data = await request.json()
        except Exception:
            raise ApiError(400, "Request body must be JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "Request body must be a JSON object.")
        return data

    # ------------------------------------------------------------------
    #  pages and OAuth
    # ------------------------------------------------------------------
    async def index(self, request: web.Request) -> web.StreamResponse:
        return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))

    def _redirect_uri(self) -> str:
        return self.base_url + "/auth/callback"

    async def auth_login(self, request: web.Request) -> web.StreamResponse:
        now = time.time()
        self._states = {s: t for s, t in self._states.items() if t > now}
        state = secrets.token_urlsafe(24)
        self._states[state] = now + 600
        url = "https://discord.com/oauth2/authorize?" + urlencode({
            "client_id": self.client_id, "response_type": "code",
            "redirect_uri": self._redirect_uri(), "scope": "identify",
            "state": state, "prompt": "none",
        })
        raise web.HTTPFound(url)

    async def auth_callback(self, request: web.Request) -> web.StreamResponse:
        state = request.query.get("state", "")
        code = request.query.get("code")
        if not code or self._states.pop(state, 0) < time.time():
            raise web.HTTPFound("/?login=failed")
        try:
            async with self._http.post(DISCORD_API + "/oauth2/token", data={
                "client_id": self.client_id, "client_secret": self.client_secret,
                "grant_type": "authorization_code", "code": code,
                "redirect_uri": self._redirect_uri(),
            }) as resp:
                if resp.status != 200:
                    log.warning("OAuth token exchange failed: %s", resp.status)
                    raise web.HTTPFound("/?login=failed")
                token = (await resp.json())["access_token"]
            async with self._http.get(DISCORD_API + "/users/@me",
                                      headers={"Authorization": f"Bearer {token}"}) as resp:
                if resp.status != 200:
                    raise web.HTTPFound("/?login=failed")
                user = await resp.json()
        except aiohttp.ClientError:
            raise web.HTTPFound("/?login=failed")

        sid = secrets.token_urlsafe(32)
        self.sessions[sid] = {
            "user_id": int(user["id"]),
            "name": user.get("global_name") or user["username"],
            "avatar": (f"https://cdn.discordapp.com/avatars/{user['id']}/{user['avatar']}.png?size=64"
                       if user.get("avatar") else None),
            "expires": time.time() + SESSION_TTL,
        }
        now = time.time()
        self.sessions = {k: v for k, v in self.sessions.items() if v["expires"] > now}
        resp = web.HTTPFound("/")
        resp.set_cookie(COOKIE, sid, max_age=SESSION_TTL, httponly=True,
                        samesite="Lax", secure=self.secure_cookie, path="/")
        raise resp

    async def auth_logout(self, request: web.Request) -> web.StreamResponse:
        if request.headers.get("X-Requested-With") != "zyn-dashboard":
            raise web.HTTPForbidden()
        token = request.cookies.get(COOKIE)
        self.sessions.pop(token, None)
        resp = web.json_response({"ok": True})
        resp.del_cookie(COOKIE, path="/")
        return resp

    # ------------------------------------------------------------------
    #  helpers for building responses
    # ------------------------------------------------------------------
    def _guild_brief(self, guild) -> dict:
        return {"id": str(guild.id), "name": guild.name,
                "icon": guild.icon.url if getattr(guild, "icon", None) else None,
                "members": guild.member_count or 0}

    def _user_brief(self, guild, uid: int | None) -> dict | None:
        if not uid:
            return None
        member = guild.get_member(uid)
        user = member or self.bot.get_user(uid)
        if user is None:
            return {"id": str(uid), "name": f"Unknown ({uid})", "avatar": None}
        avatar = getattr(user, "display_avatar", None)
        return {"id": str(uid), "name": getattr(user, "display_name", None) or user.name,
                "avatar": avatar.url if avatar else None}

    def _users(self, guild, ids) -> dict[str, dict]:
        return {str(i): self._user_brief(guild, i) for i in set(ids) if i}

    def _log_change(self, request: web.Request, what: str) -> None:
        log.info("%s (%s) changed %s in %s", request["session"]["name"],
                 request["session"]["user_id"], what, request["guild"].id)

    # ------------------------------------------------------------------
    #  session / meta
    # ------------------------------------------------------------------
    async def api_session(self, request: web.Request) -> web.Response:
        sess = request["session"]
        guilds = []
        for guild in self.bot.guilds:
            if await self._can_manage(guild, sess["user_id"]):
                guilds.append(self._guild_brief(guild))
        guilds.sort(key=lambda g: g["name"].lower())
        invite = ("https://discord.com/oauth2/authorize?" + urlencode({
            "client_id": self.client_id, "scope": "bot applications.commands",
            "permissions": 8}))
        return web.json_response({
            "user": {"id": str(sess["user_id"]), "name": sess["name"], "avatar": sess["avatar"]},
            "guilds": guilds, "invite": invite})

    async def api_meta(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        roles = [{"id": str(r.id), "name": r.name,
                  "color": f"#{r.color.value:06x}" if r.color.value else None,
                  "managed": r.managed}
                 for r in sorted(guild.roles, key=lambda r: -r.position) if r != guild.default_role]
        channels = [{"id": str(c.id), "name": c.name,
                     "category": c.category.name if c.category else None}
                    for c in guild.text_channels]
        categories = [{"id": str(c.id), "name": c.name} for c in guild.categories]
        return web.json_response({
            "guild": self._guild_brief(guild),
            "roles": roles, "channels": channels, "categories": categories,
            "log_categories": [{"key": k, "label": v} for k, v in config.LOG_CATEGORIES.items()],
            "priorities": list(config.PRIORITIES),
            "schema": schema.public_schema(),
        })

    async def api_overview(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        db = self.bot.db
        gid = guild.id
        now = int(time.time())
        week = now - 7 * 86400

        async def count(sql, *params):
            return await db.fetchval(sql, (gid, *params), 0)

        cfgs = {}
        for name in ("antinuke", "antiraid", "antispam", "levels"):
            sec = schema.SECTIONS[name]
            cfgs[name] = bool((await db.get(sec["table"], gid))["enabled"])
        logs = await db.get_log_channels(gid)
        recent = await db.fetchall(
            "SELECT number, action, user_id, moderator_id, reason, created_at FROM cases "
            "WHERE guild_id=? ORDER BY id DESC LIMIT 6", (gid,))
        ids = [r["user_id"] for r in recent] + [r["moderator_id"] for r in recent]
        return web.json_response({
            "protections": cfgs,
            "log_channels_set": sum(1 for k in logs if k in config.LOG_CATEGORIES), "log_channels_total": len(config.LOG_CATEGORIES),
            "stats": {
                "open_tickets": await count("SELECT COUNT(*) FROM tickets WHERE guild_id=? AND status='open'"),
                "tickets_week": await count("SELECT COUNT(*) FROM tickets WHERE guild_id=? AND opened_at>=?", week),
                "cases_total": await count("SELECT COUNT(*) FROM cases WHERE guild_id=?"),
                "cases_week": await count("SELECT COUNT(*) FROM cases WHERE guild_id=? AND created_at>=?", week),
                "warns_total": await count(
                    "SELECT COUNT(*) FROM warns WHERE guild_id=? AND expired_at IS NULL"),
                "whitelist": len(await db.get_whitelist(gid)),
                "avg_rating": await db.fetchval(
                    "SELECT ROUND(AVG(rating),2) FROM tickets WHERE guild_id=? AND rating IS NOT NULL", (gid,)),
            },
            "recent_cases": recent, "users": self._users(guild, ids),
            "bot": {"uptime": self.bot.uptime_seconds, "guilds": len(self.bot.guilds)},
        })

    # ------------------------------------------------------------------
    #  settings sections
    # ------------------------------------------------------------------
    def _section(self, request: web.Request) -> tuple[str, dict]:
        name = request.match_info["section"]
        if name not in schema.SECTIONS:
            raise ApiError(404, "Unknown settings section.")
        return name, schema.SECTIONS[name]

    @staticmethod
    def _out(field: dict, value: Any) -> Any:
        kind = field["kind"]
        if kind == "bool":
            return bool(value)
        if kind in ("role", "channel", "category"):
            return _sid(value)
        if kind == "color":
            return f"#{int(value if value is not None else 0x5865F2):06x}"
        return value

    async def api_config_get(self, request: web.Request) -> web.Response:
        name, sec = self._section(request)
        row = await self.bot.db.get(sec["table"], request["guild"].id)
        values = {k: self._out(f, row.get(k)) for k, f in schema.fields_of(name).items()}
        return web.json_response({"values": values})

    async def api_config_patch(self, request: web.Request) -> web.Response:
        name, sec = self._section(request)
        guild = request["guild"]
        data = (await self._body(request)).get("values")
        if not isinstance(data, dict) or not data:
            raise ApiError(400, "Nothing to save.")
        fields = schema.fields_of(name)
        clean: dict[str, Any] = {}
        try:
            for key, value in data.items():
                if key not in fields:
                    raise ApiError(400, f"Unknown setting: {key}.")
                clean[key] = schema.clean(fields[key], value, guild)
        except schema.ValidationError as exc:
            raise ApiError(422, str(exc))

        # Cross-field rules, checked against the merged result.
        current = await self.bot.db.get(sec["table"], guild.id)
        merged = {**current, **clean}
        if name == "levels" and merged["xp_min"] > merged["xp_max"]:
            raise ApiError(422, "Minimum XP can't be higher than maximum XP.")
        if name == "antispam" and not (
                merged["warn_at"] <= merged["mute_at"] <= merged["kick_at"] <= merged["ban_at"]):
            raise ApiError(422, "Escalation must go warn ≤ mute ≤ kick ≤ ban.")

        await self.bot.db.set(sec["table"], guild.id, **clean)
        self._log_change(request, f"{name} settings ({', '.join(clean)})")
        row = await self.bot.db.get(sec["table"], guild.id)
        return web.json_response(
            {"values": {k: self._out(f, row.get(k)) for k, f in fields.items()}})

    # --- log channels ---------------------------------------------------
    async def api_logs_get(self, request: web.Request) -> web.Response:
        logs = await self.bot.db.get_log_channels(request["guild"].id)
        return web.json_response({"channels": {k: _sid(logs.get(k)) for k in config.LOG_CATEGORIES}})

    async def api_logs_put(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        channels = (await self._body(request)).get("channels")
        if not isinstance(channels, dict):
            raise ApiError(400, "Expected a channels object.")
        valid = {c.id for c in guild.text_channels}
        updates = {}
        for key, value in channels.items():
            if key not in config.LOG_CATEGORIES:
                raise ApiError(400, f"Unknown log category: {key}.")
            if value in (None, ""):
                updates[key] = None
            else:
                cid = _to_int(value, "channel id")
                if cid not in valid:
                    raise ApiError(422, "One of those channels no longer exists.")
                updates[key] = cid
        for key, cid in updates.items():
            await self.bot.db.set_log_channel(guild.id, key, cid)
        self._log_change(request, "log channels")
        return await self.api_logs_get(request)

    # --- whitelist ------------------------------------------------------
    async def api_whitelist_get(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        rows = await self.bot.db.fetchall(
            "SELECT user_id, added_by FROM whitelist WHERE guild_id=?", (guild.id,))
        return web.json_response({
            "items": [{"user": self._user_brief(guild, r["user_id"]),
                       "added_by": self._user_brief(guild, r["added_by"])} for r in rows]})

    async def api_whitelist_add(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        uid = _to_int((await self._body(request)).get("user_id"), "user id")
        await self.bot.db.add_whitelist(guild.id, uid, request["session"]["user_id"])
        self._log_change(request, f"whitelist (+{uid})")
        return await self.api_whitelist_get(request)

    async def api_whitelist_del(self, request: web.Request) -> web.Response:
        await self.bot.db.remove_whitelist(request["guild"].id, _to_int(request.match_info["uid"]))
        self._log_change(request, "whitelist (-)")
        return await self.api_whitelist_get(request)

    # --- ignored --------------------------------------------------------
    async def api_ignored_get(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        data = await self.bot.db.get_ignored(guild.id)
        out = {"channel": [], "role": [], "user": []}
        for cid in data.get("channel", ()):
            ch = guild.get_channel(cid)
            out["channel"].append({"id": str(cid), "name": ch.name if ch else f"deleted ({cid})"})
        for rid in data.get("role", ()):
            ro = guild.get_role(rid)
            out["role"].append({"id": str(rid), "name": ro.name if ro else f"deleted ({rid})"})
        for uid in data.get("user", ()):
            u = self._user_brief(guild, uid)
            out["user"].append({"id": str(uid), "name": u["name"]})
        return web.json_response(out)

    async def api_ignored_add(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        body = await self._body(request)
        kind = body.get("kind")
        if kind not in IGNORED_KINDS:
            raise ApiError(400, "Kind must be channel, role or user.")
        tid = _to_int(body.get("target_id"), "id")
        if kind == "channel" and guild.get_channel(tid) is None:
            raise ApiError(422, "That channel doesn't exist.")
        if kind == "role" and guild.get_role(tid) is None:
            raise ApiError(422, "That role doesn't exist.")
        await self.bot.db.add_ignored(guild.id, kind, tid)
        self._log_change(request, f"ignored {kind}s")
        return await self.api_ignored_get(request)

    async def api_ignored_del(self, request: web.Request) -> web.Response:
        kind = request.match_info["kind"]
        if kind not in IGNORED_KINDS:
            raise ApiError(400, "Kind must be channel, role or user.")
        await self.bot.db.remove_ignored(request["guild"].id, kind, _to_int(request.match_info["tid"]))
        self._log_change(request, f"ignored {kind}s")
        return await self.api_ignored_get(request)

    # --- filtered words -------------------------------------------------
    def _invalidate_words(self, guild_id: int) -> None:
        for cog in self.bot.cogs.values():
            fn = getattr(cog, "invalidate_words", None)
            if callable(fn):
                fn(guild_id)

    async def api_words_get(self, request: web.Request) -> web.Response:
        rows = await self.bot.db.fetchall(
            "SELECT id, word, is_regex FROM filtered_words WHERE guild_id=? ORDER BY word",
            (request["guild"].id,))
        return web.json_response({"items": [
            {"id": r["id"], "word": r["word"], "is_regex": bool(r["is_regex"])} for r in rows]})

    async def api_words_add(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        word = body.get("word")
        is_regex = bool(body.get("is_regex"))
        if not isinstance(word, str) or not word.strip():
            raise ApiError(422, "Enter a word or pattern.")
        word = word.strip().lower()[:200]
        if is_regex:
            try:
                re.compile(word)
            except re.error as exc:
                raise ApiError(422, f"Invalid pattern: {exc}.")
        gid = request["guild"].id
        total = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM filtered_words WHERE guild_id=?", (gid,), 0)
        if total >= 500:
            raise ApiError(422, "The filter is limited to 500 entries.")
        await self.bot.db.execute(
            "INSERT INTO filtered_words (guild_id, word, is_regex) VALUES (?,?,?)",
            (gid, word, int(is_regex)))
        self._invalidate_words(gid)
        self._log_change(request, "filtered words")
        return await self.api_words_get(request)

    async def api_words_del(self, request: web.Request) -> web.Response:
        gid = request["guild"].id
        await self.bot.db.execute("DELETE FROM filtered_words WHERE guild_id=? AND id=?",
                                  (gid, _to_int(request.match_info["wid"])))
        self._invalidate_words(gid)
        self._log_change(request, "filtered words")
        return await self.api_words_get(request)

    # --- levels ---------------------------------------------------------
    async def api_leaderboard(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        page = max(1, int(request.query.get("page", 1) or 1))
        total = await self.bot.db.fetchval(
            "SELECT COUNT(*) FROM levels WHERE guild_id=?", (guild.id,), 0)
        rows = await self.bot.db.fetchall(
            "SELECT user_id, xp, level FROM levels WHERE guild_id=? ORDER BY xp DESC LIMIT ? OFFSET ?",
            (guild.id, PAGE_SIZE, (page - 1) * PAGE_SIZE))
        return web.json_response({
            "total": total, "page": page, "page_size": PAGE_SIZE,
            "items": [{"user": self._user_brief(guild, r["user_id"]), "xp": r["xp"],
                       "level": r["level"]} for r in rows]})

    async def api_rewards_get(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        rows = await self.bot.db.fetchall(
            "SELECT level, role_id FROM level_rewards WHERE guild_id=? ORDER BY level", (guild.id,))
        items = []
        for r in rows:
            role = guild.get_role(r["role_id"])
            items.append({"level": r["level"], "role_id": str(r["role_id"]),
                          "role_name": role.name if role else "Deleted role"})
        return web.json_response({"items": items})

    async def api_rewards_put(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        body = await self._body(request)
        level = body.get("level")
        if isinstance(level, bool) or not isinstance(level, int) or not 1 <= level <= 500:
            raise ApiError(422, "Level must be a whole number from 1 to 500.")
        role_id = _to_int(body.get("role_id"), "role id")
        if guild.get_role(role_id) is None:
            raise ApiError(422, "That role doesn't exist.")
        await self.bot.db.execute(
            "INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?,?,?) "
            "ON CONFLICT(guild_id, level) DO UPDATE SET role_id=excluded.role_id",
            (guild.id, level, role_id))
        self._log_change(request, "level rewards")
        return await self.api_rewards_get(request)

    async def api_rewards_del(self, request: web.Request) -> web.Response:
        await self.bot.db.execute("DELETE FROM level_rewards WHERE guild_id=? AND level=?",
                                  (request["guild"].id, _to_int(request.match_info["level"])))
        self._log_change(request, "level rewards")
        return await self.api_rewards_get(request)

    # --- tickets --------------------------------------------------------
    async def api_tickets(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        q = request.query
        page = max(1, int(q.get("page", 1) or 1))
        where, params = ["guild_id=?"], [guild.id]
        if q.get("status") in ("open", "closed", "deleted"):
            where.append("status=?")
            params.append(q["status"])
        if q.get("user"):
            where.append("user_id=?")
            params.append(_to_int(q["user"], "user id"))
        clause = " AND ".join(where)
        total = await self.bot.db.fetchval(f"SELECT COUNT(*) FROM tickets WHERE {clause}", params, 0)
        rows = await self.bot.db.fetchall(
            f"SELECT number, user_id, category_name, claimed_by, priority, status, opened_at, "
            f"closed_at, close_reason, rating, feedback, first_reply FROM tickets WHERE {clause} "
            f"ORDER BY id DESC LIMIT ? OFFSET ?", (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE))
        ids = [r["user_id"] for r in rows] + [r["claimed_by"] for r in rows]
        return web.json_response({"total": total, "page": page, "page_size": PAGE_SIZE,
                                  "items": rows, "users": self._users(guild, ids)})

    async def api_panels(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        panels = await self.bot.db.fetchall(
            "SELECT id, name, title, style, channel_id, message_id FROM ticket_panels "
            "WHERE guild_id=? ORDER BY id", (guild.id,))
        cats = await self.bot.db.fetchall(
            "SELECT panel_id, label, emoji, description FROM ticket_categories "
            "WHERE guild_id=? ORDER BY position, id", (guild.id,))
        out = []
        for p in panels:
            ch = guild.get_channel(p["channel_id"]) if p["channel_id"] else None
            out.append({"id": p["id"], "name": p["name"], "title": p["title"], "style": p["style"],
                        "channel": ch.name if ch else None, "published": bool(p["message_id"]),
                        "categories": [c for c in cats if c["panel_id"] == p["id"]]})
        return web.json_response({"items": out})

    async def api_tblack_get(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        rows = await self.bot.db.fetchall(
            "SELECT user_id, reason, added_by FROM ticket_blacklist WHERE guild_id=?", (guild.id,))
        return web.json_response({"items": [
            {"user": self._user_brief(guild, r["user_id"]), "reason": r["reason"],
             "added_by": self._user_brief(guild, r["added_by"])} for r in rows]})

    async def api_tblack_add(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        uid = _to_int(body.get("user_id"), "user id")
        reason = (body.get("reason") or "").strip()[:200] or None
        await self.bot.db.execute(
            "INSERT INTO ticket_blacklist (guild_id, user_id, reason, added_by) VALUES (?,?,?,?) "
            "ON CONFLICT(guild_id, user_id) DO UPDATE SET reason=excluded.reason",
            (request["guild"].id, uid, reason, request["session"]["user_id"]))
        self._log_change(request, "ticket blacklist")
        return await self.api_tblack_get(request)

    async def api_tblack_del(self, request: web.Request) -> web.Response:
        await self.bot.db.execute("DELETE FROM ticket_blacklist WHERE guild_id=? AND user_id=?",
                                  (request["guild"].id, _to_int(request.match_info["uid"])))
        self._log_change(request, "ticket blacklist")
        return await self.api_tblack_get(request)

    # --- moderation -----------------------------------------------------
    async def api_cases(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        q = request.query
        page = max(1, int(q.get("page", 1) or 1))
        where, params = ["guild_id=?"], [guild.id]
        if q.get("user"):
            where.append("user_id=?")
            params.append(_to_int(q["user"], "user id"))
        if q.get("action"):
            where.append("action=?")
            params.append(q["action"][:30])
        clause = " AND ".join(where)
        total = await self.bot.db.fetchval(f"SELECT COUNT(*) FROM cases WHERE {clause}", params, 0)
        rows = await self.bot.db.fetchall(
            f"SELECT number, action, user_id, moderator_id, reason, duration, created_at FROM cases "
            f"WHERE {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
            (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE))
        actions = await self.bot.db.fetchall(
            "SELECT DISTINCT action FROM cases WHERE guild_id=? ORDER BY action", (guild.id,))
        ids = [r["user_id"] for r in rows] + [r["moderator_id"] for r in rows]
        return web.json_response({"total": total, "page": page, "page_size": PAGE_SIZE,
                                  "items": rows, "users": self._users(guild, ids),
                                  "actions": [a["action"] for a in actions]})

    async def api_warns(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        q = request.query
        page = max(1, int(q.get("page", 1) or 1))
        where, params = ["guild_id=?"], [guild.id]
        if q.get("user"):
            where.append("user_id=?")
            params.append(_to_int(q["user"], "user id"))
        clause = " AND ".join(where)
        total = await self.bot.db.fetchval(f"SELECT COUNT(*) FROM warns WHERE {clause}", params, 0)
        rows = await self.bot.db.fetchall(
            f"SELECT id, user_id, moderator_id, reason, created_at, expired_at FROM warns WHERE {clause} "
            f"ORDER BY id DESC LIMIT ? OFFSET ?", (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE))
        ids = [r["user_id"] for r in rows] + [r["moderator_id"] for r in rows]
        return web.json_response({"total": total, "page": page, "page_size": PAGE_SIZE,
                                  "items": rows, "users": self._users(guild, ids)})

    async def api_warn_del(self, request: web.Request) -> web.Response:
        await self.bot.db.execute("DELETE FROM warns WHERE guild_id=? AND id=?",
                                  (request["guild"].id, _to_int(request.match_info["wid"])))
        self._log_change(request, "warnings (removed one)")
        return web.json_response({"ok": True})

    async def api_backups(self, request: web.Request) -> web.Response:
        guild = request["guild"]
        rows = await self.bot.db.fetchall(
            "SELECT id, name, data, created_at, created_by FROM backups WHERE guild_id=? "
            "ORDER BY id DESC LIMIT 50", (guild.id,))
        items = []
        for r in rows:
            try:
                data = json.loads(r["data"])
            except ValueError:
                data = {}
            items.append({"id": r["id"], "name": r["name"], "created_at": r["created_at"],
                          "by": self._user_brief(guild, r["created_by"]),
                          "roles": len(data.get("roles", [])) if isinstance(data, dict) else 0,
                          "channels": len(data.get("channels", [])) if isinstance(data, dict) else 0,
                          "categories": len(data.get("categories", [])) if isinstance(data, dict) else 0})
        return web.json_response({"items": items})
