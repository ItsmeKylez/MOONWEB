const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Collection, Events } = require('discord.js');
const config = require('./config');
const store = require('./db');
const { register, startScheduler } = require('./events');
const { createServer } = require('./web/server');

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

if (!config.token || !config.clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env (or set Railway variables) and fill them in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged – enable in the Developer Portal
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged – enable in the Developer Portal
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Load slash commands from src/commands/*.js (each file exports an array of { data, execute }).
const commands = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter((f) => f.endsWith('.js'))) {
  for (const cmd of require(path.join(__dirname, 'commands', file))) commands.set(cmd.data.name, cmd);
}

register(client, commands);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} · ${c.guilds.cache.size} server(s)`);
  try {
    const body = [...commands.values()].map((cmd) => cmd.data.toJSON());
    if (config.devGuildId) {
      await c.application.commands.set(body, config.devGuildId);
      console.log(`Registered ${body.length} commands in dev guild ${config.devGuildId}`);
    } else {
      await c.application.commands.set(body);
      console.log(`Registered ${body.length} global commands (can take a few minutes to appear)`);
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
  startScheduler(client);
});

// Dashboard starts first so Railway's health check passes even while Discord connects.
createServer(client).listen(config.port, '0.0.0.0', () => {
  console.log(`Dashboard listening on port ${config.port} (${config.baseUrl})`);
});

setInterval(() => store.purgeSessions(), 6 * 3600 * 1000).unref();

client.login(config.token).catch((err) => {
  console.error('Discord login failed:', err.message);
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    client.destroy();
    process.exit(0);
  });
}
