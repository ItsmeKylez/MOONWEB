"""Pruebas del sistema de apelaciones (Stage 4A / Feature 03).
Ejecutar:  python tests/test_appeals.py   (usa stubs si falta discord.py)."""
import asyncio, os, sys, sqlite3, tempfile, types, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
import discord
from database import Database
from utils import appeals, modlog, helpers

if STUB_DISCORD:
    class _Obj:
        def __init__(self, id): self.id = id
    discord.Object = _Obj

class U:
    def __init__(self, uid):
        self.id = uid; self.mention = f"<@{uid}>"
        self.display_avatar = types.SimpleNamespace(url="x")
        self.timed_out_until = None; self.timeout_cleared = False
    def __str__(self): return f"u{self.id}"
    async def timeout(self, d, reason=None):
        if d is None: self.timeout_cleared = True; self.timed_out_until = None

class G:
    id, name, icon, owner_id = 1, "G", None, 9
    def __init__(self): self.members = {}; self.unbanned = []; self.unban_error = None
    def get_member(self, i): return self.members.get(i)
    def get_channel(self, _): return None
    async def unban(self, obj, reason=None):
        if self.unban_error: raise self.unban_error
        self.unbanned.append(obj.id)

class B:
    def __init__(self, db): self.db, self.user = db, U(500); self.users = {}
    def get_user(self, i): return self.users.get(i)
    async def fetch_user(self, i): return self.users.setdefault(i, U(i))

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

async def case(bot, g, action, uid, mod=7, reason="motivo"):
    return await modlog.create_case(bot, g, action, U(uid), U(mod), reason, notify=False)

