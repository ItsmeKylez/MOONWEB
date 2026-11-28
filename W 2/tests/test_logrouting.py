"""Pruebas de canales de log por subcategoria (Stage 4B / Feature 02).
Ejecutar:  python tests/test_logrouting.py   (usa stubs si falta discord.py / aiosqlite)."""
import asyncio, os, sys, tempfile, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stubs import ROOT, STUB_DISCORD
from database import Database
from utils import helpers, logrouting as lr, eventtrack, escalation
import config, discord

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok  ", name)
    else: failed += 1; print("  FAIL", name)
NS = types.SimpleNamespace
cand = helpers.log_channel_candidates

async def main():
    print("definiciones")
    S, C = config.LOG_SUBCATEGORIES, config.LOG_CATEGORIES
    check("padres validos", all(p in C for p, _ in S.values()))
    check("sin choques con categorias", not set(S) & set(C))
    check("<= 25 choices", len(S) <= 25 and len(C) <= 25)
    check("claves en minusculas sin espacios", all(k == k.lower() and " " not in k for k in S))
    check("nombres <= 32 chars", all(len(k) <= 32 for k in S))

    print("candidatos de canal")
    check("categoria padre configurada", cand({"mensajes": 5}, "mensajes") == [5])
    check("categoria padre sin configurar", cand({}, "mensajes") == [])
    check("sub sin canal propio hereda", cand({"mensajes": 5}, "mensajes_borrados") == [5])
    check("sub con canal propio + respaldo padre", cand({"mensajes": 5, "mensajes_borrados": 9}, "mensajes_borrados") == [9, 5])
    check("sub con canal propio sin padre", cand({"mensajes_borrados": 9}, "mensajes_borrados") == [9])
    check("sub silenciada (0) no envia", cand({"mensajes": 5, "mensajes_borrados": 0}, "mensajes_borrados") == [])
    check("silenciar una sub no afecta a la hermana", cand({"mensajes": 5, "mensajes_borrados": 0}, "mensajes_editados") == [5])
    check("categoria desconocida sin canal", cand({"mensajes": 5}, "zzz") == [])
    check("sub sin nada", cand({}, "antispam") == [])

    print("describe")
    check("sub heredada", "hereda de **mensajes**" in lr.describe({"mensajes": 5}, "mensajes_borrados"))
    check("sub propia", lr.describe({"mensajes_borrados": 9}, "mensajes_borrados") == "<#9>")
    check("sub silenciada", "silenciado" in lr.describe({"mensajes_borrados": 0, "mensajes": 5}, "mensajes_borrados"))
    check("sub sin configurar", lr.describe({}, "antispam") == "sin configurar")
    check("padre", lr.describe({"mensajes": 5}, "mensajes") == "<#5>")
    ls = lr.lines({"mensajes": 5})
    check("lines incluye todas las subcategorias", sum(1 for l in ls if l.lstrip().startswith("`")) == len(S))
    check("lines incluye todas las categorias", sum(1 for l in ls if l.startswith("**")) == len(C))

    print("asignacion en BD")
    tmp = tempfile.mkdtemp(); db = Database(os.path.join(tmp, "t.db")); await db.connect()
    bot = NS(db=db)
    check("asignar sub", await lr.assign(bot, 1, "mensajes_borrados", 77))
    check("se guarda en log_channels", (await db.get_log_channels(1)).get("mensajes_borrados") == 77)
    check("silenciar guarda 0", await lr.assign(bot, 1, "mensajes_borrados", lr.MUTED) and (await db.get_log_channels(1))["mensajes_borrados"] == 0)
    check("quitar borra la fila", await lr.assign(bot, 1, "mensajes_borrados", None) and "mensajes_borrados" not in await db.get_log_channels(1))
    check("no asigna categorias padre ni desconocidas", not await lr.assign(bot, 1, "mensajes", 5) and not await lr.assign(bot, 1, "zzz", 5))
    check("otro servidor aislado", "mensajes_borrados" not in await db.get_log_channels(2))
    await lr.assign(bot, 1, "bans", 4)
    check("subs no cuentan como categorias de config", [k for k in await db.get_log_channels(1) if k in C] == [])

    print("permisos del canal")
    me = object()
    mk = lambda **p: NS(mention="#c", permissions_for=lambda m: NS(**{"view_channel": True, "send_messages": True, "embed_links": True, **p}))
    check("canal valido", lr.check_channel(mk(), me) is None)
    check("falta enviar", "Enviar mensajes" in lr.check_channel(mk(send_messages=False), me))
    check("falta embeds + ver", all(x in lr.check_channel(mk(embed_links=False, view_channel=False), me) for x in ("Insertar enlaces", "Ver canal")))

    print("send_log con respaldo")
    class Chan(discord.TextChannel):
        def __init__(self, cid, ok=True, boom=False):
            self.id, self.ok, self.boom, self.sent = cid, ok, boom, []
        def permissions_for(self, me): return NS(send_messages=self.ok, embed_links=self.ok)
        async def send(self, **kw):
            if self.boom: raise discord.Forbidden.__new__(discord.Forbidden) if hasattr(discord, "Forbidden") else RuntimeError()
            self.sent.append(kw); return "msg"
    chans = {}
    guild = NS(id=1, me=object(), get_channel=lambda cid: chans.get(cid))
    for k in list(await db.get_log_channels(1)): await db.set_log_channel(1, k, None)
    chans.update({10: Chan(10), 20: Chan(20)})
    await db.set_log_channel(1, "mensajes", 10)
    emb = object()
    await helpers.send_log(bot, guild, "mensajes_borrados", emb)
    check("sub sin canal propio -> canal padre", len(chans[10].sent) == 1)
    await lr.assign(bot, 1, "mensajes_borrados", 20)
    await helpers.send_log(bot, guild, "mensajes_borrados", emb)
    await helpers.send_log(bot, guild, "mensajes_editados", emb)
    check("sub con canal propio -> su canal", len(chans[20].sent) == 1)
    check("hermana sigue en el padre", len(chans[10].sent) == 2)
    await helpers.send_log(bot, guild, "mensajes", emb)
    check("categoria padre sigue en su canal", len(chans[10].sent) == 3 and len(chans[20].sent) == 1)
    del chans[20]
    await helpers.send_log(bot, guild, "mensajes_borrados", emb)
    check("canal propio borrado -> respaldo en el padre", len(chans[10].sent) == 4)
    chans[20] = Chan(20, ok=False)
    await helpers.send_log(bot, guild, "mensajes_borrados", emb)
    check("canal propio sin permisos -> respaldo en el padre", len(chans[10].sent) == 5 and not chans[20].sent)
    await lr.assign(bot, 1, "mensajes_borrados", lr.MUTED)
    await helpers.send_log(bot, guild, "mensajes_borrados", emb)
    check("silenciada no envia a ninguno", len(chans[10].sent) == 5)
    await lr.assign(bot, 1, "mensajes_borrados", None)
    await helpers.send_log(bot, guild, "mensajes_borrados", emb)
    check("tras quitar vuelve al padre", len(chans[10].sent) == 6)
    check("guild None no falla", await helpers.send_log(bot, None, "mensajes", emb) is None)

    print("eventos nuevos y existentes usan categorias validas")
    valid = set(C) | set(S)
    check("eventtrack.EVENTS", all(v[1] in valid for v in eventtrack.EVENTS.values()))
    import re, glob
    bad = []
    for f in glob.glob(os.path.join(ROOT, "cogs", "*.py")) + glob.glob(os.path.join(ROOT, "utils", "*.py")):
        for m in re.finditer(r'send_log\(\s*(?:self\.)?bot,\s*[\w.]+,\s*"([a-z_]+)"', open(f, encoding="utf-8").read()):
            if m.group(1) not in valid: bad.append((os.path.basename(f), m.group(1)))
    check(f"todas las llamadas literales a send_log usan categorias validas {bad}", not bad)

    await db.close()
    print(f"\n{passed} ok, {failed} fallos")
    sys.exit(1 if failed else 0)

asyncio.run(main())
