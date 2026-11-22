'use strict';

// ---------- tiny helpers (no innerHTML anywhere: everything user-controlled goes through textContent) ----------
const $app = document.getElementById('app');

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && ['value', 'checked', 'disabled', 'selected', 'multiple'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}`, text: message });
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

async function api(path, { method = 'GET', json, form } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'modbot' }, credentials: 'same-origin' };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
  }
  const res = await fetch(`/api${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (res.status === 401) { state.me = null; render(); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtDuration = (ms) => {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  if (m >= 1440) return `${Math.round(m / 1440)}d`;
  if (m >= 60) return `${Math.round(m / 60)}h`;
  return `${m}m`;
};

// ---------- state ----------
const state = { me: null, guildId: null, data: null, tab: 'overview', loading: true };

async function boot() {
  try {
    state.me = await api('/me');
  } catch {
    state.me = null;
  }
  state.loading = false;
  const saved = sessionStorageGet('guild');
  if (state.me && saved && state.me.guilds.some((g) => g.id === saved && g.botPresent)) await openGuild(saved);
  else render();
}

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } }

async function openGuild(id) {
  try {
    state.data = await api(`/guilds/${id}`);
    state.guildId = id;
    state.tab = 'overview';
    sessionStorageSet('guild', id);
  } catch (e) {
    toast(e.message, 'error');
    state.guildId = null;
  }
  render();
}

// ---------- theme ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('moonweb-theme', next); } catch { /* ignore */ }
  render();
}
try { applyTheme(localStorage.getItem('moonweb-theme')); } catch { /* ignore */ }

// ---------- icons (SVG built with createElementNS: CSP-safe, no innerHTML) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  megaphone: ['M3 11v2a1 1 0 0 0 1 1h3l8 5V5L7 10H4a1 1 0 0 0-1 1z', 'M19 8a5 5 0 0 1 0 8'],
  menu: ['M3 12h18', 'M3 6h18', 'M3 18h18'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  swap: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
};
function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'icon', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
function logo(size = 18) {
  const svg = icon('moon', size);
  svg.setAttribute('fill', 'currentColor');
  return h('span', { class: 'logo' }, svg);
}

// ---------- shell ----------
function render() {
  $app.replaceChildren();
  document.body.classList.remove('nav-open');
  if (state.loading) return $app.append(h('p', { class: 'boot', text: 'Loading…' }));
  if (!state.me) return $app.append(loginScreen());
  if (!state.guildId) return $app.append(topbar(), guildPicker());
  $app.append(guildShell());
}

function loginScreen() {
  const moon = icon('moon', 38);
  moon.setAttribute('fill', 'currentColor');
  return h('div', { class: 'hero' },
    h('div', { class: 'hero-card' },
      h('div', { class: 'moon' }, moon),
      h('h1', {}, h('span', { text: 'MOONWEB' })),
      h('p', { text: 'A premium dashboard for managing your Discord server. Log in with Discord to manage the servers where you have the Manage Server permission.' }),
      h('div', { class: 'chips' }, ['Moderation', 'Auto-mod', 'Case logs', 'Bulk send'].map((t) => h('span', { class: 'chip', text: t }))),
      h('a', { class: 'btn primary big', href: '/auth/login', text: 'Log in with Discord' }),
    ),
  );
}

function themeButton() {
  return h('button', { class: 'btn small icon-only ghost', title: 'Toggle theme', 'aria-label': 'Toggle theme', onclick: toggleTheme }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'));
}

function userChip() {
  const u = state.me.user;
  const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null;
  return [
    h('div', { class: 'userchip' },
      avatar ? h('img', { class: 'avatar', src: avatar, alt: '' }) : h('span', { class: 'avatar' }),
      h('span', { class: 'username', text: u.name })),
    h('a', { class: 'btn small icon-only ghost', href: '/auth/logout', title: 'Log out', 'aria-label': 'Log out' }, icon('logout')),
  ];
}

// Plain topbar used on the server picker. Inside a server the shell supplies its own.
function topbar() {
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, logo(), 'MOONWEB'),
    h('div', { class: 'spacer' }),
    themeButton(),
    ...userChip(),
  );
}

