"use strict";

/* ===================================================================
   Zyn Bot dashboard. No build step: plain JS talking to /api.
   Settings forms are generated from the schema the server sends.

   Layout of this file
     1. state + helpers
     2. design components (icons, badge, head, empty, search field,
        data table, confirm dialog, dropdowns, toasts, skeleton)
     3. login / guild picker / shell (sidebar + header + footer)
     4. router
     5. generic settings form + paged table + simple list
     6. pages (all API calls are unchanged from earlier stages)
   =================================================================== */

const S = { session: null, meta: null, gid: null, page: null, dirty: false, lastHash: "", reverting: false };
const app = document.getElementById("app");

/* ---------- small helpers ---------- */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", headers: { "X-Requested-With": "zyn-dashboard" }, ...opts };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch("/api" + path, init);
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (res.status === 401) { S.session = null; renderLogin(); throw new Error("Signed out"); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
const G = (p) => api(`/guilds/${S.gid}${p}`);
const send = (method, p, body) => api(`/guilds/${S.gid}${p}`, { method, body });

/* Notifications */
function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 2600);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.message !== "Signed out") toast(e.message, true); } };

function when(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function span(sec) {
  if (!sec) return "";
  const u = [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]];
  const out = [];
  for (const [n, l] of u) if (sec >= n && out.length < 2) { out.push(Math.floor(sec / n) + l); sec %= n; }
  return out.join(" ");
}

/* ===================================================================
   Design components
   =================================================================== */

/* Icons: 24x24 stroke set. Values are static, trusted markup. */
const ICONS = {
  overview: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  antinuke: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M12 8.5v4M12 15.6h.01"/>',
  antiraid: '<path d="M3 12h4l2.5-6 5 12 2.5-6H21"/>',
  antispam: '<path d="M3 5h18l-7 8.2V19l-4 2v-7.8z"/>',
  words: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  trusted: '<path d="M15 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M16.5 11l2 2 4-4"/>',
  cases: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  warns: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.4h.01"/>',
  tickets: '<path d="M3 8a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4z"/><path d="M13 6v12" stroke-dasharray="2 2.5"/>',
  "ticket-settings": '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-.01"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  panels: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
  blocked: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  welcome: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
  levels: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  general: '<rect x="3" y="4" width="18" height="7" rx="2.5"/><rect x="3" y="13" width="18" height="7" rx="2.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  logs: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  ignored: '<path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 5.2A9.9 9.9 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6A17 17 0 002 12s4 7 10 7a9.7 9.7 0 004-.9"/>',
  backups: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  star: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
};
const ico = (n) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ICONS.overview}</svg>`;

/* Brand mark + chrome four-point stars (decoration only) */
const logoMark = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#f5f5f6"/><path d="M16 6l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V9z" fill="#09090a"/></svg>`;
const starDefs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="starg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#3a3a3e"/><stop offset=".7" stop-color="#0c0c0d"/><stop offset="1" stop-color="#d8d8dc"/></linearGradient>
  <linearGradient id="starr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#6d6d73"/><stop offset="1" stop-color="#fff"/></linearGradient></defs></svg>`;
const star = (cls) => `<svg class="star ${cls}" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 3C53 33 67 47 97 50 67 53 53 67 50 97 47 67 33 53 3 50 33 47 47 33 50 3z" fill="url(#starg)" stroke="url(#starr)" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/* Badge pill: small label with a round icon, used above every page title */
const badge = (text, icon = "star") => `<span class="badge"><i>${ico(icon)}</i>${esc(text)}</span>`;

/* Page heading */
function head(title, intro) {
  const nav = NAV.find((n) => n[0] === S.page);
  const label = S.page === "overview" ? "Overview" : (nav && nav[2]) || "Dashboard";
  const deco = S.page === "overview" ? star("") + star("b") : "";
  return `<div class="page-head">${deco}${badge(label, nav ? nav[3] : "overview")}<h1>${esc(title)}</h1>${intro ? `<p>${esc(intro)}</p>` : ""}</div>`;
}

/* Avatars / people */
function avatar(u, cls = "") {
  if (u && u.avatar) return `<img class="avatar round sm ${cls}" src="${esc(u.avatar)}" alt="" loading="lazy">`;
  return `<span class="avatar round sm ${cls}">${esc((u && u.name || "?").slice(0, 1).toUpperCase())}</span>`;
}
function who(users, id) {
  const u = users && users[String(id)];
  if (!id) return `<span class="muted">—</span>`;
  return `<span class="who">${avatar(u)}${esc(u ? u.name : id)}</span>`;
}
function userObj(u) { return `<span class="who">${avatar(u)}${esc(u ? u.name : "?")}</span>`; }

/* Empty + loading states */
function empty(title, text, icon = "overview") {
  return `<div class="empty"><div class="chipicon">${ico(icon)}</div><b>${esc(title)}</b>${esc(text)}</div>`;
}
function skeleton(el) { el.innerHTML = `<div class="skeleton" aria-busy="true"><i></i><i></i><i></i><i></i></div>`; }

/* Search field (used in table toolbars) */
function searchField(name, placeholder, label) {
  return `<label class="search">${ico("search")}<input type="search" name="${esc(name)}" placeholder="${esc(placeholder)}" inputmode="numeric" autocomplete="off" aria-label="${esc(label || placeholder)}"></label>`;
}

/* Data table. cols: [[label, fn(row, ctx), className]]. td gets data-label so it can become a card on phones. */
function dataTable(cols, items, ctx) {
  return `<div class="tablewrap"><table><thead><tr>${cols.map(([l, , c]) =>
    `<th class="${c || ""}">${esc(l)}</th>`).join("")}</tr></thead><tbody>${items.map((r) =>
    `<tr>${cols.map(([l, fn, c]) => `<td class="${c || ""}" data-label="${esc(l)}">${fn(r, ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/* Confirmation dialog. Resolves true on confirm, false on cancel / Escape / backdrop. */
function confirmDialog({ title, text, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const el = document.createElement("div");
    el.className = "modal";
    el.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-d">
      <div class="chipicon">${ico(danger ? "warns" : "shield")}</div>
      <h3 id="dlg-t">${esc(title)}</h3><p id="dlg-d">${esc(text)}</p>
      <div class="dialog-actions"><button class="btn ghost" data-r="0">${esc(cancelLabel)}</button>
      <button class="btn ${danger ? "solid-danger" : "primary"}" data-r="1">${esc(confirmLabel)}</button></div></div>`;
    const done = (v) => {
      document.removeEventListener("keydown", onKey, true);
      el.remove();
      if (prev && prev.focus) prev.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      if (e.key === "Tab") {
        const b = [...el.querySelectorAll("button")];
        const i = b.indexOf(document.activeElement);
        e.preventDefault();
        b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus();
      }
    };
    el.addEventListener("click", (e) => {
      if (e.target === el) return done(false);
      const b = e.target.closest("[data-r]");
      if (b) done(b.dataset.r === "1");
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(el);
    el.querySelector('[data-r="1"]').focus();
  });
}

/* Dropdown menus: any .dd containing [data-dd] + .menu is handled globally (see boot). */
function closeMenus(except) {
  document.querySelectorAll(".dd").forEach((d) => {
    if (d === except) return;
    const m = d.querySelector(".menu"), t = d.querySelector("[data-dd]");
    if (m) m.hidden = true;
    if (t) t.setAttribute("aria-expanded", "false");
  });
}
function closeDrawer() {
  const side = document.getElementById("side"), scrim = document.getElementById("scrim"), b = document.getElementById("burger");
  if (side) side.classList.remove("open");
  if (scrim) scrim.classList.remove("open");
  if (b) b.setAttribute("aria-expanded", "false");
}

async function logout() {
  try { await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "zyn-dashboard" } }); } catch (_) {}
  S.session = null; S.meta = null; S.gid = null;
  history.replaceState(null, "", "/");
  renderLogin();
}

