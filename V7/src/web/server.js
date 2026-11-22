// Add this to the existing server.js file (append at the end)

// ---------- Config API ----------
const configRoutes = require('./routes/config');
configRoutes(api);

// ---------- Analytics & Reporting API ----------
const analyticsRoutes = require('./routes/analytics');
analyticsRoutes(api);

// ---------- Scheduled Tasks API ----------
const scheduledRoutes = require('./routes/scheduled');
scheduledRoutes(api);

// ---------- Member Selector API ----------
api.get('/members', async (req, res) => {
  const { guildId } = req.query;
  if (!guildId) return res.status(400).json({ error: 'guildId required' });

  // Verify user can manage this guild
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'Bot not in that server' });

  const member = await guild.members.fetch(req.session?.user?.id).catch(() => null);
  if (!member || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return res.status(403).json({ error: 'You need Manage Server permission' });
  }

  const search = req.query.search || '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 50;

  // Fetch members from Discord
  let members = [];
  try {
    const fetched = await guild.members.list({ limit: 1000, after: (page - 1) * limit });
    members = fetched.filter((m) => {
      const lower = search.toLowerCase();
      return (
        m.user.username.toLowerCase().includes(lower) ||
        (m.nickname?.toLowerCase().includes(lower)) ||
        m.user.id.includes(lower) ||
        m.user.global_name?.toLowerCase().includes(lower)
      );
    });
    // If search narrowed results too much, get more
    if (members.length < limit && members.length < totalMembers) {
      const more = await guild.members.list({ limit: 200, after: members[members.length - 1].id });
      const filteredMore = more.filter((m) => {
        const lower = search.toLowerCase();
        return (
          m.user.username.toLowerCase().includes(lower) ||
          (m.nickname?.toLowerCase().includes(lower)) ||
          m.user.id.includes(lower) ||
          m.user.global_name?.toLowerCase().includes(lower)
        );
      });
      members = [...members, ...filteredMore.slice(0, limit - members.length)];
    }
  } catch (err) {
    console.error('Member fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch members' });
  }

  const total = members.length;

  // Sort by name then ID for consistency
  members.sort((a, b) => {
    const na = a.user.global_name || a.user.username;
    const nb = b.user.global_name || b.user.username;
    if (na.localeCompare(nb) !== 0) return na.localeCompare(nb);
    return a.user.id.localeCompare(b.user.id);
  });

  const paginated = members.slice(0, limit);

  // Format response
  const formatted = paginated.map((m) => ({
    id: m.user.id,
    username: m.user.username,
    global_name: m.user.global_name || m.user.username,
    nick: m.nickname || null,
    avatar: m.user.avatar || null,
    bot: m.user.bot || false,
    roles: m.roles.cache.map((r) => r.id),
    joined_at: m.joinedAt?.toISOString() || null
  }));

  res.json({
    members: formatted,
    total,
    page,
    pages: Math.ceil(total / limit)
    });
});

// Add this import at the top if not already present
const { PermissionFlagsBits } = require('discord.js');