async def main():
    tmp = tempfile.mkdtemp()
    db = Database(os.path.join(tmp, "t.db")); await db.connect()
    bot, g = B(db), G()
    check("tablas creadas", "appeals" in db._columns and "appeal_config" in db._columns)
    check("desactivadas por defecto", (await db.get("appeal_config", 1))["enabled"] == 0)

    user = U(42); g.members[42] = user
    c_ban = await case(bot, g, "ban", 42)
    c_to = await case(bot, g, "timeout", 42)
    c_warn = await case(bot, g, "warn", 42)
    c_kick = await case(bot, g, "kick", 42)
    c_other = await case(bot, g, "ban", 43)

    print("envio")
    a, e = await appeals.submit(bot, g, user, c_ban, "x" * 20)
    check("desactivado -> rechazado", a is None and "activadas" in e)
    await db.set("appeal_config", 1, enabled=1)
    a, e = await appeals.submit(bot, g, user, c_ban, "corto")
    check("motivo corto rechazado", a is None and "caracteres" in e)
    a, e = await appeals.submit(bot, g, user, c_other, "x" * 20)
    check("caso de otro usuario rechazado", a is None and "a tu nombre" in e)
    a, e = await appeals.submit(bot, g, user, 9999, "x" * 20)
    e2 = e
    check("caso inexistente = mismo mensaje (sin filtrar info)", a is None and e == "No existe ese caso a tu nombre.")
    a, e = await appeals.submit(bot, g, user, c_kick, "x" * 20)
    check("kick no apelable", a is None and "no se puede apelar" in e)
    a, e = await appeals.submit(bot, g, user, c_ban, "  Fue un error mio, lo siento mucho  ")
    check("apelacion valida", a and a["status"] == "pending" and a["reason"].startswith("Fue"))
    a2, e = await appeals.submit(bot, g, user, c_ban, "x" * 20)
    check("segunda apelacion del mismo caso rechazada", a2 is None and "ya tiene" in e)
    r = await asyncio.gather(*[appeals.submit(bot, g, user, c_to, "y" * 20) for _ in range(5)])
    check("5 envios simultaneos -> 1 solo registro", sum(1 for x, _ in r if x) == 1
          and await db.fetchval("SELECT COUNT(*) FROM appeals WHERE case_number=?", (c_to,), 0) == 1)
    a3, e = await appeals.submit(bot, g, user, c_warn, "z" * 20)
    check("3 pendientes permitidas", a3 is not None)
    extra = await case(bot, g, "ban", 42)
    a4, e = await appeals.submit(bot, g, user, extra, "z" * 20)
    check("4a pendiente rechazada", a4 is None and "pendientes" in e)

    print("plazo")
    await db.set("appeal_config", 1, window_days=1)
    old = await case(bot, g, "ban", 50)
    await db.execute("UPDATE cases SET created_at=? WHERE number=?", (int(time.time()) - 3 * 86400, old))
    a, e = await appeals.submit(bot, g, U(50), old, "x" * 20)
    check("fuera de plazo rechazado", a is None and "ya no se puede" in e)
    await db.set("appeal_config", 1, window_days=0)
    a, e = await appeals.submit(bot, g, U(50), old, "x" * 20)
    check("window_days=0 -> sin limite", a is not None)
    await db.set("appeal_config", 1, window_days=30)

    print("resolucion")
    ap_ban = await db.fetchone("SELECT * FROM appeals WHERE case_number=?", (c_ban,))
    mod = U(7)
    res, e = await appeals.decide(bot, g, U(42), ap_ban["id"], True)
    check("no puede resolver la propia", res is None and "propia" in e)
    res, e = await appeals.decide(bot, g, mod, 9999, True)
    check("apelacion inexistente", res is None and "No existe" in e)
    await db.execute("INSERT INTO temp_actions (guild_id,user_id,action,expires_at) VALUES (1,42,'ban',?)", (int(time.time()) + 999,))
    res, e = await appeals.decide(bot, g, mod, ap_ban["id"], True, " perdon ")
    check("aceptar ban -> desbanea", res and g.unbanned == [42])
    check("temp_actions limpiado", await db.fetchone("SELECT 1 FROM temp_actions WHERE user_id=42") is None)
    check("estado accepted + revisor", res["appeal"]["status"] == "accepted" and res["appeal"]["reviewed_by"] == 7
          and res["appeal"]["review_note"] == "perdon")
    last = await db.fetchone("SELECT * FROM cases ORDER BY id DESC LIMIT 1")
    check("caso unban creado con el revisor", last["action"] == "unban" and last["moderator_id"] == 7)
    res, e = await appeals.decide(bot, g, mod, ap_ban["id"], False)
    check("no se puede resolver dos veces", res is None and "ya esta" in e)
    r = await db.fetchval("SELECT status FROM appeals WHERE id=?", (ap_ban["id"],))
    check("segunda decision no cambia el estado", r == "accepted")

    ap_to = await db.fetchone("SELECT * FROM appeals WHERE case_number=?", (c_to,))
    user.timed_out_until = object()
    res, e = await appeals.decide(bot, g, mod, ap_to["id"], True)
    check("aceptar timeout -> lo quita", res and user.timeout_cleared)

    ap_w = await db.fetchone("SELECT * FROM appeals WHERE case_number=?", (c_warn,))
    await db.execute("INSERT INTO warns (guild_id,user_id,moderator_id,reason,created_at) VALUES (1,42,7,'w',?)", (int(time.time()),))
    await db.execute("INSERT INTO warns (guild_id,user_id,moderator_id,reason,created_at) VALUES (1,42,7,'viejo',?)", (int(time.time()) - 99999,))
    res, e = await appeals.decide(bot, g, mod, ap_w["id"], True)
    left = await db.fetchall("SELECT reason FROM warns WHERE user_id=42")
    check("aceptar warn -> borra solo el aviso asociado", [w["reason"] for w in left] == ["viejo"])

    print("denegar y errores")
    ap_o = await db.fetchone("SELECT * FROM appeals WHERE case_number=?", (old,))
    res, e = await appeals.decide(bot, g, mod, ap_o["id"], False, "no")
    check("denegar no deshace nada", res and res["revert_note"] is None and g.unbanned == [42])
    check("denegada queda definitiva", (await db.fetchval("SELECT status FROM appeals WHERE id=?", (ap_o["id"],))) == "denied")

    g2 = G(); g2.unban_error = discord.Forbidden()
    bot2 = B(db)
    c = await case(bot2, g2, "ban", 60); await db.set("appeal_config", 1, enabled=1)
    ap, _ = await appeals.submit(bot2, g2, U(60), c, "w" * 20)
    res, e = await appeals.decide(bot2, g2, mod, ap["id"], True)
    check("Forbidden al deshacer -> aceptada con aviso, sin excepcion",
          res and res["appeal"]["status"] == "accepted" and "a mano" in res["revert_note"])
    g3 = G(); g3.unban_error = discord.NotFound()
    c = await case(bot, g3, "ban", 61)
    ap, _ = await appeals.submit(bot, g3, U(61), c, "w" * 20)
    res, e = await appeals.decide(bot, g3, mod, ap["id"], True)
    check("NotFound (ya desbaneado) manejado", res and "ya no estaba baneado" in res["revert_note"])

    cc = await case(bot, g, "ban", 70)
    ap, _ = await appeals.submit(bot, g, U(70), cc, "v" * 20)
    r = await asyncio.gather(*[appeals.decide(bot, g, mod, ap["id"], True) for _ in range(5)])
    check("5 resoluciones simultaneas -> 1 sola", sum(1 for x, _ in r if x) == 1
          and g.unbanned.count(70) == 1)

    print("boton de apelacion en el DM")
    sent = {}
    class Btn:
        def __init__(self, **k): self.kw = k
    class View:
        def __init__(self, **k): self.items = []
        def add_item(self, i): self.items.append(i)
    async def fake_dm(user, **kw): sent.update(kw); return True
    orig = (discord.ui.Button, discord.ui.View, helpers.try_dm)
    discord.ui.Button, discord.ui.View, helpers.try_dm = Btn, View, fake_dm
    try:
        await db.set("guild_config", 1, dm_on_punish=1)
        sent.clear(); n = await modlog.create_case(bot, g, "ban", U(80), U(7), "x")
        cid = sent["view"].items[0].kw["custom_id"] if "view" in sent else None
        check("DM de ban lleva el boton con custom_id correcto", cid == f"appeal:1:{n}")
        sent.clear(); await modlog.create_case(bot, g, "kick", U(80), U(7), "x")
        check("DM de kick NO lleva boton", "view" not in sent)
        await db.set("appeal_config", 1, enabled=0)
        sent.clear(); await modlog.create_case(bot, g, "ban", U(80), U(7), "x")
        check("apelaciones desactivadas -> sin boton", "view" not in sent)
    finally:
        discord.ui.Button, discord.ui.View, helpers.try_dm = orig

    print("migracion BD antigua")
    oldp = os.path.join(tmp, "old.db"); c = sqlite3.connect(oldp)
    c.executescript(open(os.path.join(ROOT, "database", "schema.sql"), encoding="utf-8").read()
                    .split("-- --- APELACIONES")[0].split("-- --- EVIDENCIAS")[0].split("-- --- ESCALADA")[0])
    c.execute("INSERT INTO cases (guild_id,number,action,user_id,moderator_id) VALUES (1,1,'ban',1,1)")
    c.commit(); c.close()
    d2 = Database(oldp); await d2.connect()
    check("BD antigua migra y conserva casos", "appeals" in d2._columns
          and await d2.fetchval("SELECT COUNT(*) FROM cases", default=0) == 1)
    await db.close(); await d2.close()

asyncio.run(main())
print(f"\n{passed} correctas, {failed} fallidas" + ("  [con stubs de discord]" if STUB_DISCORD else ""))
sys.exit(1 if failed else 0)
