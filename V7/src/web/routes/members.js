'use strict';
/* Member lookup for the dashboard's Members page and user pickers.
   Mounted under /api/guilds/:guildId (parent guard applies).
   GET /members?q=<search>&after=<user id>  ->  { members, next }
   With `q` it uses Discord's member search; without it, it pages through the member list (cursor = last id). */
const SNOWFLAKE = /^\d{17,20}$/;
const PAGE = 50;

const shape = (m) => ({
  id: m.id,
  username: m.user.username,
  global_name: m.user.globalName || null,
  nick: m.nickname || null,
  avatar: m.user.avatar || null,
  bot: !!m.user.bot,
  joined_at: m.joinedTimestamp || null,
});

module.exports = function mount(api) {
  api.get('/guilds/:guildId/members', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const after = typeof req.query.after === 'string' && SNOWFLAKE.test(req.query.after) ? req.query.after : undefined;

    let list;
    try {
      if (q) {
        if (SNOWFLAKE.test(q)) {
          const one = await req.guild.members.fetch(q).catch(() => null);
          list = one ? [one] : [];
        } else {
          list = [...(await req.guild.members.search({ query: q, limit: PAGE })).values()];
        }
      } else {
        list = [...(await req.guild.members.list({ limit: PAGE, ...(after ? { after } : {}) })).values()];
      }
    } catch (err) {
      console.warn('[members]', err.message);
      return res.status(502).json({ error: 'Discord did not return the member list. Try again in a moment.' });
    }

    list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    res.json({ members: list.map(shape), next: !q && list.length === PAGE ? list[list.length - 1].id : null });
  });
};
