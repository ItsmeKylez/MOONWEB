'use strict';
/* MOONWEB core: DOM helper, API client, formatting, icons, routing.
   Nothing here uses innerHTML — all dynamic text goes through textContent. */

const $app = document.getElementById('app');

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'checked', 'disabled', 'selected', 'multiple'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const state = { me: null, guildId: null, data: null, loading: true, health: null, recent: null, recentAt: 0, dirty: false };

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } }

async function api(path, { method = 'GET', json, form } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'modbot' }, credentials: 'same-origin' };
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  else if (form) opts.body = form;
  const res = await fetch(`/api${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (res.status === 401) { state.me = null; render(); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

// ---------- formatting ----------
const SNOWFLAKE = /^\d{17,20}$/;
const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtNum = (n) => Number(n || 0).toLocaleString();
function fmtDuration(ms) {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m >= 1440) return `${Math.round(m / 1440)}d`;
  if (m >= 60) return `${Math.round(m / 60)}h`;
  return `${Math.max(1, m)}m`;
}
function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return d < 30 ? `${d}d ago` : fmtDate(ms);
}
const initials = (s) => String(s || '?').replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// ---------- icons: Lucide-style paths, built with createElementNS (CSP-safe) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  megaphone: ['M3 11v2a1 1 0 0 0 1 1h3l8 5V5L7 10H4a1 1 0 0 0-1 1z', 'M19 8a5 5 0 0 1 0 8'],
  userPlus: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M19 8v6', 'M22 11h-6'],
  userX: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M17 8l5 5', 'M22 8l-5 5'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'M21 21l-4.3-4.3'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  menu: ['M3 12h18', 'M3 6h18', 'M3 18h18'],
  panel: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 3v18'],
  chevDown: ['M6 9l6 6 6-6'], chevRight: ['M9 18l6-6-6-6'], chevUpDown: ['M7 15l5 5 5-5', 'M7 9l5-5 5 5'],
  x: ['M18 6L6 18', 'M6 6l12 12'], check: ['M20 6L9 17l-5-5'],
  info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 16v-4', 'M12 8h.01'],
  checkCircle: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M9 12l2 2 4-4'],
  alertCircle: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 8v4', 'M12 16h.01'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  ban: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M4.9 4.9l14.2 14.2'],
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 6v6l4 2'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  trend: ['M22 7l-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
  hash: ['M4 9h16', 'M4 15h16', 'M10 3L8 21', 'M16 3l-2 18'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  externalLink: ['M15 3h6v6', 'M10 14L21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  sparkles: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 3v4', 'M21 5h-4'],
};
function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'icon', 'aria-hidden': 'true', focusable: 'false' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
function logo(cls = '', size = 18) {
  const i = icon('moon', size);
  i.setAttribute('fill', 'currentColor');
  return h('span', { class: `logo ${cls}` }, i);
}

// ---------- routing: #/page?key=value ----------
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [page, qs] = raw.split('?');
  return { page: page || 'dashboard', params: new URLSearchParams(qs || '') };
}
function navigate(page, params) {
  const target = `#/${page}${params ? `?${new URLSearchParams(params)}` : ''}`;
  if (location.hash === target) onRoute();
  else location.hash = target;
}

// ---------- domain metadata shared by pages ----------
const ACTION_META = {
  ban: { label: 'Ban', verb: 'banned', icon: 'ban', tone: 'danger' },
  unban: { label: 'Unban', verb: 'unbanned', icon: 'undo', tone: 'success' },
  kick: { label: 'Kick', verb: 'kicked', icon: 'userX', tone: 'warning' },
  timeout: { label: 'Timeout', verb: 'timed out', icon: 'clock', tone: 'info' },
  untimeout: { label: 'Timeout removed', verb: 'removed the timeout of', icon: 'undo', tone: 'success' },
  warn: { label: 'Warning', verb: 'warned', icon: 'alert', tone: 'warning' },
};
const metaOf = (t) => ACTION_META[t] || { label: t, verb: t, icon: 'file', tone: 'neutral' };
