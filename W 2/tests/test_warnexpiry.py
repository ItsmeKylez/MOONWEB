"""Pruebas de la expiracion de avisos (Stage 4A / Feature 05).
Ejecutar:  python tests/test_warnexpiry.py   (usa stubs si falta discord.py / aiosqlite)."""
import asyncio, os, sys, sqlite3, tempfile, types, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
from database import Database
from utils import warnexpiry as we, escalation, helpers

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

class FakeRole:
    def __init__(self, pos): self.pos = pos
    def __ge__(self, o): return self.pos >= o.pos
class FakeUser:
    def __init__(self, uid, role=1):
        self.id, self.top_role = uid, FakeRole(role)
        self.display_avatar = types.SimpleNamespace(url="x"); self.mention = f"<@{uid}>"
        self.timeouts = []
    def __str__(self): return f"user{self.id}"
    async def timeout(self, delta, reason=None): self.timeouts.append(delta)
class FakeGuild:
    def __init__(self, gid=1):
        self.id, self.owner_id, self.name, self.icon = gid, 999, "G", None
        self.me = FakeUser(500, role=10)
    def get_channel(self, _): return None
class FakeBot:
    def __init__(self, db): self.db = db; self.user = FakeUser(500); self.guilds = {}
    def get_guild(self, gid): return self.guilds.get(gid)

NOW = int(time.time()); DAY = 86400
async def warn(db, g, u, ago_days):
    return await db.execute("INSERT INTO warns (guild_id,user_id,moderator_id,reason,created_at) "
                            "VALUES (?,?,7,'t',?)", (g, u, NOW - int(ago_days * DAY)))