/* ---------- login ---------- */
function renderLogin() {
  const failed = new URLSearchParams(location.search).get("login") === "failed";
  app.innerHTML = `${starDefs}
    <main class="landing">
      <div class="lnav"><span class="brand">${logoMark}Zyn Bot</span><a class="btn small" href="/auth/login">Sign in</a></div>
      <section class="hero">
        ${star("s1")}${star("s2")}${star("s3")}
        ${badge("Discord server dashboard", "shield")}
        <h1 class="grad-text">Your server's security, from the browser.</h1>
        <p>Sign in with Discord to manage anti-nuke, anti-raid, tickets, logs and everything else for servers where you're an admin.</p>
        <div class="actions"><a class="btn primary" href="/auth/login">Sign in with Discord</a></div>
        ${failed ? `<div class="notice" role="alert">Sign-in didn't complete. Try again.</div>` : ""}
      </section>
      <section class="feat" aria-label="What you can manage">
        <div><div class="chipicon">${ico("antinuke")}</div><h3>Protection</h3><p>Anti-nuke, anti-raid, anti-spam and a word filter, armed or off from one place.</p></div>
        <div><div class="chipicon">${ico("cases")}</div><h3>Moderation</h3><p>Browse cases and warnings, and take a warning off a member's record.</p></div>
        <div><div class="chipicon">${ico("tickets")}</div><h3>Tickets &amp; logs</h3><p>Ticket settings, panels, blocked members and where each log is posted.</p></div>
      </section>
    </main>`;
}

/* ---------- navigation ---------- */
const NAV = [
  ["overview", "Overview", null, "overview"],
  ["antinuke", "Anti-nuke", "Protection", "antinuke"], ["antiraid", "Anti-raid", "Protection", "antiraid"],
  ["antispam", "Anti-spam", "Protection", "antispam"], ["words", "Word filter", "Protection", "words"],
  ["trusted", "Trusted users", "Protection", "trusted"],
  ["cases", "Cases", "Moderation", "cases"], ["warns", "Warnings", "Moderation", "warns"],
  ["tickets", "Tickets", "Tickets", "tickets"], ["ticket-settings", "Ticket settings", "Tickets", "ticket-settings"],
  ["panels", "Panels", "Tickets", "panels"], ["blocked", "Blocked members", "Tickets", "blocked"],
  ["welcome", "Welcome & goodbye", "Community", "welcome"], ["levels", "Levels", "Community", "levels"],
  ["general", "General", "Server", "general"], ["logs", "Log channels", "Server", "logs"],
  ["ignored", "Ignored", "Server", "ignored"], ["backups", "Backups", "Server", "backups"],
];

function shell() {
  const g = S.session.guilds.find((x) => x.id === S.gid);
  const cur = NAV.find((n) => n[0] === S.page);
  let lastGroup = "__";
  const links = NAV.map(([id, label, group, icon]) => {
    const heading = group !== lastGroup && group ? `<h4>${esc(group)}</h4>` : "";
    lastGroup = group;
    return `${heading}<a href="#/${S.gid}/${id}" ${id === S.page ? 'aria-current="page"' : ""}>${ico(icon)}<span>${esc(label)}</span></a>`;
  }).join("");
  const icon = (x) => x.icon ? `<img class="avatar" src="${esc(x.icon)}" alt="">`
    : `<span class="avatar">${esc(x.name.slice(0, 1).toUpperCase())}</span>`;
  const others = S.session.guilds.filter((x) => x.id !== S.gid)
    .map((x) => `<button data-guild="${x.id}">${icon(x)}<span>${esc(x.name)}</span></button>`).join("");
  app.innerHTML = `${starDefs}
    <div class="shell">
      <aside class="side" id="side" aria-label="Main navigation">
        <a class="brand" href="#/${S.gid}/overview">${logoMark}Zyn Bot</a>
        <div class="guild-switch dd">
          <button class="guild-btn" id="gswitch" data-dd aria-haspopup="true" aria-expanded="false">
            ${g ? icon(g) : ""}<span><b>${esc(g ? g.name : "")}</b><small>${g ? g.members.toLocaleString() + " members" : ""}</small></span>${ico("swap")}
          </button>
          <div class="menu" id="gmenu" hidden>${others}${others ? "<hr>" : ""}
            <button data-guild="">${ico("general")}<span>All servers</span></button>
            <a href="${esc(S.session.invite)}" target="_blank" rel="noopener">${ico("plus")}<span>Add the bot to a server</span></a>
          </div>
        </div>
        <nav>${links}</nav>
      </aside>
      <div class="scrim" id="scrim"></div>
      <div class="content">
        <header class="bar"><div class="bar-in">
          <button class="btn ghost burger" id="burger" aria-label="Open menu" aria-controls="side" aria-expanded="false">${ico("menu")}</button>
          <div class="crumb"><b>${esc(g ? g.name : "Dashboard")}</b><span class="sep">/</span><span>${esc(cur ? cur[1] : "Overview")}</span></div>
          <div class="dd">
            <button class="userbtn" id="userbtn" data-dd aria-haspopup="true" aria-expanded="false">${avatar(S.session.user)}<span class="uname">${esc(S.session.user.name)}</span>${ico("chevron")}</button>
            <div class="menu right" hidden>
              <div class="label">Signed in as ${esc(S.session.user.name)}</div>
              <button id="logout">${ico("logout")}<span>Sign out</span></button>
            </div>
          </div>
        </div></header>
        <main class="main" id="main"></main>
        <footer class="foot">
          <div class="foot-top"><span>${esc(g ? g.name : "Zyn Bot")} · managed with Zyn Bot</span>
            <a href="${esc(S.session.invite)}" target="_blank" rel="noopener">Add the bot to a server</a></div>
          <div class="word" aria-hidden="true"><b>Zyn</b><em>Bot</em></div>
        </footer>
      </div>
    </div>`;
  const side = document.getElementById("side"), scrim = document.getElementById("scrim"), burger = document.getElementById("burger");
  burger.onclick = () => {
    const open = !side.classList.contains("open");
    side.classList.toggle("open", open); scrim.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
  };
  scrim.onclick = closeDrawer;
  document.getElementById("gmenu").onclick = (e) => {
    const b = e.target.closest("[data-guild]");
    if (b) location.hash = b.dataset.guild ? `#/${b.dataset.guild}/overview` : "#/";
  };
  document.getElementById("logout").onclick = logout;
  return document.getElementById("main");
}

