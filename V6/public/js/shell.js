'use strict';
/* MOONWEB shell: login, server picker, sidebar, top bar, search, notifications, routing. */

const NAV = [
  { label: 'Overview', items: [['dashboard', 'Dashboard', 'overview']] },
  { label: 'Server', items: [
    ['members', 'Members', 'users'], ['moderation', 'Moderation', 'shield'], ['logs', 'Moderation Logs', 'file'],
    ['announcements', 'Announcements', 'megaphone'], ['welcome', 'Welcome & Goodbye', 'userPlus'], ['bulk', 'Bulk Send', 'upload'],
  ] },
  { label: 'System', items: [['settings', 'Settings', 'settings']] },
];
const PAGE_LIST = NAV.flatMap((g) => g.items);
const refs = { main: null, crumb: null, navBtns: new Map() };
let healthTimer = null;

// ---------- top-level render ----------
function render() {
  closePopover();
  $app.replaceChildren();
  document.body.classList.remove('nav-open');
  clearInterval(healthTimer);
  refs.main = null;
  if (state.loading) return $app.append(h('div', { class: 'boot' }, logo('lg', 26)));
  if (!state.me) return $app.append(loginScreen());
  if (!state.guildId) return $app.append(publicTop(), guildPicker());
  $app.append(guildShell());
}

function loginScreen() {
  const point = (ic, t) => h('li', {}, icon(ic, 18), t);
  return h('div', { class: 'login' }, h('div', { class: 'login-card' },
    logo('lg', 28),
    h('h1', { text: 'MOONWEB' }),
    h('p', { text: 'Manage moderation, members and messaging for your Discord server.' }),
    h('ul', { class: 'login-points' },
      point('shield', 'Moderation tools and automatic rules'),
      point('file', 'A searchable history of every action'),
      point('upload', 'Bulk file sending to any channel')),
    h('a', { class: 'btn primary block', href: '/auth/login', text: 'Continue with Discord' }),
    h('p', { class: 'hint', text: 'You only see servers where you have Manage Server.' })));
}

function publicTop() {
  return h('header', { class: 'public-top' }, h('div', { class: 'brand' }, logo(), 'MOONWEB'), h('div', { class: 'spacer' }), profileButton());
}

function guildPicker() {
  const items = state.me.guilds.map((g, i) => {
    const body = [guildIconEl(g), h('div', {}, h('b', { text: g.name }), h('small', { text: g.botPresent ? 'Open dashboard' : 'Bot not added — click to invite' }))];
    const el = g.botPresent
      ? h('button', { class: 'guild', onclick: () => openGuild(g.id) }, ...body)
      : h('a', { class: 'guild invite', href: state.me.inviteUrl, target: '_blank', rel: 'noopener' }, ...body);
    el.style.animationDelay = `${Math.min(i, 10) * 35}ms`;
    return el;
  });
  return h('div', { class: 'page' },
    h('div', { class: 'picker-head' }, h('h1', { text: 'Choose a server' }), h('p', { text: 'Only servers where you have Manage Server are listed.' })),
    items.length ? h('div', { class: 'guilds' }, items)
      : h('div', { class: 'guilds' }, card({}, emptyState({ ic: 'users', title: 'No servers found', text: 'Invite the bot to a server you manage to get started.', action: h('a', { class: 'btn primary', href: state.me.inviteUrl, target: '_blank', rel: 'noopener', text: 'Invite the bot' }) }))));
}

// ---------- guild lifecycle ----------
async function openGuild(id) {
  try {
    state.data = await api(`/guilds/${id}`);
    state.guildId = id;
    state.recent = null; state.recentAt = 0; state.dirty = false;
    ssSet('guild', id);
  } catch (e) {
    toast(e.message, 'error');
    state.guildId = null;
  }
  render();
}
function leaveGuild() { state.guildId = null; ssSet('guild', null); location.hash = ''; render(); }

async function refreshStats() {
  try {
    const d = await api(`/guilds/${state.guildId}`);
    state.data.stats = d.stats; state.data.guild = d.guild;
  } catch { /* non-fatal */ }
}

/** Latest cases, cached briefly; used by dashboard, notifications and the moderation page. */
async function loadRecent(force = false) {
  if (!force && state.recent && Date.now() - state.recentAt < 15000) return state.recent;
  const r = await api(`/guilds/${state.guildId}/cases?page=1`);
  state.recent = r.cases; state.recentAt = Date.now();
  updateBell();
  return state.recent;
}