async def main():
    print("validacion")
    check("0 valido", we.validate_days(0) is None)
    check("30 valido", we.validate_days(30) is None)
    check("-1 rechazado", we.validate_days(-1) is not None)
    check(f"{we.MAX_DAYS+1} rechazado", we.validate_days(we.MAX_DAYS + 1) is not None)
    check("texto/bool rechazados", we.validate_days("5") is not None and we.validate_days(True) is not None)
    check("expires_at 0 -> None", we.expires_at(100, 0) is None)
    check("expires_at 2d", we.expires_at(100, 2) == 100 + 2 * DAY)

    print("migracion de BD antigua")
    tmp = tempfile.mkdtemp(); path = os.path.join(tmp, "old.db")
    raw = sqlite3.connect(path)
    raw.execute("CREATE TABLE warns (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id INTEGER NOT NULL, "
                "user_id INTEGER NOT NULL, moderator_id INTEGER NOT NULL, reason TEXT, created_at INTEGER DEFAULT 0)")
    raw.execute("INSERT INTO warns (guild_id,user_id,moderator_id,reason,created_at) VALUES (1,5,7,'vieja',100)")
    raw.commit(); raw.close()
    db = Database(path); await db.connect(); await db.connect()
    check("columna expired_at anadida", "expired_at" in db._columns["warns"])
    row = await db.fetchone("SELECT * FROM warns WHERE user_id=5")
    check("aviso antiguo intacto y activo", row["reason"] == "vieja" and row["expired_at"] is None)
    check("tabla de config creada", "warn_expiry_config" in db._columns)
    bot = FakeBot(db)
    await db.execute("DELETE FROM warns")

    print("desactivada por defecto")
    cfg = await we.get_config(bot, 1)
    check("days=0 y notify=1 por defecto", cfg["days"] == 0 and cfg["notify"] == 1)
    await warn(db, 1, 10, 400)
    check("sweep con days=0 no hace nada", await we.sweep_guild(bot, 1) == [])
    check("aviso antiguo sigue activo", await we.count_active(bot, 1, 10) == 1)
    check("pending_count 0 si desactivada", await we.pending_count(bot, 1, 0) == 0)

    print("caducidad")
    await db.execute("DELETE FROM warns")
    for ago in (40, 31, 29, 1): await warn(db, 1, 10, ago)     # 2 caducan
    await warn(db, 1, 11, 35)                                   # 1 caduca
    await warn(db, 2, 10, 90)                                   # otro servidor
    await db.set("warn_expiry_config", 1, days=30)
    check("pending_count previo = 3", await we.pending_count(bot, 1, 30) == 3)
    res = await we.sweep_guild(bot, 1)
    got = {r["user_id"]: r["count"] for r in res}
    check("usuario 10: 2, usuario 11: 1", got == {10: 2, 11: 1})
    check("activos usuario 10 = 2", await we.count_active(bot, 1, 10) == 2)
    check("activos usuario 11 = 0", await we.count_active(bot, 1, 11) == 0)
    check("no se borra ningun aviso", await db.fetchval("SELECT COUNT(*) FROM warns WHERE guild_id=1") == 5)
    check("expired_at rellenado", await db.fetchval("SELECT COUNT(*) FROM warns WHERE guild_id=1 AND expired_at IS NOT NULL") == 3)
    check("otro servidor intacto", await we.count_active(bot, 2, 10) == 1)
    check("segunda pasada idempotente", await we.sweep_guild(bot, 1) == [])
    first = await db.fetchval("SELECT MIN(expired_at) FROM warns WHERE expired_at IS NOT NULL")
    await we.sweep_guild(bot, 1, now=NOW + 5 * DAY)
    check("no re-marca los ya caducados", await db.fetchval("SELECT MIN(expired_at) FROM warns WHERE expired_at IS NOT NULL") == first)

    print("pasadas simultaneas")
    await db.execute("DELETE FROM warns WHERE guild_id=1")
    for u in range(20, 25): await warn(db, 1, u, 50)
    a, b = await asyncio.gather(we.sweep_guild(bot, 1), we.sweep_guild(bot, 1))
    check("cada aviso se reporta una sola vez", sum(r["count"] for r in a + b) == 5)

    print("cambiar la configuracion")
    await warn(db, 1, 30, 10)
    await db.set("warn_expiry_config", 1, days=5)
    check("acortar plazo caduca avisos antiguos", [r["user_id"] for r in await we.sweep_guild(bot, 1)] == [30])
    await db.set("warn_expiry_config", 1, days=0)
    await warn(db, 1, 31, 500)
    check("desactivar: no caduca mas", await we.sweep_guild(bot, 1) == [] and await we.count_active(bot, 1, 31) == 1)
    check("desactivar: los caducados siguen caducados", await we.count_active(bot, 1, 30) == 0)

    print("escalada ignora avisos caducados")
    await db.execute("DELETE FROM warns WHERE guild_id=1")
    await db.execute("DELETE FROM escalation_history")
    await db.set("warn_expiry_config", 1, days=30)
    await db.set("escalation_config", 1, enabled=1)
    await db.execute("INSERT INTO escalation_rules (guild_id,threshold,action,duration) VALUES (1,3,'timeout',3600)")
    guild, user = FakeGuild(1), FakeUser(42)
    await warn(db, 1, 42, 60); await warn(db, 1, 42, 2); await warn(db, 1, 42, 1)   # 3 en total, 1 vieja
    await we.sweep_guild(bot, 1)
    check("3 avisos con 1 caducado -> sin escalada", await escalation.evaluate(bot, guild, user) is None)
    check("nadie sancionado", user.timeouts == [])
    await warn(db, 1, 42, 0)
    out = await escalation.evaluate(bot, guild, user)
    check("3 activos -> escalada aplicada", out is not None and out["status"] == "applied" and len(user.timeouts) == 1)
    check("caducar no creo sanciones ni casos", await db.fetchval("SELECT COUNT(*) FROM cases WHERE action='warn'", default=0) == 0)

    print("registro")
    sent = []
    async def fake_send(bot_, guild_, cat, embed): sent.append((cat, embed))
    orig = helpers.send_log; helpers.send_log = fake_send
    try:
        await we.log_expired(bot, guild, [{"user_id": 1, "count": 2}, {"user_id": 2, "count": 1}])
        check("notify=1 -> 1 embed en casos_gestion", len(sent) == 1 and sent[0][0] == "casos_gestion")
        check("embed con total 3", any(v == "3" for _, v in sent[0][1].fields))
        await db.set("warn_expiry_config", 1, notify=0)
        await we.log_expired(bot, guild, [{"user_id": 1, "count": 2}])
        check("notify=0 -> sin embed", len(sent) == 1)
        await db.set("warn_expiry_config", 1, notify=1)
        await warn(db, 1, 60, 99)
        bot.guilds[1] = guild
        await we.sweep_all(bot)
        check("sweep_all registra y caduca", len(sent) == 2 and await we.count_active(bot, 1, 60) == 0)
        bot.guilds.clear(); await warn(db, 1, 61, 99)
        await we.sweep_all(bot)
        check("sweep_all sin guild en cache no falla y caduca", await we.count_active(bot, 1, 61) == 0)
    finally:
        helpers.send_log = orig

    await db.close()
    print(f"\n{passed} ok, {failed} fallos")
    sys.exit(1 if failed else 0)

asyncio.run(main())