/* ---------- guild picker ---------- */
function renderPicker() {
  const gs = S.session.guilds;
  app.innerHTML = `${starDefs}
    <main class="landing">
      <div class="lnav"><span class="brand">${logoMark}Zyn Bot</span>
        <button class="btn small" id="logout2">Sign out</button></div>
      <section class="hero" style="margin-top:clamp(40px,8vh,90px)">
        ${star("s1")}${star("s3")}
        <div class="picker" style="margin:0">
          ${badge(S.session.user.name, "trusted")}
          <h1 class="grad-text" style="margin-top:18px">Pick a server</h1>
          <p>${gs.length ? "These are the servers where the bot is present and you're an admin." :
            "The bot isn't in any server you manage yet."}</p>
          <div class="rows">
            ${gs.map((g) => `<a class="listrow" style="text-decoration:none;color:inherit" href="#/${g.id}/overview">
              ${g.icon ? `<img class="avatar" src="${esc(g.icon)}" alt="">` : `<span class="avatar">${esc(g.name.slice(0, 1).toUpperCase())}</span>`}
              <span><b>${esc(g.name)}</b><br><small class="muted">${g.members.toLocaleString()} members</small></span></a>`).join("")}
            <div class="listrow"><a class="btn" href="${esc(S.session.invite)}" target="_blank" rel="noopener">${ico("plus")}Add the bot to a server</a></div>
          </div>
        </div>
      </section>
    </main>`;
  document.getElementById("logout2").onclick = logout;
}

