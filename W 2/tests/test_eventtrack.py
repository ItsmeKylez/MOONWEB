"""Pruebas del seguimiento ampliado de eventos (Stage 4B / Feature 01).
Ejecutar:  python tests/test_eventtrack.py   (usa stubs si falta discord.py / aiosqlite)."""
import asyncio, os, sys, tempfile, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
from database import Database
from utils import eventtrack as et, helpers
import config

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)

class B:
    def __init__(self, db): self.db = db
NS = types.SimpleNamespace

async def main():
    print("registro de eventos")
    check("12 eventos definidos", len(et.EVENTS) == 12)
    cats = {v[1] for v in et.EVENTS.values()}
    check("todas las categorias existen en config.LOG_CATEGORIES", cats <= set(config.LOG_CATEGORIES) | set(config.LOG_SUBCATEGORIES))
    check("eventos ruidosos desactivados por defecto", not et.EVENTS["thread_member"][2] and not et.EVENTS["voice_stream"][2])
    check("nombres unicos <= 25 (limite de choices)", len(et.EVENTS) <= 25)

    print("activar / desactivar")
    tmp = tempfile.mkdtemp(); db = Database(os.path.join(tmp, "t.db")); await db.connect(); await db.connect()
    check("tabla event_toggles creada", "event_toggles" in db._columns)
    bot = B(db)
    check("defecto on", await et.is_enabled(bot, 1, "stage"))
    check("defecto off", not await et.is_enabled(bot, 1, "voice_stream"))
    check("clave desconocida no activa", not await et.is_enabled(bot, 1, "nope") and not await et.set_enabled(bot, 1, "nope", True))
    await et.set_enabled(bot, 1, "stage", False)
    await et.set_enabled(bot, 1, "voice_stream", True)
    check("override guardado", not await et.is_enabled(bot, 1, "stage") and await et.is_enabled(bot, 1, "voice_stream"))
    check("otro servidor no afectado", await et.is_enabled(bot, 2, "stage") and not await et.is_enabled(bot, 2, "voice_stream"))
    await et.set_enabled(bot, 1, "stage", True)
    check("volver al defecto borra la fila", await db.fetchval("SELECT COUNT(*) FROM event_toggles WHERE guild_id=1 AND event='stage'") == 0)
    await et.set_enabled(bot, 1, "stage", True); await et.set_enabled(bot, 1, "stage", True)
    st = await et.status(bot, 1)
    check("status completo", set(st) == set(et.EVENTS) and st["voice_stream"] and st["stage"])

    print("emit")
    sent = []; ign = {"v": False}
    async def fake_send(b, g, cat, embed, **k): sent.append(cat)
    async def fake_ign(b, gid, ch, m): return ign["v"]
    o1, o2 = helpers.send_log, helpers.is_ignored; helpers.send_log, helpers.is_ignored = fake_send, fake_ign
    try:
        g = NS(id=1); e = et.embeds.base("x")
        check("emit activo -> categoria correcta", await et.emit(bot, g, "stage", e) and sent == ["voz"])
        await et.set_enabled(bot, 1, "stage", False)
        check("emit desactivado no envia", not await et.emit(bot, g, "stage", e) and sent == ["voz"])
        check("emit sin guild", not await et.emit(bot, None, "stage", e))
        await et.set_enabled(bot, 1, "stage", True); ign["v"] = True
        check("canal/miembro ignorado no envia", not await et.emit(bot, g, "stage", e, channel=object()) and len(sent) == 1)
        check("sin canal ni miembro no consulta ignorados", await et.emit(bot, g, "stage", e) and len(sent) == 2)
    finally:
        helpers.send_log, helpers.is_ignored = o1, o2

    print("deduplicacion")
    d = et.Deduper(ttl=5)
    check("primera vez no duplicado", not d.seen(("a", 1), now=100))
    check("repetido dentro del TTL", d.seen(("a", 1), now=102))
    check("otra clave no duplicada", not d.seen(("a", 2), now=102))
    check("pasado el TTL vuelve a pasar", not d.seen(("a", 1), now=200))
    d2 = et.Deduper(ttl=1, max_size=3)
    for i in range(10): d2.seen(("k", i), now=float(i * 10))
    check("poda de claves antiguas", len(d2._seen) <= 5)

    print("comparaciones")
    b = NS(name="a", archived=False, locked=False, slowmode_delay=0, auto_archive_duration=60)
    a = NS(name="b", archived=True, locked=False, slowmode_delay=5, auto_archive_duration=60)
    ch = et.diff_attrs(b, a, et.THREAD_ATTRS)
    check("hilo: 3 cambios", [c[0] for c in ch] == ["Nombre", "Archivado", "Modo lento (s)"])
    check("hilo: bool legible", ch[1][1:] == ("no", "si"))
    check("sin cambios -> vacio", et.diff_attrs(b, b, et.THREAD_ATTRS) == [])
    check("atributo ausente tolerado", et.diff_attrs(NS(), NS(name=1), {"name": "N"}) == [("N", "*ninguno*", "1")])
    check("valor largo truncado", len(et.diff_attrs(NS(d="x"), NS(d="y" * 999), {"d": "D"})[0][2]) <= 300)
    check("evento programado: estado", et.diff_attrs(NS(status="scheduled"), NS(status="active"), et.EVENT_ATTRS)[0][0] == "Estado")
    v = lambda **k: NS(**{"mute": False, "deaf": False, "self_stream": False, "self_video": False, **k})
    check("voz servidor mute", et.voice_server_changes(v(), v(mute=True)) == ["silenciado por el servidor"])
    check("voz servidor deaf off", et.voice_server_changes(v(deaf=True), v()) == ["ya no esta ensordecido por el servidor"])
    check("voz servidor sin cambios", et.voice_server_changes(v(), v()) == [])
    check("voz stream + camara", et.voice_stream_changes(v(), v(self_stream=True, self_video=True)) ==
          ["empieza a transmitir pantalla", "enciende la camara"])
    check("voz stream no confunde mute propio", et.voice_stream_changes(v(), v(mute=True)) == [])
    emb = et.change_embed("t", 1, [("L%d" % i, "a", "b") for i in range(15)])
    check("change_embed limita a 10 campos", len(emb.fields) == 10)

    await db.close()
    print(f"\n{passed} ok, {failed} fallos")
    sys.exit(1 if failed else 0)

asyncio.run(main())
