"""Pruebas de los informes de actividad (Stage 4A / Feature 04).
Ejecutar:  python tests/test_modreports.py   (usa stubs si falta discord.py)."""
import asyncio, csv, io, os, sys, sqlite3, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
from database import Database
from utils import modreports as mr

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

class B:
    def __init__(self, db): self.db = db

NOW = int(time.time()); DAY = 86400
BOT = 500

async def case(db, g, n, action, user, mod, ago_days):
    await db.execute("INSERT INTO cases (guild_id,number,action,user_id,moderator_id,reason,created_at) "
                     "VALUES (?,?,?,?,?,?,?)", (g, n, action, user, mod, "r", NOW - int(ago_days * DAY)))

async def main():
    print("logica pura")
    check("kind warn", mr.kind_of("warn") == "sanctions")
    check("kind unban", mr.kind_of("unban") == "reversals")
    check("kind desconocido", mr.kind_of("purge") == "other")
    check("since 30d", mr.since_ts(30, now=1_000_000) == 1_000_000 - 30 * DAY)
    check("since acota <1 y >365", mr.since_ts(0, now=10**7) == 10**7 - DAY and mr.since_ts(9999, now=10**7) == 10**7 - 365 * DAY)
    check("_csv_safe formulas", mr._csv_safe("=1+1") == "'=1+1" and mr._csv_safe("@x") == "'@x"
          and mr._csv_safe("-2") == "'-2" and mr._csv_safe("Ana") == "Ana" and mr._csv_safe("") == "")

    tmp = tempfile.mkdtemp()
    db = Database(os.path.join(tmp, "t.db")); await db.connect(); bot = B(db)
    # servidor 1: mod 7 (3 ban + 1 warn + 1 unban), mod 8 (2 warn), bot (4 timeout), caso viejo de mod 7
    n = 0
    for action, mod, ago in [("ban",7,1),("ban",7,2),("ban",7,3),("warn",7,0.5),("unban",7,1),
                             ("warn",8,2),("warn",8,5),("timeout",BOT,1),("timeout",BOT,1),
                             ("timeout",BOT,2),("timeout",BOT,3),("ban",7,60),("kick",9,100)]:
        n += 1; await case(db, 1, n, action, 100 + n, mod, ago)
    await case(db, 2, 1, "ban", 1, 7, 1)   # otro servidor: no debe mezclarse

    print("agregacion (30 dias)")
    d = await mr.gather(bot, 1, mr.since_ts(30), BOT)
    m7, m8 = d["moderators"][7], d["moderators"][8]
    check("mod 7: 4 sanciones (caso de hace 60d excluido)", m7["sanctions"] == 4)
    check("mod 7: 1 reversion", m7["reversals"] == 1 and m7["total"] == 5)
    check("mod 7 por accion", m7["by_action"] == {"ban": 3, "warn": 1, "unban": 1})
    check("mod 8: 2 sanciones", m8["sanctions"] == 2)
    check("bot separado de los humanos", BOT not in d["moderators"] and d["automated"]["sanctions"] == 4)
    check("mod 9 (hace 100d) fuera del periodo", 9 not in d["moderators"])
    check("totales del servidor", d["totals"]["sanctions"] == 10 and d["totals"]["reversals"] == 1 and d["totals"]["total"] == 11)
    check("otro servidor no se mezcla", d["by_action"]["ban"] == 3)
    check("first/last del mod 7", m7["first"] < m7["last"] and abs(m7["last"] - (NOW - DAY // 2)) < 5)
    d90 = await mr.gather(bot, 1, mr.since_ts(365), BOT)
    check("periodo 365d incluye casos viejos", d90["moderators"][7]["sanctions"] == 5 and 9 in d90["moderators"])
    d1 = await mr.gather(bot, 1, mr.since_ts(1), BOT)
    check("periodo 1d: el warn de hace 12h cuenta", d1["moderators"][7]["by_action"].get("warn") == 1)
    check("periodo 1d: mod 8 (casos de hace 2d y 5d) queda fuera", 8 not in d1["moderators"])
    check("periodo 1d: ban de hace 2d y 3d excluidos", d1["moderators"][7]["by_action"].get("ban", 0) <= 1)

    print("apelaciones y evidencias")
    await db.execute("INSERT INTO appeals (guild_id,case_number,user_id,reason,status,created_at,reviewed_by,reviewed_at) VALUES (1,1,1,'x','accepted',?,8,?)", (NOW - DAY, NOW - 3600))
    await db.execute("INSERT INTO appeals (guild_id,case_number,user_id,reason,status,created_at,reviewed_by,reviewed_at) VALUES (1,2,2,'x','denied',?,8,?)", (NOW - DAY, NOW - 3600))
    await db.execute("INSERT INTO appeals (guild_id,case_number,user_id,reason,status,created_at) VALUES (1,3,3,'x','pending',?)", (NOW - 100,))
    await db.execute("INSERT INTO appeals (guild_id,case_number,user_id,reason,status,created_at,reviewed_by,reviewed_at) VALUES (1,4,4,'x','accepted',?,8,?)", (NOW - 90 * DAY, NOW - 89 * DAY))
    for _ in range(3):
        await db.execute("INSERT INTO case_evidence (guild_id,case_number,filename,stored_path,added_by,added_at) VALUES (1,1,'a','p',7,?)", (NOW - 100,))
    await db.execute("INSERT INTO case_evidence (guild_id,case_number,filename,stored_path,added_by,added_at) VALUES (1,1,'a','p',7,?)", (NOW - 80 * DAY,))
    d = await mr.gather(bot, 1, mr.since_ts(30), BOT)
    check("apelaciones resueltas por mod 8", d["moderators"][8]["appeals_accepted"] == 1 and d["moderators"][8]["appeals_denied"] == 1)
    check("apelacion resuelta hace 89d no cuenta en 30d", d["appeals"]["accepted"] == 1)
    check("resumen de apelaciones", d["appeals"]["submitted"] == 3 and d["appeals"]["pending_now"] == 1 and d["appeals"]["denied"] == 1)
    check("evidencias en periodo (3 de 4)", d["moderators"][7]["evidence"] == 3)
    await db.execute("INSERT INTO case_evidence (guild_id,case_number,filename,stored_path,added_by,added_at) VALUES (1,1,'a','p',77,?)", (NOW - 10,))
    d = await mr.gather(bot, 1, mr.since_ts(30), BOT)
    check("quien solo sube evidencia aparece como activo", d["moderators"][77]["evidence"] == 1 and d["moderators"][77]["sanctions"] == 0)

    print("ranking / inactivos")
    rk = mr.ranking(d)
    check("ranking por sanciones", [m for m, _ in rk][:2] == [7, 8])
    check("limite del ranking", len(mr.ranking(d, 1)) == 1)
    check("inactivos: staff sin nada", mr.inactive([7, 8, 55, 66, 77], d) == [55, 66])
    check("inactivos: todos activos -> vacio", mr.inactive([7, 8], d) == [])

    print("sin datos / bot_id None")
    empty = await mr.gather(bot, 999, mr.since_ts(30), BOT)
    check("servidor sin casos", empty["totals"]["total"] == 0 and empty["moderators"] == {} and empty["automated"] is None
          and mr.ranking(empty) == [])
    nb = await mr.gather(bot, 1, mr.since_ts(30), None)
    check("bot_id None -> el bot cuenta como un moderador mas", BOT in nb["moderators"] and nb["automated"] is None)

    print("CSV")
    names = {7: "=HYPERLINK(\"x\")", 8: "Ana, la \"jefa\""}
    d = await mr.gather(bot, 1, mr.since_ts(30), BOT)
    rows = list(csv.reader(io.StringIO(mr.to_csv(d, names))))
    head = rows[0]
    check("cabecera con columnas por accion", "action_ban" in head and "sanctions" in head and head[0] == "moderator_id")
    by_id = {r[0]: r for r in rows[1:]}
    check("fila por moderador + fila automatica", {"7", "8", "77", "automatic"} <= set(by_id))
    check("inyeccion de formulas neutralizada", by_id["7"][1].startswith("'="))
    check("comas y comillas bien escapadas", by_id["8"][1] == 'Ana, la "jefa"')
    check("conteos coherentes", by_id["7"][head.index("sanctions")] == "4" and by_id["automatic"][head.index("sanctions")] == "4")
    check("todas las filas tienen el mismo ancho", len({len(r) for r in rows}) == 1)

    print("recientes")
    rc = await mr.recent_cases(bot, 1, 7, mr.since_ts(30))
    check("recent_cases orden desc y filtra periodo", [r["number"] for r in rc] == sorted([r["number"] for r in rc], reverse=True)
          and len(rc) == 5)
    check("recent_cases respeta limite", len(await mr.recent_cases(bot, 1, 7, mr.since_ts(30), limit=2)) == 2)
    await db.close()

asyncio.run(main())
print(f"\n{passed} correctas, {failed} fallidas" + ("  [con stubs de discord]" if STUB_DISCORD else ""))
sys.exit(1 if failed else 0)