/* ---------- router ---------- */
async function route() {
  if (!S.session) { try { S.session = await api("/session"); } catch (_) { return; } }
  if (S.reverting) { S.reverting = false; return; }   // we only changed the hash back after a cancelled leave
  if (S.dirty && !(await confirmDialog({
    title: "Leave without saving?", text: "You have unsaved changes on this page. If you leave now they will be lost.",
    confirmLabel: "Leave page", cancelLabel: "Stay", danger: true }))) {
    S.reverting = true; location.hash = S.lastHash; return;
  }
  setDirty(false, null);
  S.lastHash = location.hash;
  const m = location.hash.match(/^#\/(\d+)\/([\w-]+)/);
  if (!m) { S.gid = null; return renderPicker(); }
  if (!S.session.guilds.some((g) => g.id === m[1])) { location.hash = "#/"; return; }
  if (S.gid !== m[1] || !S.meta) {
    S.gid = m[1]; S.meta = null;
    try { S.meta = await G("/meta"); } catch (e) { toast(e.message, true); location.hash = "#/"; return; }
  }
  S.page = PAGES[m[2]] ? m[2] : "overview";
  const main = shell();
  skeleton(main);
  window.scrollTo(0, 0);
  try { await PAGES[S.page](main); } catch (e) {
    if (e.message !== "Signed out") main.innerHTML = head("Couldn't load this page", e.message);
  }
}

/* ---------- option lists from server meta ---------- */
function options(kind, current) {
  const list = kind === "role" ? S.meta.roles : kind === "category" ? S.meta.categories : S.meta.channels;
  const prefix = kind === "channel" ? "#" : "";
  let html = `<option value="">None</option>`;
  let found = !current;
  for (const o of list) {
    if (o.id === current) found = true;
    const grp = o.category && kind === "channel" ? ` (${o.category})` : "";
    html += `<option value="${o.id}" ${o.id === current ? "selected" : ""}>${prefix}${esc(o.name)}${esc(grp)}</option>`;
  }
  if (!found) html += `<option value="${esc(current)}" selected>Deleted (${esc(current)})</option>`;
  return html;
}

/* ===================================================================
   Generic settings form
   view = { title, intro, groups:[{title, fields:[...]}], values, save(changed) }
   =================================================================== */
function setDirty(on, bar) {
  S.dirty = on;
  const old = document.getElementById("savebar");
  if (!on) { if (old) old.remove(); return; }
  if (old) return;
  const el = document.createElement("div");
  el.id = "savebar"; el.className = "savebar";
  el.innerHTML = `<div role="region" aria-label="Unsaved changes"><span>You have unsaved changes.</span>
    <button class="btn ghost" data-act="discard">Discard</button>
    <button class="btn primary" data-act="save">Save changes</button></div>`;
  document.body.append(el);
  el.onclick = (e) => { const a = e.target.closest("[data-act]"); if (a && bar) bar[a.dataset.act](a); };
}

function control(f, value) {
  const k = esc(f.key);
  switch (f.kind) {
    case "bool":
      return `<label class="switch"><input type="checkbox" role="switch" data-key="${k}" ${value ? "checked" : ""} aria-label="${esc(f.label)}"><i></i></label>`;
    case "int":
      return `<input type="number" data-key="${k}" value="${esc(value)}" min="${f.min}" max="${f.max}" inputmode="numeric" aria-label="${esc(f.label)}">`;
    case "enum":
      return `<select data-key="${k}" aria-label="${esc(f.label)}">${f.options.map(([v, l]) =>
        `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    case "role": case "channel": case "category":
      return `<select data-key="${k}" aria-label="${esc(f.label)}">${options(f.kind, value)}</select>`;
    case "color":
      return `<input type="color" data-key="${k}" value="${esc(value)}" aria-label="${esc(f.label)}">`;
    case "longtext":
      return `<textarea data-key="${k}" maxlength="${f.max || 1500}" aria-label="${esc(f.label)}">${esc(value)}</textarea>`;
    default:
      return `<input type="text" data-key="${k}" value="${esc(value)}" maxlength="${f.max || 200}" spellcheck="false" aria-label="${esc(f.label)}">`;
  }
}

function readControl(f, el) {
  if (f.kind === "bool") return el.checked;
  if (f.kind === "int") return el.value === "" ? null : Number(el.value);
  if (["role", "channel", "category"].includes(f.kind)) return el.value || null;
  if (["text", "longtext", "regex"].includes(f.kind)) return el.value.trim() === "" ? null : el.value;
  return el.value;
}

function formView(main, view) {
  const fields = {};
  view.groups.forEach((g) => g.fields.forEach((f) => (fields[f.key] = f)));
  const orig = { ...view.values };
  const cur = { ...view.values };

  main.innerHTML = head(view.title, view.intro) + view.groups.map((g) => `
    <section class="group"><h3>${esc(g.title)}</h3><div class="rows">
      ${g.fields.map((f) => {
        const wide = f.kind === "longtext";
        return `<div class="row ${f.kind === "bool" ? "bool" : ""} ${wide ? "wide" : ""}" data-row="${esc(f.key)}">
          <div><div class="lbl">${esc(f.label)}</div>${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}</div>
          <div class="ctl">${control(f, cur[f.key])}</div></div>`;
      }).join("")}
    </div></section>`).join("") + (view.extra ? `<div class="stack" id="extra"></div>` : "");

  const changed = () => Object.keys(cur).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(orig[k]));
  const bar = {
    discard() {
      Object.assign(cur, orig);
      main.querySelectorAll("[data-key]").forEach((el) => {
        const f = fields[el.dataset.key], v = orig[f.key];
        if (f.kind === "bool") el.checked = !!v; else el.value = v ?? "";
      });
      refresh();
    },
    save: guard(async (btn) => {
      const diff = {};
      changed().forEach((k) => (diff[k] = cur[k]));
      if (btn) btn.setAttribute("aria-busy", "true");
      try {
        const res = await view.save(diff);
        Object.assign(orig, res); Object.assign(cur, res);
        refresh(); toast("Saved");
      } finally { if (btn) btn.removeAttribute("aria-busy"); }
    }),
  };
  const refresh = () => {
    const ch = changed();
    main.querySelectorAll("[data-row]").forEach((r) => r.classList.toggle("changed", ch.includes(r.dataset.row)));
    setDirty(ch.length > 0, bar);
  };
  const onEdit = (e) => {
    const el = e.target.closest("[data-key]");
    if (!el) return;
    cur[el.dataset.key] = readControl(fields[el.dataset.key], el);
    refresh();
  };
  main.addEventListener("input", onEdit);
  main.addEventListener("change", onEdit);
  if (view.extra) guard(view.extra)(document.getElementById("extra"));
}