function guildPicker() {
  const items = state.me.guilds.map((g, i) => {
    const iconEl = g.icon
      ? h('img', { src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`, alt: '' })
      : g.name.slice(0, 2).toUpperCase();
    const body = [h('div', { class: 'icon-box' }, iconEl), h('div', {}, h('b', { text: g.name }), h('small', { text: g.botPresent ? 'Open dashboard' : 'Bot not added — click to invite' }))];
    const delay = (el) => { el.style.animationDelay = `${Math.min(i, 12) * 40}ms`; return el; };
    return delay(g.botPresent
      ? h('button', { class: 'guild', onclick: () => openGuild(g.id) }, ...body)
      : h('a', { class: 'guild invite', href: state.me.inviteUrl, target: '_blank', rel: 'noopener' }, ...body));
  });
  return h('div', {},
    h('div', { class: 'page-title' },
      h('h1', {}, 'Choose a ', h('span', { class: 'grad-text', text: 'server' })),
      h('p', { text: 'Only servers where you have Manage Server are listed.' }),
    ),
    items.length
      ? h('div', { class: 'guilds' }, items)
      : h('div', { class: 'guilds' }, h('div', { class: 'card' }, 'No servers found.', h('br'), h('a', { href: state.me.inviteUrl, target: '_blank', rel: 'noopener', text: 'Invite the bot to a server' }))),
  );
}

// Navigation: add new pages here (id, label, icon). Stages 2-6 will extend this list.
const NAV = [
  { label: 'Dashboard', items: [['overview', 'Overview', 'overview']] },
  { label: 'Protection', items: [['automod', 'Auto-mod', 'shield'], ['moderate', 'Moderate', 'alert'], ['cases', 'Cases', 'file']] },
  { label: 'Server', items: [['general', 'General', 'sliders'], ['bulk', 'Bulk send', 'upload']] },
];
const TABS = NAV.flatMap((g) => g.items);

function guildShell() {
  const views = { overview: overviewTab, automod: automodTab, general: generalTab, cases: casesTab, moderate: moderateTab, bulk: bulkTab };
  const g = state.data.guild;
  const main = h('main', { class: 'main' });
  const title = h('h2', { class: 'topbar-title' });
  const navBtns = new Map();

  const mount = () => {
    title.textContent = TABS.find((t) => t[0] === state.tab)?.[1] ?? '';
    main.replaceChildren(h('div', { class: 'page' }, views[state.tab]()));
    navBtns.forEach((b, id) => b.classList.toggle('active', id === state.tab));
    document.body.classList.remove('nav-open');
    window.scrollTo(0, 0);
  };

  const groups = NAV.map((grp) => h('div', { class: 'nav-group' },
    h('div', { class: 'nav-label', text: grp.label }),
    grp.items.map(([id, label, ic]) => {
      const b = h('button', { class: 'nav', onclick: () => { state.tab = id; mount(); } }, icon(ic), h('span', { text: label }));
      navBtns.set(id, b);
      return b;
    })));

  const guildIcon = g.icon
    ? h('img', { src: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`, alt: '' })
    : g.name.slice(0, 2).toUpperCase();

  const side = h('aside', { class: 'side' },
    h('div', { class: 'brand' }, logo(), 'MOONWEB'),
    h('div', { class: 'server-card' },
      h('div', { class: 'icon-box' }, guildIcon),
      h('div', { class: 'meta' }, h('b', { text: g.name }), h('small', { text: `${g.memberCount} members` })),
      h('button', { class: 'btn small icon-only ghost', title: 'Switch server', 'aria-label': 'Switch server', onclick: () => { state.guildId = null; sessionStorageSet('guild', null); render(); } }, icon('swap', 16))),
    groups,
    h('div', { class: 'foot', text: 'MOONWEB' }),
  );

  const bar = h('header', { class: 'topbar' },
    h('button', { class: 'btn small icon-only ghost menu-btn', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
    title,
    h('div', { class: 'spacer' }),
    themeButton(),
    ...userChip(),
  );

  mount();
  return h('div', { class: 'shell' },
    side,
    h('div', { class: 'backdrop', onclick: () => document.body.classList.remove('nav-open') }),
    h('div', { class: 'content' }, bar, main),
  );
}

// ---------- form helpers ----------
const s = () => state.data.settings;

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint && h('div', { class: 'hint', text: hint }));
}
function check(label, obj, key, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; onChange?.(); } });
  return h('label', { class: 'check' }, input, h('span', { text: label }));
}
function num(obj, key, min, max) {
  return h('input', { type: 'number', value: obj[key], min, max, onchange: (e) => { obj[key] = Number(e.target.value); } });
}
function chanSelect(obj, key, none = '— none —') {
  return h('select', { onchange: (e) => { obj[key] = e.target.value || null; } },
    h('option', { value: '', text: none, selected: !obj[key] }),
    state.data.channels.map((c) => h('option', { value: c.id, text: `#${c.name}`, selected: obj[key] === c.id })));
}
function roleSelect(obj, key, none = '— none —') {
  return h('select', { onchange: (e) => { obj[key] = e.target.value || null; } },
    h('option', { value: '', text: none, selected: !obj[key] }),
    state.data.roles.map((r) => h('option', { value: r.id, text: r.name, selected: obj[key] === r.id })));
}
function multi(obj, key, options, prefix = '') {
  return h('select', {
    multiple: true,
    onchange: (e) => { obj[key] = [...e.target.selectedOptions].map((o) => o.value); },
  }, options.map((o) => h('option', { value: o.id, text: prefix + o.name, selected: obj[key].includes(o.id) })));
}
function listArea(obj, key, placeholder) {
  return h('textarea', { placeholder, onchange: (e) => { obj[key] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); } }, obj[key].join('\n'));
}

