"""Pruebas de la escalada automatica (Stage 4A / Feature 01).

Ejecutar:  python tests/test_escalation.py

Usa el database/db.py y el schema.sql REALES. Si discord.py / aiosqlite no
estan instalados (p. ej. un entorno sin red) se sustituyen por stubs minimos;
con las dependencias reales instaladas se usan estas en su lugar.
NO sustituye a una prueba en un servidor de Discord real.
"""
import asyncio, os, sys, sqlite3, tempfile, types, time, threading

import sys as _s, os as _o
_s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD

import discord
from database import Database
from utils import escalation, modlog

# ----------------------------------------------------------- fake objects ---
class FakeRole:
    def __init__(self, pos): self.pos = pos
    def __ge__(self, o): return self.pos >= o.pos

class FakeUser:
    def __init__(self, uid, role=1):
        self.id, self.top_role = uid, FakeRole(role)
        self.display_avatar = types.SimpleNamespace(url="x")
        self.mention = f"<@{uid}>"; self.timeouts = []; self.kicked = False
        self.fail_with = None
    def __str__(self): return f"user{self.id}"
    async def timeout(self, delta, reason=None):
        if self.fail_with: raise self.fail_with
        self.timeouts.append(delta)
    async def kick(self, reason=None):
        if self.fail_with: raise self.fail_with
        self.kicked = True

class FakeGuild:
    def __init__(self):
        self.id, self.owner_id, self.name, self.icon = 1, 999, "TestGuild", None
        self.me = FakeUser(500, role=10); self.banned = []
    async def ban(self, member, reason=None, delete_message_seconds=0):
        if getattr(member, "fail_with", None): raise member.fail_with
        self.banned.append(member.id)
    def get_channel(self, _): return None

class FakeBot:
    def __init__(self, db): self.db = db; self.user = FakeUser(500)

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

async def add_warn(bot, uid):
    return await bot.db.execute(
        "INSERT INTO warns (guild_id,user_id,moderator_id,reason,created_at) VALUES (1,?,7,'t',?)",
        (uid, int(time.time())))