async function sectionPage(main, section, extra) {
  const sch = S.meta.schema[section];
  const { values } = await G(`/config/${section}`);
  formView(main, {
    title: sch.title, intro: sch.intro, groups: sch.groups, values, extra,
    save: async (diff) => (await send("PATCH", `/config/${section}`, { values: diff })).values,
  });
}

/* ===================================================================
   Reusable list / table widgets
   =================================================================== */
function pager(total, page, size, onGo) {
  const pages = Math.max(1, Math.ceil(total / size));
  const el = document.createElement("div");
  el.className = "pager";
  el.innerHTML = `<span>${total.toLocaleString()} total</span>
    <button class="btn small" data-d="-1" ${page <= 1 ? "disabled" : ""}>Previous</button>
    <span class="mono">Page ${page} of ${pages}</span>
    <button class="btn small" data-d="1" ${page >= pages ? "disabled" : ""}>Next</button>`;
  el.onclick = (e) => { const d = e.target.dataset.d; if (d) onGo(page + Number(d)); };
  return el;
}

/* A filterable, paged table. cfg: {url, toolbar, cols:[[label, fn, cls]], emptyTitle, emptyText} */
function pagedTable(main, cfg) {
  main.insertAdjacentHTML("beforeend", `
    <div class="toolbar" id="tb">${cfg.toolbar || ""}</div><div id="tbl"></div><div id="pg"></div>`);
  const tbl = main.querySelector("#tbl"), pg = main.querySelector("#pg"), tb = main.querySelector("#tb");
  let page = 1, filters = {};
  const load = guard(async () => {
    const qs = new URLSearchParams({ page, ...filters });
    for (const [k, v] of [...qs]) if (!v) qs.delete(k);
    const d = await G(`${cfg.url}?${qs}`);
    if (cfg.onData) cfg.onData(d, tb);
    tbl.innerHTML = d.items.length ? dataTable(cfg.cols, d.items, d)
      : `<div class="tablewrap">${empty(cfg.emptyTitle, cfg.emptyText, cfg.emptyIcon)}</div>`;
    pg.innerHTML = "";
    if (d.total > d.page_size) pg.append(pager(d.total, page, d.page_size, (p) => { page = p; load(); }));
  });
  tb.addEventListener("change", (e) => { const n = e.target.name; if (n) { filters[n] = e.target.value.trim(); page = 1; load(); } });
  tb.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.name) e.target.dispatchEvent(new Event("change", { bubbles: true })); });
  tbl.addEventListener("click", cfg.onClick || (() => {}));
  load();
  return { reload: load };
}

/* ===================================================================
   Pages
   =================================================================== */
const PAGES = {};

