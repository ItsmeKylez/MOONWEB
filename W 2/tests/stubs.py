"""Stubs compartidos por las pruebas (solo se activan si faltan discord.py / aiosqlite)."""
import os, sys, sqlite3, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# --------------------------------------------------------------- stubs ----
try:
    import discord  # noqa
    STUB_DISCORD = False
except ImportError:
    STUB_DISCORD = True
    class _Meta(type):
        def __getattr__(cls, name):
            if name.startswith("__"):
                raise AttributeError(name)
            return "stub"
    class _Permissive(types.ModuleType):
        """Modulo falso: cualquier atributo pedido es una clase vacia."""
        def __getattr__(self, name):
            if name.startswith("__"):
                raise AttributeError(name)
            cls = _Meta(name, (), {"__init__": lambda self, *a, **k: None,
                                   "__call__": lambda self, f=None, *a, **k: f})
            setattr(self, name, cls)
            return cls
    d = _Permissive("discord")
    class HTTPException(Exception): pass
    class Forbidden(HTTPException): pass
    class NotFound(HTTPException): pass
    class Embed:
        def __init__(self, title=None, description=None, color=None):
            self.title, self.description, self.color = title, description, color
            self.fields = []; self.timestamp = None
        def add_field(self, name, value, inline=True): self.fields.append((name, value))
        def set_thumbnail(self, **k): pass
        def set_footer(self, **k): pass
        def set_author(self, **k): pass
    d.HTTPException, d.Forbidden, d.NotFound, d.Embed = HTTPException, Forbidden, NotFound, Embed
    d.AllowedMentions = types.SimpleNamespace(none=lambda: None)
    d.utils = types.SimpleNamespace(utcnow=lambda: None)
    d.abc = _Permissive("discord.abc")
    d.app_commands = _Permissive("discord.app_commands")
    d.ui = _Permissive("discord.ui")
    d.ext = _Permissive("discord.ext")
    d.ext.commands = _Permissive("discord.ext.commands")
    sys.modules.update({"discord": d, "discord.abc": d.abc, "discord.app_commands": d.app_commands,
                        "discord.ui": d.ui, "discord.ext": d.ext, "discord.ext.commands": d.ext.commands})

try:
    import aiosqlite  # noqa
except ImportError:
    a = types.ModuleType("aiosqlite")
    class Row(sqlite3.Row): pass
    class _Cur:
        def __init__(self, cur): self.cur = cur; self.lastrowid = cur.lastrowid
        async def fetchone(self): return self.cur.fetchone()
        async def fetchall(self): return self.cur.fetchall()
        async def close(self): self.cur.close()
        async def __aenter__(self): return self
        async def __aexit__(self, *e): self.cur.close()
    class _Exec:
        def __init__(self, c, sql, p): self.c, self.sql, self.p = c, sql, p
        def __await__(self):
            async def go(): return _Cur(self.c.execute(self.sql, self.p))
            return go().__await__()
        async def __aenter__(self): return _Cur(self.c.execute(self.sql, self.p))
        async def __aexit__(self, *e): pass
    class Conn:
        def __init__(self, path):
            self.c = sqlite3.connect(path, check_same_thread=False); self.row_factory = None
        def __setattr__(self, k, v):
            object.__setattr__(self, k, v)
            if k == "row_factory": self.c.row_factory = v
        def execute(self, sql, p=()): return _Exec(self.c, sql, p)
        async def executescript(self, s): self.c.executescript(s)
        async def executemany(self, sql, seq): self.c.executemany(sql, seq)
        async def commit(self): self.c.commit()
        async def close(self): self.c.close()
    async def connect(path): return Conn(path)
    a.connect, a.Row, a.Connection = connect, Row, Conn
    sys.modules["aiosqlite"] = a

