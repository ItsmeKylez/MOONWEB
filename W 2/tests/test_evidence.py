"""Pruebas de las evidencias de casos (Stage 4A / Feature 02).
Ejecutar:  python tests/test_evidence.py   (usa stubs si falta discord.py)."""
import asyncio, os, sys, sqlite3, tempfile, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
import discord
from database import Database
from utils import evidence, modlog

class FakeAtt:
    def __init__(self, name="captura.png", data=b"x" * 2048, size=None, fail=False):
        self.filename, self._data, self.fail = name, data, fail
        self.size = len(data) if size is None else size
        self.content_type = "image/png"
    async def read(self):
        if self.fail: raise discord.HTTPException()
        return self._data

class FakeUser:
    id = 500; mention = "<@500>"
    display_avatar = types.SimpleNamespace(url="x")
    def __str__(self): return "bot"
class FakeGuild:
    id, name, icon, owner_id = 1, "G", None, 9
    def get_channel(self, _): return None
class FakeBot:
    def __init__(self, db): self.db, self.user = db, FakeUser()

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

async def main():
    print("nombres y validacion")
    sf = evidence.safe_filename
    check("traversal ../../etc/passwd saneado", "/" not in sf("../../etc/passwd") and ".." not in sf("../../etc/passwd"))
    check("ruta windows saneada", sf("C:\\x\\y\\foto.png") == "foto.png")
    check("nombre vacio -> archivo", sf("") == "archivo" and sf(None) == "archivo")
    check("caracteres raros", sf("ñandú 🔥.png") .endswith(".png") and " " not in sf("a b.png"))
    check("nombre largo acotado", len(sf("a" * 500 + ".png")) <= 70)
    v = evidence.validate_attachment
    check("None rechazado", v(None) is not None)
    check("vacio rechazado", v(FakeAtt(data=b"")) is not None)
    check("demasiado grande rechazado", v(FakeAtt(size=evidence.MAX_SIZE + 1)) is not None)
    check("normal aceptado", v(FakeAtt()) is None)

    tmp = tempfile.mkdtemp()
    db = Database(os.path.join(tmp, "data", "t.db")); await db.connect()
    bot = FakeBot(db)
    check("tabla case_evidence creada", "case_evidence" in db._columns)
    await modlog.create_case(bot, FakeGuild(), "warn", FakeUser(), FakeUser(), "x")

    print("guardar / listar")
    row, err = await evidence.add(bot, 1, 1, FakeAtt(), 7, "  prueba  ")
    check("add ok", row and not err)
    path = evidence.resolve_path(bot, row["stored_path"])
    check("archivo escrito con el contenido", path and open(path, "rb").read() == b"x" * 2048)
    check("nota recortada", row["note"] == "prueba")
    check("ruta dentro de data/evidence", path.startswith(os.path.realpath(os.path.join(tmp, "data", "evidence"))))
    r2, _ = await evidence.add(bot, 1, 1, FakeAtt("captura.png"), 8)
    check("mismo nombre no se pisa", r2["stored_path"] != row["stored_path"])
    check("count = 2", await evidence.count_for_case(bot, 1, 1) == 2)
    check("list ordenada", [r["id"] for r in await evidence.list_for_case(bot, 1, 1)] == [row["id"], r2["id"]])
    check("otro caso vacio", await evidence.count_for_case(bot, 1, 2) == 0)

    print("errores")
    _, e = await evidence.add(bot, 1, 1, FakeAtt(fail=True), 7)
    check("fallo de descarga -> error amable", e and "descargar" in e)
    _, e = await evidence.add(bot, 1, 1, FakeAtt(size=10, data=b"y" * (evidence.MAX_SIZE + 1)), 7)
    check("size mentirosa pero bytes grandes -> rechazado", e is not None)
    check("nada guardado tras los fallos", await evidence.count_for_case(bot, 1, 1) == 2)
    for i in range(evidence.MAX_PER_CASE - 2):
        await evidence.add(bot, 1, 1, FakeAtt(f"f{i}.png"), 7)
    _, e = await evidence.add(bot, 1, 1, FakeAtt(), 7)
    check(f"limite de {evidence.MAX_PER_CASE} por caso", e and "maximo" in e)

    print("seguridad de rutas")
    check("resolve_path rechaza ../", evidence.resolve_path(bot, "../t.db") is None)
    check("resolve_path rechaza absoluta", evidence.resolve_path(bot, "/etc/passwd") is None)

    print("borrado")
    check("quitar de otro servidor -> False", await evidence.remove(bot, 2, row["id"]) is False)
    check("archivo sigue existiendo", os.path.isfile(path))
    check("quitar ok", await evidence.remove(bot, 1, row["id"]) is True)
    check("fila y archivo borrados", not os.path.exists(path)
          and await db.fetchone("SELECT 1 FROM case_evidence WHERE id=?", (row["id"],)) is None)
    check("quitar inexistente -> False", await evidence.remove(bot, 1, 99999) is False)

    print("adjuntar al sancionar")
    check("sin adjunto -> ''", await evidence.attach_on_action(bot, 1, 2, None, 7) == "")
    msg = await evidence.attach_on_action(bot, 1, 2, FakeAtt(), 7)
    check("con adjunto -> confirmacion", "Evidencia #" in msg and await evidence.count_for_case(bot, 1, 2) == 1)
    msg = await evidence.attach_on_action(bot, 1, 2, FakeAtt(fail=True), 7)
    check("fallo -> aviso, sin excepcion", "no guardada" in msg)

    print("migracion BD antigua")
    old = os.path.join(tmp, "old.db"); c = sqlite3.connect(old)
    c.executescript(open(os.path.join(ROOT, "database", "schema.sql"), encoding="utf-8").read()
                    .split("-- --- EVIDENCIAS")[0].split("-- --- ESCALADA")[0])
    c.execute("INSERT INTO cases (guild_id,number,action,user_id,moderator_id) VALUES (1,1,'warn',1,1)")
    c.commit(); c.close()
    db2 = Database(old); await db2.connect()
    check("BD antigua migra y conserva casos",
          "case_evidence" in db2._columns and await db2.fetchval("SELECT COUNT(*) FROM cases", default=0) == 1)
    await db.close(); await db2.close()

asyncio.run(main())
print(f"\n{passed} correctas, {failed} fallidas" + ("  [con stubs de discord]" if STUB_DISCORD else ""))
sys.exit(1 if failed else 0)
