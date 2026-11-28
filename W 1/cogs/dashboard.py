"""Starts the web dashboard inside the bot process (see web/server.py).

It stays off unless DASHBOARD_ENABLED=1, so existing installs behave exactly
as before.
"""

from __future__ import annotations

import logging
import os

from discord.ext import commands

log = logging.getLogger("dashboard")


class DashboardCog(commands.Cog, name="Dashboard"):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.dashboard = None

    async def cog_load(self) -> None:
        if os.getenv("DASHBOARD_ENABLED", "0").lower() not in ("1", "true", "yes"):
            return
        client_id = os.getenv("DISCORD_CLIENT_ID", "")
        secret = os.getenv("DISCORD_CLIENT_SECRET", "")
        if not client_id or not secret:
            log.error("DASHBOARD_ENABLED is on but DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET "
                      "are missing. The dashboard will not start.")
            return

        from web import Dashboard  # imported lazily so the bot runs without it

        # Railway (and similar hosts) provide PORT and a public domain; honor them.
        port = int(os.getenv("DASHBOARD_PORT") or os.getenv("PORT") or "8080")
        host = os.getenv("DASHBOARD_HOST") or ("0.0.0.0" if os.getenv("PORT") else "127.0.0.1")
        railway = os.getenv("RAILWAY_PUBLIC_DOMAIN")
        base_url = os.getenv("DASHBOARD_URL") or (
            f"https://{railway}" if railway else f"http://localhost:{port}")
        self.dashboard = Dashboard(
            self.bot, host=host, port=port, base_url=base_url,
            client_id=client_id, client_secret=secret)
        try:
            await self.dashboard.start()
        except OSError as exc:
            log.error("Dashboard could not start on port %s: %s", port, exc)
            self.dashboard = None

    async def cog_unload(self) -> None:
        if self.dashboard:
            await self.dashboard.stop()


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(DashboardCog(bot))