async def main():
    # --- pure logic
    print("validacion / seleccion")
    v = escalation.validate_rule
    check("timeout sin duracion rechazado", v(3, "timeout", None) is not None)
    check("timeout >28d rechazado", v(3, "timeout", 29 * 86400) is not None)
    check("timeout 1h valido", v(3, "timeout", 3600) is None)
    check("kick con duracion rechazado", v(3, "kick", 60) is not None)
    check("ban permanente valido", v(5, "ban", None) is None)
    check("ban temporal valido", v(5, "ban", 86400) is None)
    check("umbral 0 rechazado", v(0, "ban", None) is not None)
    check("umbral 51 rechazado", v(51, "ban", None) is not None)
    check("accion rara rechazada", v(2, "nuke", None) is not None)
    rules = [{"threshold": 3, "action": "timeout", "duration": 60},
             {"threshold": 5, "action": "kick", "duration": None}]
    check("pick: 2 avisos -> nada", escalation.pick_rule(rules, 2) is None)
    check("pick: 3 -> timeout", escalation.pick_rule(rules, 3)["action"] == "timeout")
    check("pick: 4 -> timeout", escalation.pick_rule(rules, 4)["threshold"] == 3)
    check("pick: 9 -> kick (solo el mas alto)", escalation.pick_rule(rules, 9)["action"] == "kick")

    # --- DB real
    tmp = tempfile.mkdtemp()
    db = Database(os.path.join(tmp, "t.db"))
    await db.connect()
    await db.connect()  # reconectar sobre el mismo archivo = migracion idempotente
    bot, guild = FakeBot(db), FakeGuild()
    print("base de datos")
    cols = db._columns
    check("tablas creadas", all(t in cols for t in
          ("escalation_rules", "escalation_config", "escalation_history")))
    cfg = await db.get("escalation_config", 1)
    check("desactivada por defecto", cfg["enabled"] == 0)

    user = FakeUser(42)
    print("desactivada / sin reglas")
    await add_warn(bot, 42)
    check("desactivada -> None", await escalation.evaluate(bot, guild, user) is None)
    await db.set("escalation_config", 1, enabled=1)
    check("activada sin reglas -> None", await escalation.evaluate(bot, guild, user) is None)

    await db.execute("INSERT INTO escalation_rules (guild_id,threshold,action,duration) VALUES (1,3,'timeout',3600)")
    await db.execute("INSERT INTO escalation_rules (guild_id,threshold,action,duration) VALUES (1,5,'ban',86400)")
    try:
        await db.execute("INSERT INTO escalation_rules (guild_id,threshold,action,duration) VALUES (1,3,'kick',NULL)")
        check("umbral duplicado rechazado por UNIQUE", False)
    except sqlite3.IntegrityError:
        check("umbral duplicado rechazado por UNIQUE", True)

    print("escalada")
    check("1 aviso -> None", await escalation.evaluate(bot, guild, user) is None)
    await add_warn(bot, 42)
    check("2 avisos -> None", await escalation.evaluate(bot, guild, user) is None)
    await add_warn(bot, 42)
    r = await escalation.evaluate(bot, guild, user)
    check("3 avisos -> timeout aplicado", r and r["status"] == "applied" and len(user.timeouts) == 1)
    check("timeout de 1h", user.timeouts[0].total_seconds() == 3600)
    check("caso creado con el bot como moderador",
          (await modlog.get_case(bot, 1, r["case"]))["moderator_id"] == 500)
    check("evaluar otra vez NO duplica", await escalation.evaluate(bot, guild, user) is None
          and len(user.timeouts) == 1)
    await add_warn(bot, 42)
    check("4 avisos NO repite el umbral 3", await escalation.evaluate(bot, guild, user) is None
          and len(user.timeouts) == 1)
    await add_warn(bot, 42)
    r = await escalation.evaluate(bot, guild, user)
    check("5 avisos -> tempban", r and r["status"] == "applied" and guild.banned == [42])
    ta = await db.fetchone("SELECT * FROM temp_actions WHERE user_id=42")
    check("tempban registrado en temp_actions", ta and ta["action"] == "ban"
          and ta["expires_at"] > time.time() + 86000)
    check("caso tipo tempban", (await modlog.get_case(bot, 1, r["case"]))["action"] == "tempban")

    print("concurrencia")
    u2 = FakeUser(77)
    for _ in range(3): await add_warn(bot, 77)
    res = await asyncio.gather(*[escalation.evaluate(bot, guild, u2) for _ in range(6)])
    check("6 evaluaciones simultaneas -> 1 sola sancion",
          sum(1 for x in res if x) == 1 and len(u2.timeouts) == 1)

    print("rearme tras borrar avisos")
    await db.execute("DELETE FROM warns WHERE guild_id=1 AND user_id=77")
    await add_warn(bot, 77)
    await escalation.evaluate(bot, guild, u2)
    act = await db.fetchval("SELECT COUNT(*) FROM escalation_history WHERE user_id=77 AND active=1", default=0)
    check("al bajar de umbral se desactiva el registro", act == 0)
    for _ in range(2): await add_warn(bot, 77)
    r = await escalation.evaluate(bot, guild, u2)
    check("al volver al umbral se vuelve a aplicar", r and len(u2.timeouts) == 2)
    total = await db.fetchval("SELECT COUNT(*) FROM escalation_history WHERE user_id=77", default=0)
    check("historial conserva ambas escaladas", total == 2)

    print("fallos")
    u3 = FakeUser(88, role=10)  # mismo rol que el bot
    for _ in range(3): await add_warn(bot, 88)
    r = await escalation.evaluate(bot, guild, u3)
    check("jerarquia: falla sin intentar la accion", r and r["status"] == "failed" and not u3.timeouts)
    check("fallo sin caso", r["case"] is None)
    check("fallo registrado en historial",
          (await db.fetchone("SELECT status FROM escalation_history WHERE user_id=88"))["status"] == "failed")
    check("fallo no se reintenta en bucle", await escalation.evaluate(bot, guild, u3) is None)
    u4 = FakeUser(89); u4.fail_with = discord.Forbidden()
    for _ in range(3): await add_warn(bot, 89)
    r = await escalation.evaluate(bot, guild, u4)
    check("Forbidden de Discord -> fallido, sin excepcion", r and r["status"] == "failed")
    owner = FakeUser(999)
    for _ in range(3): await add_warn(bot, 999)
    r = await escalation.evaluate(bot, guild, owner)
    check("dueño del servidor protegido", r and r["status"] == "failed")

    print("kick")
    await db.execute("DELETE FROM escalation_rules WHERE guild_id=1")
    await db.execute("INSERT INTO escalation_rules (guild_id,threshold,action,duration) VALUES (1,1,'kick',NULL)")
    u5 = FakeUser(55); await add_warn(bot, 55)
    r = await escalation.evaluate(bot, guild, u5)
    check("kick aplicado", r and u5.kicked)

    print("migracion sobre BD antigua")
    old = os.path.join(tmp, "old.db")
    c = sqlite3.connect(old)
    c.executescript(open(os.path.join(ROOT, "database", "schema.sql"), encoding="utf-8").read()
                    .split("-- --- ESCALADA")[0])
    c.execute("INSERT INTO warns (guild_id,user_id,moderator_id,reason) VALUES (1,1,1,'viejo')")
    c.commit(); c.close()
    db2 = Database(old); await db2.connect()
    check("BD antigua migra sin perder avisos",
          await db2.fetchval("SELECT COUNT(*) FROM warns", default=0) == 1
          and "escalation_history" in db2._columns)
    await db.close(); await db2.close()

asyncio.run(main())
print(f"\n{passed} correctas, {failed} fallidas" + ("  [con stubs de discord]" if STUB_DISCORD else ""))
sys.exit(1 if failed else 0)