async function loadHealth() {
  try { state.health = await (await fetch('/health', { credentials: 'same-origin' })).json(); } catch { state.health = { ok: false }; }
  document.querySelectorAll('[data-bot-dot]').forEach((d) => { d.className = `dot ${state.health.discordReady ? 'on' : state.health.ok ? 'wait' : 'off'}`; });
  document.querySelectorAll('[data-bot-text]').forEach((d) => { d.textContent = botStatusText(); });
}
const botStatusText = () => (!state.health ? 'Checking…' : state.health.discordReady ? 'Bot online' : state.health.ok ? 'Connecting…' : 'Bot offline');

// ---------- shell ----------
function guildShell() {
  const g = state.data.guild;
  document.body.classList.toggle('side-collapsed', lsGet('moonweb-collapsed') === '1');

  const nav = NAV.map((grp) => h('div', { class: 'nav-group' },
    h('div', { class: 'nav-title', text: grp.label }),
    grp.items.map(([id, label, ic]) => {
      const b = h('button', { class: 'nav', title: label, onclick: () => navigate(id) }, icon(ic, 18), h('span', { class: 'label', text: label }));
      refs.navBtns.set(id, b);
      return b;
    })));

  const switcher = h('button', { class: 'server-switch', title: 'Switch server' },
    guildIconEl(g, 'sm'),
    h('span', { class: 'meta' }, h('b', { text: g.name }), h('small', { text: `${fmtNum(g.memberCount)} members` })),
    icon('chevUpDown', 16));
  popover(switcher, (close) => [
    h('div', { class: 'pop-head' }, h('b', { text: 'Your servers' })),
    state.me.guilds.filter((x) => x.botPresent).map((x) => h('button', { class: 'pop-item', role: 'menuitem', onclick: () => { close(); if (x.id !== state.guildId) openGuild(x.id); } },
      guildIconEl(x, 'sm'), h('span', { text: x.name }), x.id === state.guildId && h('small', {}, icon('check', 14)))),
    h('div', { class: 'pop-sep' }),
    popItem('externalLink', 'Add bot to another server', () => { close(); window.open(state.me.inviteUrl, '_blank', 'noopener'); }),
  ], { minWidth: 240 });

  const collapseBtn = h('button', { class: 'btn ghost small icon-only collapse-btn', title: 'Collapse sidebar', 'aria-label': 'Collapse sidebar', onclick: () => {
    const on = !document.body.classList.contains('side-collapsed');
    document.body.classList.toggle('side-collapsed', on);
    lsSet('moonweb-collapsed', on ? '1' : '0');
  } }, icon('panel', 17));

  const side = h('aside', { class: 'side', 'aria-label': 'Main navigation' },
    h('div', { class: 'side-head' }, h('div', { class: 'brand' }, logo(), h('span', { class: 'label', text: 'MOONWEB' })), collapseBtn),
    switcher, nav,
    h('div', { class: 'side-foot', title: 'Bot connection' }, h('span', { class: 'dot wait', 'data-bot-dot': '' }), h('span', { class: 'label', 'data-bot-text': '', text: botStatusText() })));

  refs.crumb = h('div', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  refs.main = h('main', { class: 'main', id: 'main' });
  const searchBtn = h('button', { class: 'search-btn', 'aria-label': 'Search', onclick: openPalette }, icon('search', 16), h('span', { text: 'Search' }), h('kbd', { text: '/' }));
  const bell = h('button', { class: 'btn ghost icon-only bell', 'aria-label': 'Notifications', title: 'Recent activity' }, icon('bell', 18), h('i', { class: 'badge-dot', hidden: true }));
  popover(bell, notificationsPanel, { minWidth: 340 });

  const top = h('header', { class: 'topbar' },
    h('button', { class: 'btn ghost icon-only menu-btn', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu', 20)),
    refs.crumb, h('div', { class: 'spacer' }), searchBtn, bell, profileButton());

  $app.append(h('div', { class: 'app-shell' }, side,
    h('div', { class: 'backdrop', onclick: () => document.body.classList.remove('nav-open') }),
    h('div', { class: 'content' }, top, refs.main)));

  mountPage();
  loadHealth();
  healthTimer = setInterval(loadHealth, 30000);
  loadRecent().catch(() => {});
}

function mountPage() {
  if (!refs.main) return;
  let { page, params } = parseRoute();
  if (!PAGE_VIEWS[page]) { page = 'dashboard'; }
  const label = PAGE_LIST.find((p) => p[0] === page)[1];
  const g = state.data.guild;
  refs.crumb.replaceChildren(
    h('button', { class: 'root-crumb', text: g.name, onclick: () => navigate('dashboard') }),
    h('span', { class: 'sep' }, icon('chevRight', 14)),
    h('span', { class: 'cur', text: label }));
  document.title = `${label} · MOONWEB`;
  refs.navBtns.forEach((b, id) => { b.classList.toggle('active', id === page); b.setAttribute('aria-current', id === page ? 'page' : 'false'); });
  let view;
  try { view = PAGE_VIEWS[page](params); }
  catch (e) { console.error(e); view = card({}, emptyState({ ic: 'alertCircle', tone: 'danger', title: 'This page failed to load', text: e.message })); }
  refs.main.replaceChildren(h('div', { class: 'page' }, view));
  document.body.classList.remove('nav-open');
  closePopover();
  window.scrollTo(0, 0);
}
function onRoute() { if (state.me && state.guildId && refs.main) mountPage(); }

// ---------- profile ----------
function profileButton() {
  const u = state.me.user;
  const url = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null;
  const btn = h('button', { class: 'profile', 'aria-label': 'Account menu' }, avatarEl(u.name, url), h('span', { class: 'name', text: u.name }), icon('chevDown', 14));
  popover(btn, (close) => [
    h('div', { class: 'pop-head' }, h('b', { text: u.name }), h('small', { text: `@${u.username}` })),
    state.guildId && popItem('users', 'Switch server', () => { close(); leaveGuild(); }),
    popItem('externalLink', 'Invite bot to a server', () => { close(); window.open(state.me.inviteUrl, '_blank', 'noopener'); }),
    h('div', { class: 'pop-sep' }),
    h('a', { class: 'pop-item danger', role: 'menuitem', href: '/auth/logout' }, icon('logout', 16), h('span', { text: 'Log out' })),
  ], { minWidth: 230 });
  return btn;
}

// ---------- notifications (real recent moderation cases) ----------
const seenKey = () => `moonweb-seen-${state.guildId}`;
function unreadCount() { return (state.recent || []).filter((c) => c.case_number > Number(lsGet(seenKey()) || 0)).length; }
function updateBell() { document.querySelectorAll('.bell .badge-dot').forEach((d) => { d.hidden = unreadCount() === 0; }); }
function notificationsPanel(close) {
  const list = h('div', { class: 'activity' }, skeletonRows(3));
  const draw = (rows) => {
    if (rows.length) lsSet(seenKey(), String(Math.max(...rows.map((c) => c.case_number))));
    updateBell();
    list.replaceChildren(...(rows.length
      ? rows.slice(0, 6).map((c) => activityItem(c, () => close()))
      : [emptyState({ ic: 'bell', title: 'Nothing yet', text: 'Moderation actions will appear here.', compact: true })]));
  };
  loadRecent(true).then(draw).catch((e) => list.replaceChildren(h('p', { class: 'err', text: e.message })));
  return [
    h('div', { class: 'pop-head' }, h('b', { text: 'Recent activity' })),
    list,
    h('div', { class: 'pop-sep' }),
    popItem('file', 'View all moderation logs', () => { close(); navigate('logs'); }),
  ];
}

// ---------- search / command palette ----------
function openPalette() {
  closePopover();
  const input = h('input', { type: 'text', placeholder: 'Search pages, or paste a Discord user ID…', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  let items = [], sel = 0;
  const m = modal({ size: 'palette', top: true, body: h('div', {}, h('div', { class: 'pal-input' }, icon('search', 18), input), list) });
  m.el.querySelector('.modal-body').style.padding = '0';

  const go = (fn) => { m.close(); fn(); };
  const build = () => {
    const q = input.value.trim();
    items = [];
    if (SNOWFLAKE.test(q)) {
      items.push({ ic: 'file', label: `View moderation logs for ${q}`, hint: 'Logs', run: () => navigate('logs', { user: q }) });
      items.push({ ic: 'shield', label: `Take action on user ${q}`, hint: 'Moderation', run: () => navigate('moderation', { user: q }) });
    }
    for (const [id, label, ic] of PAGE_LIST) if (!q || label.toLowerCase().includes(q.toLowerCase())) items.push({ ic, label, hint: 'Page', run: () => navigate(id) });
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length
      ? items.map((it, i) => h('button', { class: `pop-item${i === sel ? ' sel' : ''}`, role: 'option', onmouseenter: () => { sel = i; paint(); }, onclick: () => go(it.run) }, icon(it.ic, 16), h('span', { text: it.label }), h('small', { text: it.hint })))
      : [emptyState({ ic: 'search', title: 'No results', text: 'Try a page name or paste a user’s Discord ID.', compact: true })]));
  };
  const paint = () => [...list.children].forEach((c, i) => c.classList?.toggle('sel', i === sel));
  input.addEventListener('input', () => { sel = 0; build(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); go(items[sel].run); }
  });
  build();
}
document.addEventListener('keydown', (e) => {
  if (!refs.main || document.querySelector('.overlay')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); openPalette(); }
});
