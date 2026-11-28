# Bot de seguridad y soporte para Discord

Bot en Python con sistema de tickets, registro de eventos, anti-nuke, anti-raid,
anti-spam, moderacion, copias de seguridad y base de datos local SQLite.
Todo se configura desde Discord con comandos de barra: no hay que tocar el codigo.

## Requisitos

- Python 3.11 o superior
- Los intents privilegiados **SERVER MEMBERS** y **MESSAGE CONTENT** activados
  en el Developer Portal

## Instalacion

```
python -m venv venv
venv\Scripts\activate          # Windows
source venv/bin/activate       # Linux o macOS
pip install -r requirements.txt
copy .env.example .env         # y rellena DISCORD_TOKEN y OWNER_ID
python bot.py
```

## Variables de entorno

| Variable | Obligatoria | Para que sirve |
|---|---|---|
| `DISCORD_TOKEN` | si | Token del bot |
| `OWNER_ID` | si | Tu ID de usuario, para `!sync` y `!reload` |
| `DEV_GUILD_ID` | no | Sincroniza los comandos al instante en ese servidor |
| `PREFIX` | no | Prefijo de los comandos de texto (por defecto `!`) |

## Estructura

```
bot.py              Arranque, carga de cogs y sincronizacion de comandos
config.py           Colores, emojis y valores por defecto
database/
  db.py             Conexion, cache y validacion de columnas
  schema.sql        Esquema completo (se aplica en cada arranque)
utils/
  embeds.py         Fabricas de embeds
  helpers.py        Logs, audit log, jerarquia y analisis de texto
  modlog.py         Casos de moderacion
  transcripts.py    Transcripts de ticket en HTML y texto
  images.py         Banner de bienvenida y captcha (Pillow)
  checks.py         Comprobaciones de staff y administrador
  paginator.py      Paginador de embeds
  time_parser.py    "2h30m" <-> segundos
  logger.py         Logging a consola y archivo rotativo
web/
  server.py         Dashboard API, Discord login and sessions (aiohttp)
  schema.py         Every setting the dashboard can edit
  static/           The dashboard interface (HTML, CSS, JS; no build step)
cogs/
  dashboard.py      Starts the dashboard inside the bot
  tickets.py        Paneles, tickets, transcripts y valoraciones
  logs.py           Registro de todos los eventos del servidor
  antinuke.py       Limites por ventana + reversion del daño
  antiraid.py       Oleadas de entradas, filtros y lockdown
  antispam.py       Sistema de puntos y filtro de palabras
  moderation.py     Sanciones, avisos, purgas y bloqueo de canales
  backups.py        Copias de la estructura del servidor
  verification.py   Verificacion con captcha
  welcome.py        Bienvenidas, despedidas y autorole
  levels.py         Niveles por actividad
  rolemenu.py       Menus de roles autoasignables
  utility.py        Informacion y utilidades
  config_cog.py     Asistente inicial, roles, logs e ignorados
  tasks_cog.py      Tareas periodicas
  errors.py         Manejo global de errores
data/               Se crea sola: bot.db, logs y copias
```

## Primeros pasos en el servidor

1. `/setup` — crea la categoria de registros con un canal por tipo de evento
   y activa las tres protecciones.
2. `/config staff` — rol que podra usar los comandos de moderacion.
3. `/antinuke permitir` — añade a la lista blanca a cada administrador de confianza.
4. `/panel crear`, `/panel categoria` y `/panel publicar` — sistema de tickets.
5. `/backup crear` — guarda la estructura del servidor.

## Comandos de texto (solo el dueño del bot)

- `!sync` — sincroniza los comandos en el servidor actual (inmediato)
- `!sync global` — sincroniza globalmente (hasta 1 hora)
- `!reload cogs.tickets` — recarga un modulo sin reiniciar

## Web dashboard

The bot can serve a website where server admins manage everything from the
browser: anti-nuke, anti-raid, anti-spam, word filter, trusted users, welcome
messages, levels and rewards, ticket rules, log channels, ignored targets, and
read-only views of cases, warnings, tickets, panels and backups. It runs inside
the bot process and uses the same database, so changes apply instantly.

Who can sign in: anyone the bot already treats as an admin in a server
(Discord administrators, the owner, or the configured admin role). They only see
servers where the bot is present.

Setup:

1. Developer Portal > your application > OAuth2: copy the **Client ID** and
   **Client Secret**, and add this redirect: `http://localhost:8080/auth/callback`
   (use your real address when hosting it).
2. In `.env` set `DASHBOARD_ENABLED=1`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
   and `DASHBOARD_URL` (see `.env.example`).
3. Start the bot and open `http://localhost:8080`.

To host it publicly, keep `DASHBOARD_HOST=127.0.0.1`, put Caddy or nginx with
HTTPS in front, and set `DASHBOARD_URL` to the public https address. Sessions
are kept in memory, so everyone signs in again after a bot restart.

### Deploying on Railway

1. **Add a Volume** to the service and mount it at `/app/data`. The bot keeps
   everything (tickets, warnings, settings, backups) in `data/bot.db`; without
   a volume Railway wipes it on every deploy.
2. Service > Settings > Networking > **Generate Domain**. Railway sets `PORT`
   and `RAILWAY_PUBLIC_DOMAIN` itself and the dashboard picks them up.
3. Variables: `DISCORD_TOKEN`, `OWNER_ID`, `DASHBOARD_ENABLED=1`,
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`.
4. Developer Portal > OAuth2 > Redirects: add
   `https://<your-domain>.up.railway.app/auth/callback`.
5. Make sure `venv/` and `.env` are not in the repo (`.gitignore` already
   excludes them).

Not in the dashboard (still Discord commands): publishing ticket panels,
moderation actions (ban, kick, mute), creating and restoring backups, `/setup`.

Code lives in `web/` (`server.py` API + OAuth, `schema.py` the editable
settings, `static/` the interface) and `cogs/dashboard.py` starts it. Adding a
new setting to a form takes one line in `web/schema.py`.

## Notas

- La base de datos es un unico archivo, `data/bot.db`. Haz copias periodicas:
  ahi estan los tickets, los avisos, la configuracion y las copias del servidor.
  El bot ya guarda una copia automatica diaria en `data/backups/`.
- El rol del bot debe estar lo mas arriba posible: no puede actuar sobre roles
  situados por encima del suyo.
- Los botones de los paneles y de los tickets son persistentes: siguen
  funcionando despues de reiniciar el bot.

## Escalada automatica de avisos

Desactivada por defecto. Un administrador define umbrales y la activa:

```
/escalada agregar avisos:3 accion:timeout duracion:1h
/escalada agregar avisos:5 accion:ban duracion:7d
/escalada activar estado:on
```

`/escalada lista`, `/escalada historial [usuario]` y `/escalada quitar avisos:N` completan el grupo.

## Evidencias de casos

`/evidencia agregar|ver|quitar`, o adjunta `evidencia:` directamente en `/warn`, `/ban`, `/kick` y `/timeout`. Los archivos se guardan en `data/evidence/` (monta un volumen en `data/` en Railway para que persistan).

## Apelaciones

Activa con `/apelacion config estado:on dias:30`. Los sancionados (ban, aislamiento, aviso) reciben un boton de apelacion en el DM; el staff resuelve con `/apelacion lista|ver|aceptar|denegar`. Aceptar deshace la sancion. Fija un canal con `/config logs` categoria `apelaciones`.

## Informes de moderadores

`/modreporte resumen|moderador|exportar [dias]`. Los administradores ven todo el staff; un moderador solo puede consultar su propia actividad. Las acciones automaticas del bot se cuentan aparte.