async function saveSettings(btn) {
  btn.disabled = true;
  try {
    const { settings } = await api(`/guilds/${state.guildId}/settings`, { method: 'PUT', json: s() });
    state.data.settings = settings;
    toast('Settings saved', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
function saveBar() {
  const btn = h('button', { class: 'btn primary', text: 'Save changes' });
  btn.addEventListener('click', () => saveSettings(btn));
  return h('div', { class: 'actions' }, btn);
}

// ---------- tabs ----------
function overviewTab() {
  const { guild, stats } = state.data;
  const st = (n, label) => h('div', { class: 'stat' }, h('b', { text: String(n) }), h('span', { text: label }));
  const t = stats.byType;
  return h('div', {},
    h('h1', { text: 'Overview' }),
    h('div', { class: 'stats' },
      st(guild.memberCount, 'Members'),
      st(stats.total, 'Total cases'),
      st(stats.last24h, 'Cases in 24h'),
      st(t.warn || 0, 'Warnings issued'),
      st((t.ban || 0) + (t.kick || 0), 'Bans + kicks'),
    ),
    h('div', { class: 'card' },
      h('h3', { text: 'Status' }),
      h('p', {}, 'Auto-moderation: ', h('b', { class: s().automod.enabled ? 'ok' : '', text: s().automod.enabled ? 'on' : 'off' })),
      h('p', {}, 'Log channel: ', h('b', { text: s().logChannelId ? '#' + (state.data.channels.find((c) => c.id === s().logChannelId)?.name ?? 'unknown') : 'not set' })),
      !s().logChannelId && h('p', { class: 'hint', text: 'Tip: set a log channel in General so every action and event is recorded in Discord too.' }),
    ),
  );
}

function ruleBlock(title, obj, bodyNodes) {
  return h('div', { class: 'rule' }, check(title, obj, 'enabled'), bodyNodes && h('div', { class: 'body' }, bodyNodes));
}

function automodTab() {
  const a = s().automod;
  return h('div', {},
    h('h1', { text: 'Auto-moderation' }),
    h('div', { class: 'card' },
      check('Enable auto-moderation', a, 'enabled'),
      h('p', { class: 'hint', text: 'When a rule is broken the message is deleted, the member gets a warning, and repeated warnings trigger the escalation below. Members with Manage Messages are exempt.' }),
    ),
    h('div', { class: 'card' },
      h('h2', { text: 'Rules' }),
      ruleBlock('Spam — too many messages too fast', a.spam, h('div', { class: 'row' }, field('Max messages', num(a.spam, 'maxMessages', 2, 30)), field('Within (seconds)', num(a.spam, 'seconds', 2, 60)))),
      ruleBlock('Block Discord invite links', a.invites),
      ruleBlock('Block links', a.links, field('Allowed domains (one per line)', listArea(a.links, 'allowlist', 'youtube.com\ntwitter.com'), 'Subdomains are allowed automatically.')),
      ruleBlock('Word filter', a.badWords, field('Blocked words (one per line)', listArea(a.badWords, 'words', 'word1\nword2'), 'Matches whole words, case-insensitive.')),
      ruleBlock('Mass mentions', a.mentions, field('Max mentions per message', num(a.mentions, 'max', 2, 50))),
      ruleBlock('Excessive caps', a.caps, h('div', { class: 'row' }, field('Min. letters', num(a.caps, 'minLength', 8, 200)), field('Caps percentage', num(a.caps, 'percent', 40, 100)))),
      ruleBlock('Raid protection', a.raid, h('div', { class: 'row' },
        field('Joins', num(a.raid, 'joins', 3, 100)),
        field('Within (seconds)', num(a.raid, 'seconds', 3, 120)),
        field('Action', h('select', { onchange: (e) => { a.raid.action = e.target.value; } },
          h('option', { value: 'alert', text: 'Alert in log channel', selected: a.raid.action === 'alert' }),
          h('option', { value: 'kick', text: 'Alert + kick new joiners', selected: a.raid.action === 'kick' }))))),
    ),
    h('div', { class: 'card' },
      h('h2', { text: 'Escalation' }),
      h('div', { class: 'row' },
        field('Every N active warnings', num(a.strikes, 'warnings', 1, 20)),
        field('Do this', h('select', { onchange: (e) => { a.strikes.action = e.target.value; } },
          ['timeout', 'kick', 'ban'].map((x) => h('option', { value: x, text: x, selected: a.strikes.action === x })))),
        field('Timeout length (minutes)', num(a.strikes, 'durationMin', 1, 40320))),
    ),
    h('div', { class: 'card' },
      h('h2', { text: 'Exemptions' }),
      field('Exempt roles', multi(a, 'exemptRoleIds', state.data.roles), 'Ctrl/Cmd-click to select several.'),
      field('Exempt channels', multi(a, 'exemptChannelIds', state.data.channels, '#')),
    ),
    saveBar(),
  );
}

function generalTab() {
  const w = s().welcome;
  return h('div', {},
    h('h1', { text: 'General' }),
    h('div', { class: 'card' },
      field('Log channel', chanSelect(s(), 'logChannelId'), 'Mod actions, edits, deletes, joins and leaves are posted here. The bot needs Send Messages + Embed Links there.'),
      field('Auto role for new members', roleSelect(s(), 'autoRoleId'), 'The bot’s role must be above this role.'),
    ),
    h('div', { class: 'card' },
      h('h2', { text: 'Welcome message' }),
      check('Send a welcome message', w, 'enabled'),
      h('div', { class: 'field' }),
      field('Channel', chanSelect(w, 'channelId')),
      field('Message', h('textarea', { onchange: (e) => { w.message = e.target.value; } }, w.message), 'Placeholders: {user}  {server}  {count}'),
    ),
    saveBar(),
  );
}

function casesTab() {
  const f = { page: 1, type: '', user: '' };
  const holder = h('div');
  const load = async () => {
    holder.replaceChildren(h('p', { class: 'hint', text: 'Loading…' }));
    try {
      const q = new URLSearchParams({ page: f.page });
      if (f.type) q.set('type', f.type);
      if (f.user) q.set('user', f.user);
      const r = await api(`/guilds/${state.guildId}/cases?${q}`);
      holder.replaceChildren(
        r.cases.length
          ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, ['#', 'Type', 'User', 'Moderator', 'Reason', 'When'].map((t) => h('th', { text: t })))),
              h('tbody', {}, r.cases.map((c) => h('tr', {},
                h('td', { text: c.case_number }),
                h('td', {}, h('span', { class: `tag ${c.type}`, text: c.type + (c.duration_ms ? ` ${fmtDuration(c.duration_ms)}` : '') })),
                h('td', {}, h('div', { text: c.user_tag || 'unknown' }), h('small', { class: 'hint', text: c.user_id })),
                h('td', { text: c.moderator_tag || c.moderator_id }),
                h('td', { text: c.reason || '' }),
                h('td', { text: fmtDate(c.created_at) }))))))
          : h('p', { class: 'hint', text: 'No cases yet.' }),
        h('div', { class: 'pager' },
          h('span', { text: `${r.total} case${r.total === 1 ? '' : 's'} · page ${r.page}/${r.pages}` }),
          h('button', { class: 'btn small', text: 'Prev', disabled: r.page <= 1, onclick: () => { f.page--; load(); } }),
          h('button', { class: 'btn small', text: 'Next', disabled: r.page >= r.pages, onclick: () => { f.page++; load(); } })),
      );
    } catch (e) {
      holder.replaceChildren(h('p', { class: 'err', text: e.message }));
    }
  };
  load();
  return h('div', {},
    h('h1', { text: 'Cases' }),
    h('div', { class: 'row' },
      field('Type', h('select', { onchange: (e) => { f.type = e.target.value; f.page = 1; load(); } },
        h('option', { value: '', text: 'All' }),
        ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'].map((t) => h('option', { value: t, text: t })))),
      field('User ID', h('input', { type: 'text', placeholder: 'Filter by user ID', onchange: (e) => { f.user = e.target.value.trim(); f.page = 1; load(); } }))),
    holder,
  );
}

function moderateTab() {
  const form = { action: 'warn', userId: '', reason: '', durationMinutes: '', deleteDays: 0 };
  const out = h('p', { class: 'hint' });
  const extra = h('div');
  const drawExtra = () => {
    extra.replaceChildren();
    if (form.action === 'timeout' || form.action === 'ban') {
      extra.append(field(form.action === 'timeout' ? 'Duration (minutes)' : 'Duration (minutes, empty = permanent)', h('input', { type: 'number', min: 1, value: form.durationMinutes, onchange: (e) => { form.durationMinutes = e.target.value; } })));
    }
    if (form.action === 'ban') extra.append(field('Delete message history (days, 0-7)', h('input', { type: 'number', min: 0, max: 7, value: form.deleteDays, onchange: (e) => { form.deleteDays = e.target.value; } })));
  };
  drawExtra();
  const submit = h('button', { class: 'btn primary', text: 'Apply action' });
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    out.className = 'hint';
    out.textContent = 'Working…';
    try {
      const { case: c } = await api(`/guilds/${state.guildId}/actions`, { method: 'POST', json: form });
      out.className = 'ok';
      out.textContent = `Done — case #${c.case_number} (${c.type}) recorded.`;
      toast(`Case #${c.case_number} created`, 'success');
    } catch (e) {
      out.className = 'err';
      out.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  });
  return h('div', {},
    h('h1', { text: 'Moderate' }),
    h('div', { class: 'card' },
      field('Action', h('select', { onchange: (e) => { form.action = e.target.value; drawExtra(); } },
        ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'].map((x) => h('option', { value: x, text: x, selected: form.action === x })))),
      field('User ID', h('input', { type: 'text', placeholder: '123456789012345678', onchange: (e) => { form.userId = e.target.value.trim(); } }), 'In Discord: enable Developer Mode, then right-click a user → Copy User ID.'),
      extra,
      field('Reason', h('input', { type: 'text', maxlength: 500, onchange: (e) => { form.reason = e.target.value; } })),
      submit, out,
    ),
    h('p', { class: 'hint', text: 'Actions follow the same role-hierarchy rules as the slash commands and are credited to you in the case log.' }),
  );
}

function bulkTab() {
  const lim = state.me.limits;
  const files = [];
  let job = null;
  const form = { channelId: '', caption: '', delaySeconds: 1.5 };
  const list = h('ul', { class: 'files' });
  const status = h('div');
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  const send = h('button', { class: 'btn primary', text: 'Send files', disabled: true });

  const refresh = () => {
    list.replaceChildren(...files.map((f, i) =>
      h('li', {},
        h('span', { text: f.name }),
        h('span', { class: f.size > lim.maxFileMB * 1048576 ? 'size over-limit' : 'size', text: fmtSize(f.size) + (f.size > lim.maxFileMB * 1048576 ? ' — too big' : '') }),
        h('button', { class: 'btn small', text: '✕', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); refresh(); } }))));
    send.disabled = !!job || !files.length || files.length > lim.maxFiles || files.some((f) => f.size > lim.maxFileMB * 1048576);
  };
  const add = (fl) => { for (const f of fl) files.push(f); refresh(); };
  input.addEventListener('change', () => { add(input.files); input.value = ''; });

  const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', text: 'Drop files here or click to choose images, videos or any files' });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); });

  const showJob = (j) => {
    const done = j.sent + j.failed;
    const bar = h('div', { class: 'bar' }, h('div'));
    bar.firstChild.style.width = `${Math.round((done / j.total) * 100)}%`;
    status.replaceChildren(
      h('p', { text: j.status === 'running' ? `Sending… ${j.sent}/${j.total} sent` : j.status === 'done' ? `Finished: ${j.sent}/${j.total} sent in ${j.messages} message(s).` : `Failed: ${j.error}` }),
      bar,
      j.failures?.length ? h('p', { class: 'err', text: `Not sent: ${j.failures.map((f) => `${f.name} (${f.reason})`).join('; ')}` }) : null,
    );
  };

  send.addEventListener('click', async () => {
    if (!form.channelId) return toast('Pick a channel first', 'error');
    const fd = new FormData();
    fd.append('channelId', form.channelId);
    fd.append('caption', form.caption);
    fd.append('delaySeconds', form.delaySeconds);
    for (const f of files) fd.append('files', f, f.name);
    send.disabled = true;
    status.replaceChildren(h('p', { class: 'hint', text: 'Uploading…' }));
    try {
      const { jobId } = await api(`/guilds/${state.guildId}/bulk`, { method: 'POST', form: fd });
      job = { status: 'running', sent: 0, failed: 0, total: files.length };
      showJob(job);
      const poll = async () => {
        try {
          job = await api(`/guilds/${state.guildId}/bulk/${jobId}`);
          showJob(job);
          if (job.status === 'running') return setTimeout(poll, 1000);
          if (job.status === 'done') { files.length = 0; toast('Bulk send finished', 'success'); }
          job = null;
          refresh();
        } catch (e) {
          status.replaceChildren(h('p', { class: 'err', text: e.message }));
          job = null;
          refresh();
        }
      };
      poll();
    } catch (e) {
      status.replaceChildren(h('p', { class: 'err', text: e.message }));
      refresh();
    }
  });

  refresh();
  return h('div', {},
    h('h1', { text: 'Bulk send' }),
    h('div', { class: 'notice', text: `Upload up to ${lim.maxFiles} files (max ${lim.maxFileMB} MB each). Discord allows 10 attachments per message, so the bot splits them into several messages and pauses between them to respect rate limits. Only use this in servers you manage.` }),
    h('div', { class: 'card' },
      field('Channel', h('select', { onchange: (e) => { form.channelId = e.target.value; } },
        h('option', { value: '', text: 'Choose a channel…' }),
        state.data.channels.map((c) => h('option', { value: c.id, text: `#${c.name}` })))),
      field('Caption (optional, posted with the first message)', h('input', { type: 'text', maxlength: 1900, onchange: (e) => { form.caption = e.target.value; } })),
      field('Pause between messages (seconds)', h('input', { type: 'number', min: 0, max: 30, step: 0.5, value: form.delaySeconds, onchange: (e) => { form.delaySeconds = e.target.value; } })),
      drop, input, list,
      h('p', {}, send),
      status,
    ),
  );
}

boot();
