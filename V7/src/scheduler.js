const store = require('./db');
const { getSettings } = require('./settings');

function startScheduler() {
    const tick = async () => {
        const now = Date.now();
        const tasks = store.dueScheduled(now);
        for (const task of tasks) {
            store.removeScheduled(task.id);
            try {
                // Implement task execution logic based on task.action
                if (task.action === 'announce') {
                    const guild = client.guilds.cache.get(task.guild_id);
                    if (!guild) continue;
                    const channel = guild.channels.cache.get(task.channel_id);
                    if (!channel) continue;
                    channel.send(task.message);
                }
            } catch (err) {
                console.error('[scheduler]', err);
            }
        }
    };
    setInterval(tick, 60000); // Check every minute
    tick(); // Initial check
}

module.exports = { startScheduler };
