'use strict';
/* Staff analytics and report export. Mounted under /api/guilds/:guildId (parent guard applies). */
const store = require('../../db');
const { parseFilters, shapeRow } = require('../../utils/audit');

const MAX_REPORT_ROWS = 10000;

/** CSV-safe cell. Quotes everything, and neutralises spreadsheet formulas (=, +, -, @) in user-controlled text. */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

module.exports = function mount(api) {
  const base = '/guilds/:guildId/analytics';

  api.get(`${base}/staff`, (req, res) => {
    res.json({ staff: store.activityModerators(req.guild.id) });
  });

  // Same filters as the log page (category, type, source, moderator, user, from, to, q); `format=csv` downloads a file.
  api.get(`${base}/report`, (req, res) => {
    const filters = parseFilters(req.query);
    const { rows } = store.listActivity(req.guild.id, filters, { limit: MAX_REPORT_ROWS });

    if (req.query.format === 'csv') {
      const head = ['Kind', 'ID', 'Case #', 'Category', 'Type', 'Target ID', 'Target', 'Moderator ID', 'Moderator', 'Source', 'Reason', 'Created (UTC)'];
      const lines = [head.map(csvCell).join(',')];
      for (const r of rows) {
        lines.push([r.kind, r.rid, r.case_number, r.category, r.type, r.target_id, r.target_name, r.moderator_id, r.moderator_tag, r.source, r.reason, new Date(r.created_at).toISOString()].map(csvCell).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="moderation-report-${req.guild.id}.csv"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    }

    res.json({ rows: rows.map(shapeRow), truncated: rows.length >= MAX_REPORT_ROWS });
  });
};
