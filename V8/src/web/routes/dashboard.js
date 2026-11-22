'use strict';
/* Dashboard overview analytics. Mounted under /api/guilds/:guildId, so the parent guard (session, bot in server,
   Manage Server — re-checked on every request) applies. Every query is scoped to req.guild.id; no ids come from the client.
   GET /dashboard/summary                        live member stats + headline numbers (polled)
   GET /dashboard/growth?range&bucket&tz         joins / leaves / net per bucket
   GET /dashboard/moderation?range&bucket&tz     moderation analytics
   GET /dashboard/staff?range                    staff leaderboard
   GET /dashboard/announcements?range&bucket&tz  announcement delivery stats
   GET /dashboard/events?category&after&limit    recent server events */
const dash = require('../../utils/dashfmt');
const svc = require('../../dashboard');

module.exports = function mount(api) {
  const base = '/guilds/:guildId/dashboard';
  const opts = (q) => {
    const range = dash.parseRange(q.range);
    return { range, bucket: dash.parseBucket(range, q.bucket), tz: dash.parseTz(q.tz) };
  };
  const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

  api.get(`${base}/summary`, async (req, res) => { noStore(res); res.json(await svc.summary(req.guild)); });
  api.get(`${base}/growth`, (req, res) => { noStore(res); res.json(svc.memberGrowth(req.guild.id, opts(req.query))); });
  api.get(`${base}/moderation`, (req, res) => { noStore(res); res.json(svc.moderationAnalytics(req.guild.id, opts(req.query))); });
  api.get(`${base}/staff`, async (req, res) => { noStore(res); res.json(await svc.staffLeaderboard(req.guild, { range: dash.parseRange(req.query.range) })); });
  api.get(`${base}/announcements`, (req, res) => { noStore(res); res.json(svc.announcementStats(req.guild.id, opts(req.query))); });
  api.get(`${base}/events`, (req, res) => {
    noStore(res);
    res.json({
      events: svc.recentServerEvents(req.guild.id, { category: req.query.category, after: req.query.after, limit: req.query.limit }),
      generatedAt: Date.now(),
    });
  });
};
