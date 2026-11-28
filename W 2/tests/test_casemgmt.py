"""Pruebas de la gestion de casos (Stage 4A / Feature 06).
Ejecutar:  python tests/test_casemgmt.py   (usa stubs si falta discord.py / aiosqlite)."""
import asyncio, os, sys, sqlite3, tempfile, types, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
from database import Database
from utils import casemgmt as cm, helpers

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

class G:
    def __init__(self, gid=1): self.id, self.name, self.icon = gid, "G", None
class B:
    def __init__(self, db): self.db = db
NOW = int(time.time()); DAY = 86400
async def case(db, g, n, action, user, mod, reason, ago=0):
    await db.execute("INSERT INTO cases (guild_id,number,action,user_id,moderator_id,reason,created_at) "
                     "VALUES (?,?,?,?,?,?,?)", (g, n, action, user, mod, reason, NOW - int(ago * DAY)))

async def main():
    print("validacion")
    check("motivo corto rechazado", cm.validate_reason("ab") is not None)
    check("motivo vacio/None rechazado", cm.validate_reason("   ") is not None and cm.validate_reason(None) is not None)
    check("motivo largo rechazado", cm.validate_reason("x" * 901) is not None)
    check("motivo valido", cm.validate_reason("spam") is None)
    check("limite anulacion 500", cm.validate_reason("x" * 501, cm.MAX_VOID_REASON) is not None)
    check("_like escapa % _ \\", cm._like("a%b_c\\") == "%a\\%b\\_c\\\\%")

    print("migracion de BD antigua")
    tmp = tempfile.mkdtemp(); path = os.path.join(tmp, "old.db")
    raw = sqlite3.connect(path)
    raw.execute("CREATE TABLE cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id INTEGER NOT NULL, number INTEGER NOT NULL, "
                "action TEXT NOT NULL, user_id INTEGER NOT NULL, moderator_id INTEGER NOT NULL, reason TEXT, duration INTEGER, created_at INTEGER DEFAULT 0)")
    raw.execute("INSERT INTO cases (guild_id,number,action,user_id,moderator_id,reason,created_at) VALUES (1,1,'warn',5,7,'vieja',100)")
    raw.commit(); raw.close()
    db = Database(path); await db.connect(); await db.connect()
    cols = db._columns["cases"]
    check("columnas anadidas", {"voided_at", "voided_by", "void_reason", "edited_at"} <= cols)
    row = await db.fetchone("SELECT * FROM cases")
    check("caso antiguo intacto", row["reason"] == "vieja" and row["voided_at"] is None and row["edited_at"] is None)
    check("tabla case_audit creada", "case_audit" in db._columns)
    await db.execute("DELETE FROM cases")
    bot, g = B(db), G(1)

    print("busqueda")
    await case(db, 1, 1, "warn", 10, 7, "spam en general", 1)
    await case(db, 1, 2, "ban", 10, 8, "insultos 100% graves", 5)
    await case(db, 1, 3, "warn", 11, 7, "spam de enlaces", 40)
    await case(db, 1, 4, "timeout", 12, 8, "flood_extremo", 2)
    await case(db, 2, 1, "warn", 10, 7, "otro servidor", 1)
    rows, total = await cm.search(bot, 1)
    check("todos los del servidor 1 (4)", total == 4 and len(rows) == 4)
    check("orden descendente", [r["number"] for r in rows] == [4, 3, 2, 1])
    check("aislamiento por servidor", (await cm.search(bot, 2))[1] == 1)
    check("filtro usuario", (await cm.search(bot, 1, user_id=10))[1] == 2)
    check("filtro moderador", (await cm.search(bot, 1, moderator_id=8))[1] == 2)
    check("filtro accion", (await cm.search(bot, 1, action="warn"))[1] == 2)
    check("filtro dias=7", (await cm.search(bot, 1, days=7))[1] == 3)
    check("texto 'spam'", (await cm.search(bot, 1, text="spam"))[1] == 2)
    check("texto con % literal", (await cm.search(bot, 1, text="100%"))[1] == 1 and (await cm.search(bot, 1, text="%"))[1] == 1)
    check("texto con _ literal (no comodin)", (await cm.search(bot, 1, text="flood_"))[1] == 1 and (await cm.search(bot, 1, text="floodX"))[1] == 0)
    check("texto con comilla (inyeccion)", (await cm.search(bot, 1, text="' OR 1=1 --"))[1] == 0)
    check("filtros combinados", (await cm.search(bot, 1, user_id=10, action="warn", moderator_id=7))[1] == 1)
    rows, total = await cm.search(bot, 1, per_page=2)
    check("limite per_page con total real", len(rows) == 2 and total == 4)
    check("pagina 2", [r["number"] for r in (await cm.search(bot, 1, per_page=2, page=2))[0]] == [2, 1])
    check("estado invalido -> active", (await cm.search(bot, 1, state="zzz"))[1] == 4)

    print("editar")
    ok, msg = await cm.edit_reason(bot, g, 1, 7, False, "spam repetido")
    check("moderador del caso puede editar", ok)
    c = await db.fetchone("SELECT * FROM cases WHERE guild_id=1 AND number=1")
    check("motivo y edited_at actualizados", c["reason"] == "spam repetido" and c["edited_at"])
    a = await cm.audit_for_case(bot, 1, 1)
    check("auditoria guarda antes/despues", len(a) == 1 and a[0]["old_value"] == "spam en general"
          and a[0]["new_value"] == "spam repetido" and a[0]["actor_id"] == 7 and a[0]["action"] == "edit")
    ok, msg = await cm.edit_reason(bot, g, 1, 8, False, "intento ajeno")
    check("otro moderador no puede editar", not ok and (await cm.audit_count(bot, 1, 1)) == 1)
    ok, _ = await cm.edit_reason(bot, g, 1, 8, True, "editado por admin")
    check("admin puede editar cualquiera", ok)
    ok, msg = await cm.edit_reason(bot, g, 1, 8, True, "editado por admin")
    check("mismo motivo rechazado", not ok)
    check("caso inexistente", not (await cm.edit_reason(bot, g, 99, 7, True, "hola mundo"))[0])
    check("motivo corto no toca la BD", not (await cm.edit_reason(bot, g, 1, 8, True, "x"))[0]
          and (await cm.audit_count(bot, 1, 1)) == 2)
    check("no edita casos de otro servidor", not (await cm.edit_reason(bot, G(3), 1, 7, True, "hola mundo"))[0])

    print("anular / restaurar")
    check("no admin no anula", not (await cm.void_case(bot, g, 2, 7, False, "error del mod"))[0])
    check("anular sin motivo valido", not (await cm.void_case(bot, g, 2, 1, True, "ab"))[0])
    ok, msg = await cm.void_case(bot, g, 2, 1, True, "ban por error")
    check("admin anula", ok and "no se ha deshecho" in msg)
    c = await db.fetchone("SELECT * FROM cases WHERE guild_id=1 AND number=2")
    check("caso anulado, no borrado", c["voided_at"] and c["voided_by"] == 1 and c["void_reason"] == "ban por error")
    check("doble anulacion rechazada", not (await cm.void_case(bot, g, 2, 1, True, "otra vez"))[0])
    check("anulado no se edita", not (await cm.edit_reason(bot, g, 2, 1, True, "nuevo motivo"))[0])
    check("activos excluyen anulados", (await cm.search(bot, 1))[1] == 3)
    check("estado voided", [r["number"] for r in (await cm.search(bot, 1, state="voided"))[0]] == [2])
    check("estado all", (await cm.search(bot, 1, state="all"))[1] == 4)
    check("anular no toca warns/otros casos", await db.fetchval("SELECT COUNT(*) FROM cases WHERE guild_id=1") == 4)
    check("restaurar requiere admin", not (await cm.restore_case(bot, g, 2, 7, False))[0])
    check("restaurar caso no anulado", not (await cm.restore_case(bot, g, 1, 1, True))[0])
    check("restaurar ok", (await cm.restore_case(bot, g, 2, 1, True))[0])
    c = await db.fetchone("SELECT * FROM cases WHERE guild_id=1 AND number=2")
    check("restaurado: campos limpios", c["voided_at"] is None and c["void_reason"] is None)
    actions = [r["action"] for r in await cm.audit_for_case(bot, 1, 2)]
    check("auditoria: void y restore", sorted(actions) == ["restore", "void"])
    check("caso inexistente anular/restaurar", not (await cm.void_case(bot, g, 77, 1, True, "no existe"))[0]
          and not (await cm.restore_case(bot, g, 77, 1, True))[0])

    print("concurrencia")
    r = await asyncio.gather(*[cm.void_case(bot, g, 3, 1, True, f"motivo {i}") for i in range(5)])
    check("5 anulaciones simultaneas -> 1 exitosa", sum(1 for ok, _ in r if ok) == 1)
    check("una sola entrada de auditoria", await db.fetchval(
        "SELECT COUNT(*) FROM case_audit WHERE guild_id=1 AND case_number=3 AND action='void'") == 1)

    print("registro y formato")
    sent = []
    async def fake_send(b, gu, cat, embed): sent.append((cat, embed))
    orig = helpers.send_log; helpers.send_log = fake_send
    try:
        await cm.edit_reason(bot, g, 4, 8, False, "flood corregido")
        check("edicion publicada en casos_gestion", len(sent) == 1 and sent[0][0] == "casos_gestion")
        async def boom(*a, **k): raise RuntimeError("canal roto")
        helpers.send_log = boom
        ok, _ = await cm.edit_reason(bot, g, 4, 8, False, "flood corregido 2")
        check("fallo del log no rompe la edicion", ok)
    finally:
        helpers.send_log = orig
    line = cm.format_line({"number": 5, "action": "warn", "created_at": 1, "voided_at": 9})
    check("linea marca ANULADO", "ANULADO" in line and "#5" in line)
    val = cm.format_value({"user_id": 1, "moderator_id": 2, "reason": "r", "voided_at": 9, "edited_at": 3})
    check("valor tachado y marca editado", val.startswith("~~") and "editado" in val)
    check("valor sin anular no tachado", not cm.format_value({"user_id": 1, "moderator_id": 2, "reason": "r"}).startswith("~~"))
    await db.execute("INSERT INTO appeals (guild_id,case_number,user_id,reason,status,created_at) VALUES (1,1,10,'x','pending',1)")
    check("appeal_status", await cm.appeal_status(bot, 1, 1) == "pending" and await cm.appeal_status(bot, 1, 4) is None)

    await db.close()
    print(f"\n{passed} ok, {failed} fallos")
    sys.exit(1 if failed else 0)

asyncio.run(main())
