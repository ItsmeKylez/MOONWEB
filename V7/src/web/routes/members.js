'use strict';
/* Server Member Selector API. Mounted under /api/guilds/:guildId/members.
   Fetches real members from the Discord guild with search, pagination, and caching. */

const express = require('express');
const { PermissionFlagsBits } = require('discord.js');

const MEMBER_CACHE_TTL = 60 * 1000; // 1 minute cache for member lists
const memberCache = new Map(); // guildId -> { data: [...], expiresAt: timestamp }

function buildMemberPayload(member) {
  return {
    id: member.id,
    username: member.user.username,
    globalName: member.user.global_name || null,
    discriminator: member.user.discriminator,
    avatar: member.user.avatar,
    nickname: member.nickname,
    joinedAt: member.joinedTimestamp,
    bot: member.user.bot,
  };
}

async function fetchMembers(guild, query = '', limit = 50, after = null) {
  const cacheKey = guild.id;
  const cached = memberCache.get(cacheKey);
  const now = Date.now();

  // Return cached data if valid and no search query
  if (!query && cached && cached.expiresAt > now) {
    let data = cached.data;
    if (after) data = data.filter(m => m.id > after);
    return { members: data.slice(0, limit), cached: true };
  }

  // Fetch fresh members from Discord
  let members;
  try {
    // Use fetch with query for searching, or list for full fetch
    if (query && query.length >= 2) {
      // Search by username, global name, nickname, or ID
      const searchLower = query.toLowerCase();
      members = await guild.members.fetch({ query, limit: 100 });
      members = members.filter(m => {
        const user = m.user;
        const nick = m.nickname?.toLowerCase() || '';
        const uname = user.username.toLowerCase();
        const gname = (user.global_name || '').toLowerCase();
        return user.id === query ||
               uname.includes(searchLower) ||
               gname.includes(searchLower) ||
               nick.includes(searchLower);
      });
    } else {
      // Full fetch for initial load - use list() which handles pagination
      members = await guild.members.fetch({ limit: 1000 });
    }

    const memberArray = [...members.values()]
      .filter(m => !m.user.bot) // Exclude bots by default
      .sort((a, b) => {
        // Sort: online-ish first (recently active), then by join date
        const aNick = (a.nickname || a.user.username).toLowerCase();
        const bNick = (b.nickname || b.user.username).toLowerCase();
        return aNick.localeCompare(bNick);
      })
      .map(buildMemberPayload);

    // Cache the full list
    if (!query) {
      memberCache.set(cacheKey, { data: memberArray, expiresAt: now + MEMBER_CACHE_TTL });
    }

    let data = memberArray;
    if (after) data = data.filter(m => m.id > after);
    return { members: data.slice(0, limit), cached: false };
  } catch (err) {
    console.error('[members] fetch failed:', err.message);
    // If we have stale cache, return it with a warning
    if (cached) {
      let data = cached.data;
      if (after) data = data.filter(m => m.id > after);
      return { members: data.slice(0, limit), cached: true, warning: 'Using cached member list (live fetch failed)' };
    }
    throw err;
  }
}

module.exports = function mount(api, client) {
  const base = '/guilds/:guildId/members';
  const json = express.json({ limit: '50kb' });

  // Search members - primary endpoint for the selector dropdown
  api.get(`${base}/search`, async (req, res) => {
    try {
      const { q = '', limit = '50', after } = req.query;
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const result = await fetchMembers(req.guild, q.trim(), lim, after ? String(after) : null);
      res.json(result);
    } catch (err) {
      console.error('[members/search]', err);
      res.status(500).json({ error: 'Failed to fetch members' });
    }
  });

  // Get single member by ID (for validation)
  api.get(`${base}/:userId`, async (req, res) => {
    try {
      const { userId } = req.params;
      const member = await req.guild.members.fetch(userId).catch(() => null);
      if (!member) return res.status(404).json({ error: 'Member not found in this server' });
      res.json({ member: buildMemberPayload(member) });
    } catch (err) {
      console.error('[members/:id]', err);
      res.status(500).json({ error: 'Failed to fetch member' });
    }
  });

  // Invalidate cache (call after role changes, kicks, etc.)
  api.post(`${base}/invalidate`, json, (req, res) => {
    memberCache.delete(req.guild.id);
    res.json({ ok: true });
  });
};