PAGES.overview = async (main) => {
  const d = await G("/overview");
  const defs = [
    ["antinuke", "Anti-nuke", "Stops mass deletions and restores what was lost."],
    ["antiraid", "Anti-raid", "Catches join waves and suspicious new accounts."],
    ["antispam", "Anti-spam", "Scores spam and escalates the punishment."],
  ];
  const st = d.stats;
  const stat = (icon, value, label) => `<div class="stat"><div class="chipicon">${ico(icon)}</div><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  main.innerHTML = head(S.meta.guild.name, "Protection status and recent activity.") + `
    <div class="armed-band">${defs.map(([k, name, text]) => `
      <div class="armed ${d.protections[k] ? "on" : ""}" data-p="${k}">
        <div class="armed-top"><div class="chipicon">${ico(k)}</div>
          <label class="switch"><input type="checkbox" role="switch" aria-label="${name}" ${d.protections[k] ? "checked" : ""}><i></i></label></div>
        <h3>${name}</h3>
        <div class="state">${d.protections[k] ? "Armed" : "Off"}</div>
        <p>${text}</p><a class="btn small" href="#/${S.gid}/${k}">Settings</a></div>`).join("")}</div>
    <div class="stats">
      ${stat("tickets", st.open_tickets, "open tickets")}
      ${stat("cases", st.cases_week, "cases this week")}
      ${stat("warns", st.warns_total, "warnings issued")}
      ${stat("trusted", st.whitelist, "trusted users")}
      ${stat("logs", `${d.log_channels_set}/${d.log_channels_total}`, "log channels set")}
      ${st.avg_rating != null ? stat("levels", st.avg_rating, "average ticket rating") : ""}
    </div>
    <section class="group"><h3>Recent cases</h3>
    ${d.recent_cases.length ? dataTable([
      ["Case", (c) => "#" + c.number, "mono"],
      ["Action", (c) => `<span class="pill ${esc(c.action)}">${esc(c.action)}</span>`],
      ["Member", (c, x) => who(x.users, c.user_id)],
      ["Moderator", (c, x) => who(x.users, c.moderator_id)],
      ["When", (c) => when(c.created_at), "nw"],
    ], d.recent_cases, d)
      : `<div class="tablewrap">${empty("No cases yet", "Bans, kicks, mutes and warnings will show up here.", "cases")}</div>`}
    </section>`;
  main.querySelectorAll(".armed input").forEach((inp) => {
    inp.onchange = guard(async () => {
      const tile = inp.closest(".armed"), key = tile.dataset.p;
      try {
        await send("PATCH", `/config/${key}`, { values: { enabled: inp.checked } });
      } catch (e) { inp.checked = !inp.checked; throw e; }
      tile.classList.toggle("on", inp.checked);
      tile.querySelector(".state").textContent = inp.checked ? "Armed" : "Off";
      toast(`${key === "antinuke" ? "Anti-nuke" : key === "antiraid" ? "Anti-raid" : "Anti-spam"} ${inp.checked ? "armed" : "turned off"}`);
    });
  });
};

for (const [page, section] of [["antinuke", "antinuke"], ["antiraid", "antiraid"], ["antispam", "antispam"],
  ["welcome", "welcome"], ["general", "general"], ["ticket-settings", "tickets"]]) {
  PAGES[page] = (main) => sectionPage(main, section);
}

PAGES.levels = (main) => sectionPage(main, "levels", async (el) => {
  const roleOpts = options("role", null).replace("None", "Choose a role");
  el.innerHTML = `
    <section class="group"><h3>Role rewards</h3><div class="rows" id="rw"></div></section>
    <section class="group"><h3>Leaderboard</h3><div id="lb"></div></section>`;
  const rw = el.querySelector("#rw");
  const draw = (items) => {
    rw.innerHTML = (items.length ? items.map((r) => `<div class="listrow"><span>Level <b class="mono">${r.level}</b> grants <b>${esc(r.role_name)}</b></span>
      <button class="btn small danger" data-lvl="${r.level}">Remove</button></div>`).join("")
      : empty("No rewards yet", "Give members a role when they reach a level.", "levels")) +
      `<div class="addrow"><input type="number" id="rlvl" min="1" max="500" placeholder="Level" style="max-width:110px">
       <select id="rrole">${roleOpts}</select><button class="btn primary" id="radd">Add reward</button></div>`;
  };
  draw((await G("/levels/rewards")).items);
  rw.onclick = guard(async (e) => {
    if (e.target.dataset.lvl) draw((await send("DELETE", `/levels/rewards/${e.target.dataset.lvl}`)).items);
    if (e.target.id === "radd") {
      draw((await send("PUT", "/levels/rewards", {
        level: Number(rw.querySelector("#rlvl").value), role_id: rw.querySelector("#rrole").value || null })).items);
      toast("Reward saved");
    }
  });
  const lb = el.querySelector("#lb");
  pagedTable(lb, {
    url: "/levels/leaderboard", emptyTitle: "No XP earned yet", emptyText: "Members appear here after they chat with levels turned on.", emptyIcon: "levels",
    cols: [["Member", (r) => userObj(r.user)], ["Level", (r) => r.level, "num mono"], ["XP", (r) => r.xp.toLocaleString(), "num mono"]],
  });
});

/* ---- add/remove list helper used by several pages ---- */
function simpleList(el, cfg) {
  const draw = (items) => {
    el.innerHTML = (items.length ? items.map(cfg.row).join("") : empty(cfg.emptyTitle, cfg.emptyText, cfg.emptyIcon)) +
      `<div class="addrow">${cfg.form}<button class="btn primary" data-add>${cfg.addLabel}</button></div>`;
  };
  const refresh = (d) => draw(d.items);
  draw(cfg.initial);
  el.onclick = guard(async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { refresh(await send("DELETE", cfg.delPath(del.dataset.del))); toast("Removed"); }
    if (e.target.closest("[data-add]")) {
      refresh(await send("POST", cfg.path, cfg.body(el)));
      toast("Added");
    }
  });
  el.onkeydown = (e) => { if (e.key === "Enter" && e.target.matches(".addrow input")) el.querySelector("[data-add]").click(); };
}

PAGES.trusted = async (main) => {
  main.innerHTML = head("Trusted users", "Anti-nuke and anti-raid never act on these members or bots. Find an ID in Discord with right-click → Copy User ID.") +
    `<div class="rows" id="wl"></div>`;
  simpleList(main.querySelector("#wl"), {
    initial: (await G("/whitelist")).items, path: "/whitelist", delPath: (id) => `/whitelist/${id}`,
    emptyTitle: "Nobody is trusted yet", emptyText: "Add every admin and bot you rely on, or they may be stopped by anti-nuke.", emptyIcon: "trusted",
    row: (r) => `<div class="listrow"><span>${userObj(r.user)} <span class="muted"> added by ${esc(r.added_by ? r.added_by.name : "unknown")}</span></span>
      <button class="btn small danger" data-del="${r.user.id}">Remove</button></div>`,
    form: `<input type="text" id="uid" placeholder="User ID" inputmode="numeric" autocomplete="off">`,
    addLabel: "Add", body: (el) => ({ user_id: el.querySelector("#uid").value.trim() }),
  });
};

PAGES.blocked = async (main) => {
  main.innerHTML = head("Blocked members", "These members can't open tickets.") + `<div class="rows" id="bl"></div>`;
  simpleList(main.querySelector("#bl"), {
    initial: (await G("/tickets/blacklist")).items, path: "/tickets/blacklist", delPath: (id) => `/tickets/blacklist/${id}`,
    emptyTitle: "No one is blocked", emptyText: "Block a member by ID if they abuse the ticket system.", emptyIcon: "blocked",
    row: (r) => `<div class="listrow"><span>${userObj(r.user)} <span class="muted">${r.reason ? "· " + esc(r.reason) : ""}</span></span>
      <button class="btn small danger" data-del="${r.user.id}">Unblock</button></div>`,
    form: `<input type="text" id="uid" placeholder="User ID" inputmode="numeric" autocomplete="off"><input type="text" id="why" placeholder="Reason (optional)" maxlength="200">`,
    addLabel: "Block", body: (el) => ({ user_id: el.querySelector("#uid").value.trim(), reason: el.querySelector("#why").value }),
  });
};

PAGES.words = async (main) => {
  main.innerHTML = head("Word filter", "Messages containing these words add anti-spam points. Turn on regex for patterns.") + `<div class="rows" id="wd"></div>`;
  simpleList(main.querySelector("#wd"), {
    initial: (await G("/words")).items, path: "/words", delPath: (id) => `/words/${id}`,
    emptyTitle: "No filtered words", emptyText: "Add a word or pattern below.", emptyIcon: "words",
    row: (r) => `<div class="listrow"><span><code>${esc(r.word)}</code> ${r.is_regex ? '<span class="pill">regex</span>' : ""}</span>
      <button class="btn small danger" data-del="${r.id}">Remove</button></div>`,
    form: `<input type="text" id="w" placeholder="Word or pattern" maxlength="200" autocomplete="off">
      <label class="who"><input type="checkbox" id="rx"> Regex</label>`,
    addLabel: "Add", body: (el) => ({ word: el.querySelector("#w").value, is_regex: el.querySelector("#rx").checked }),
  });
};

PAGES.logs = async (main) => {
  const { channels } = await G("/logs");
  formView(main, {
    title: "Log channels", intro: "Pick where the bot posts each kind of event. Leave a category empty to skip it.",
    groups: [{ title: "Channels", fields: S.meta.log_categories.map((c) => ({
      key: c.key, label: c.key[0].toUpperCase() + c.key.slice(1), help: c.label, kind: "channel" })) }],
    values: channels,
    save: async (diff) => (await send("PUT", "/logs", { channels: diff })).channels,
  });
};

PAGES.ignored = async (main) => {
  main.innerHTML = head("Ignored", "Anti-spam, logs and levels skip these channels, roles and members.") +
    `<div class="stack" id="ig"></div>`;
  const root = main.querySelector("#ig");
  const draw = (d) => {
    const block = (kind, title, form) => `
      <section class="group"><h3>${title}</h3><div class="rows" data-kind="${kind}">
        ${d[kind].length ? `<div class="chips">${d[kind].map((x) =>
          `<span class="chip">${kind === "channel" ? "#" : ""}${esc(x.name)}<button aria-label="Remove ${esc(x.name)}" data-del="${x.id}">×</button></span>`).join("")}</div>`
          : empty("Nothing ignored", "", "ignored")}
        <div class="addrow">${form}<button class="btn primary" data-add>Add</button></div></div></section>`;
    root.innerHTML =
      block("channel", "Channels", `<select id="ci">${options("channel", null).replace("None", "Choose a channel")}</select>`) +
      block("role", "Roles", `<select id="ri">${options("role", null).replace("None", "Choose a role")}</select>`) +
      block("user", "Members", `<input type="text" id="ui" placeholder="User ID" inputmode="numeric" autocomplete="off">`);
  };
  draw(await G("/ignored"));
  root.onclick = guard(async (e) => {
    const rows = e.target.closest("[data-kind]");
    if (!rows) return;
    const kind = rows.dataset.kind;
    if (e.target.dataset.del) draw(await send("DELETE", `/ignored/${kind}/${e.target.dataset.del}`));
    if (e.target.closest("[data-add]")) {
      const v = rows.querySelector("select, input").value.trim();
      if (!v) { toast("Choose something to add first.", true); return; }
      draw(await send("POST", "/ignored", { kind, target_id: v }));
      toast("Added");
    }
  });
};

PAGES.cases = (main) => {
  main.innerHTML = head("Cases", "Every moderation action taken in this server.");
  pagedTable(main, {
    url: "/cases", emptyTitle: "No cases found", emptyText: "Cases appear when members are banned, kicked, muted or warned.", emptyIcon: "cases",
    toolbar: `${searchField("user", "Filter by user ID", "Filter by user ID")}
      <select name="action" aria-label="Filter by action"><option value="">All actions</option></select>`,
    onData: (d, tb) => {
      const sel = tb.querySelector("select"), v = sel.value;
      sel.innerHTML = `<option value="">All actions</option>` + d.actions.map((a) =>
        `<option ${a === v ? "selected" : ""}>${esc(a)}</option>`).join("");
    },
    cols: [["Case", (r) => "#" + r.number, "mono"], ["Action", (r) => `<span class="pill ${esc(r.action)}">${esc(r.action)}</span>${r.duration ? ` <span class="muted">${span(r.duration)}</span>` : ""}`],
      ["Member", (r, d) => who(d.users, r.user_id)], ["Moderator", (r, d) => who(d.users, r.moderator_id)],
      ["Reason", (r) => `<div class="reason">${esc(r.reason || "No reason given")}</div>`], ["When", (r) => when(r.created_at), "nw"]],
  });
};

PAGES.warns = (main) => {
  main.innerHTML = head("Warnings", "Active warnings. Remove one to take it off a member's record.");
  const t = pagedTable(main, {
    url: "/warns", emptyTitle: "No warnings", emptyText: "Nobody has been warned yet.", emptyIcon: "warns",
    toolbar: searchField("user", "Filter by user ID", "Filter by user ID"),
    cols: [["Member", (r, d) => who(d.users, r.user_id)], ["Moderator", (r, d) => who(d.users, r.moderator_id)],
      ["Reason", (r) => `<div class="reason">${esc(r.reason || "No reason given")}</div>`], ["When", (r) => when(r.created_at), "nw"],
      ["", (r) => `<button class="btn small danger" data-w="${r.id}">Remove</button>`, "num"]],
    onClick: guard(async (e) => {
      const id = e.target.dataset.w;
      if (!id) return;
      const ok = await confirmDialog({
        title: "Remove this warning?", text: "It will be taken off the member's record. This can't be undone.",
        confirmLabel: "Remove warning", danger: true });
      if (ok) { await send("DELETE", `/warns/${id}`); toast("Warning removed"); t.reload(); }
    }),
  });
};

PAGES.tickets = (main) => {
  main.innerHTML = head("Tickets", "Every ticket opened in this server, newest first.");
  pagedTable(main, {
    url: "/tickets", emptyTitle: "No tickets found", emptyText: "Tickets show up here once members open them from a panel.", emptyIcon: "tickets",
    toolbar: `<select name="status" aria-label="Filter by status"><option value="">All statuses</option><option value="open">Open</option><option value="closed">Closed</option><option value="deleted">Deleted</option></select>
      ${searchField("user", "Filter by user ID", "Filter by user ID")}`,
    cols: [["Ticket", (r) => "#" + r.number, "mono"], ["Member", (r, d) => who(d.users, r.user_id)], ["Category", (r) => esc(r.category_name || "—")],
      ["Priority", (r) => `<span class="pill ${esc(r.priority)}">${esc(r.priority)}</span>`], ["Status", (r) => `<span class="pill ${esc(r.status)}">${esc(r.status)}</span>`],
      ["Claimed by", (r, d) => who(d.users, r.claimed_by)], ["Opened", (r) => when(r.opened_at), "nw"],
      ["Rating", (r) => (r.rating ? "★".repeat(r.rating) : "—"), "num"]],
  });
};

PAGES.panels = async (main) => {
  const { items } = await G("/tickets/panels");
  main.innerHTML = head("Panels", "Ticket panels are created and posted from Discord with /panel crear, /panel categoria and /panel publicar.") +
    (items.length ? `<div class="stack">${items.map((p) => `
      <section class="group"><h3>${esc(p.name)} <span class="pill ${p.published ? "open" : ""}">${p.published ? "Published" : "Draft"}</span></h3>
        <div class="rows"><div class="listrow"><span><b>${esc(p.title)}</b><br><span class="muted">${p.style === "select" ? "Dropdown" : "Buttons"}${p.channel ? " in #" + esc(p.channel) : ""}</span></span></div>
        ${p.categories.length ? p.categories.map((c) => `<div class="listrow"><span>${esc(c.emoji || "")} <b>${esc(c.label)}</b>
          <span class="muted">${esc(c.description || "")}</span></span></div>`).join("") : `<div class="listrow muted">No categories yet.</div>`}
        </div></section>`).join("")}</div>`
      : `<div class="tablewrap">${empty("No panels yet", "Create one in Discord with /panel crear.", "panels")}</div>`);
};

PAGES.backups = async (main) => {
  const { items } = await G("/backups");
  main.innerHTML = head("Backups", "Saved copies of the server structure. Create and restore them in Discord with /backup.") +
    (items.length ? dataTable([
      ["Name", (b) => esc(b.name || "Untitled")], ["Created", (b) => when(b.created_at), "nw"], ["By", (b) => userObj(b.by)],
      ["Roles", (b) => b.roles, "num mono"], ["Categories", (b) => b.categories, "num mono"], ["Channels", (b) => b.channels, "num mono"],
    ], items, {})
      : `<div class="tablewrap">${empty("No backups yet", "Run /backup crear in Discord to save the current structure.", "backups")}</div>`);
};

/* ---------- boot ---------- */
window.addEventListener("hashchange", guard(route));
document.addEventListener("click", (e) => {
  if (e.target.closest("nav a")) closeDrawer();
  const trigger = e.target.closest("[data-dd]");
  const dd = trigger && trigger.closest(".dd");
  closeMenus(dd);
  if (dd) {
    const m = dd.querySelector(".menu");
    m.hidden = !m.hidden;
    trigger.setAttribute("aria-expanded", String(!m.hidden));
  } else if (e.target.closest(".menu")) {
    closeMenus();            // picked something inside an open menu
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector(".modal")) { closeMenus(); closeDrawer(); }
});
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
(async () => {
  try { S.session = await api("/session"); } catch (_) { return; }
  guard(route)();
})();
