"use strict";

/* ===================================================================
   Zyn Bot dashboard. No build step: plain JS talking to /api.
   Settings forms are generated from the schema the server sends.
   =================================================================== */

const S = { session: null, meta: null, gid: null, page: null, dirty: false, lastHash: "" };
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
function empty(title, text) { return `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`; }
function head(title, intro) {
  return `<div class="page-head"><h1>${esc(title)}</h1>${intro ? `<p>${esc(intro)}</p>` : ""}</div>`;
}
function skeleton(el) { el.innerHTML = `<div class="skeleton"></div>`; }

async function logout() {
  try { await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "zyn-dashboard" } }); } catch (_) {}
  S.session = null; S.meta = null; S.gid = null;
  history.replaceState(null, "", "/");
  renderLogin();
}

/* ---------- login ---------- */
function renderLogin() {
  const failed = new URLSearchParams(location.search).get("login") === "failed";
  app.innerHTML = `
    <main class="login"><div class="login-box">
      <svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2447f5"/><path d="M16 6l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V9z" fill="#fff"/></svg>
      <h1>Your server's security, from the browser.</h1>
      <p>Sign in with Discord to manage anti-nuke, anti-raid, tickets, logs and everything else for servers where you're an admin.</p>
      <a class="btn primary" href="/auth/login">Sign in with Discord</a>
      ${failed ? `<div class="notice">Sign-in didn't complete. Try again.</div>` : ""}
    </div></main>`;
}

/* ---------- navigation ---------- */
const NAV = [
  ["overview", "Overview", null],
  ["antinuke", "Anti-nuke", "Protection"], ["antiraid", "Anti-raid", "Protection"],
  ["antispam", "Anti-spam", "Protection"], ["words", "Word filter", "Protection"],
  ["trusted", "Trusted users", "Protection"],
  ["cases", "Cases", "Moderation"], ["warns", "Warnings", "Moderation"],
  ["tickets", "Tickets", "Tickets"], ["ticket-settings", "Ticket settings", "Tickets"],
  ["panels", "Panels", "Tickets"], ["blocked", "Blocked members", "Tickets"],
  ["welcome", "Welcome & goodbye", "Community"], ["levels", "Levels", "Community"],
  ["general", "General", "Server"], ["logs", "Log channels", "Server"],
  ["ignored", "Ignored", "Server"], ["backups", "Backups", "Server"],
];

function shell() {
  const g = S.session.guilds.find((x) => x.id === S.gid);
  let lastGroup = "__";
  const links = NAV.map(([id, label, group]) => {
    const heading = group !== lastGroup && group ? `<h4>${esc(group)}</h4>` : "";
    lastGroup = group;
    return `${heading}<a href="#/${S.gid}/${id}" ${id === S.page ? 'aria-current="page"' : ""}>${esc(label)}</a>`;
  }).join("");
  const icon = (x) => x.icon ? `<img class="avatar" src="${esc(x.icon)}" alt="">`
    : `<span class="avatar">${esc(x.name.slice(0, 1).toUpperCase())}</span>`;
  const others = S.session.guilds.filter((x) => x.id !== S.gid)
    .map((x) => `<button data-guild="${x.id}">${icon(x)}<span>${esc(x.name)}</span></button>`).join("");
  app.innerHTML = `
    <div class="topbar"><button class="btn small" id="burger" aria-label="Open menu">Menu</button><b>${esc(g ? g.name : "Dashboard")}</b></div>
    <div class="shell">
      <aside class="side" id="side">
        <div class="guild-switch">
          <button class="guild-btn" id="gswitch" aria-haspopup="true" aria-expanded="false">
            ${g ? icon(g) : ""}<span><b>${esc(g ? g.name : "")}</b><small>${g ? g.members.toLocaleString() + " members" : ""}</small></span><span aria-hidden="true">⌄</span>
          </button>
          <div class="menu" id="gmenu" hidden>${others}${others ? "<hr>" : ""}
            <button data-guild="">All servers</button>
            <a href="${esc(S.session.invite)}" target="_blank" rel="noopener">Add the bot to a server</a>
          </div>
        </div>
        <nav>${links}</nav>
        <div class="user-row">${avatar(S.session.user)}<span>${esc(S.session.user.name)}</span>
          <button class="btn small ghost" id="logout">Sign out</button></div>
      </aside>
      <main class="main" id="main"></main>
    </div>`;
  const side = document.getElementById("side");
  document.getElementById("burger").onclick = () => side.classList.toggle("open");
  const menu = document.getElementById("gmenu"), sw = document.getElementById("gswitch");
  sw.onclick = () => { menu.hidden = !menu.hidden; sw.setAttribute("aria-expanded", String(!menu.hidden)); };
  menu.onclick = (e) => {
    const b = e.target.closest("[data-guild]");
    if (b) location.hash = b.dataset.guild ? `#/${b.dataset.guild}/overview` : "#/";
  };
  document.getElementById("logout").onclick = async () => {
    await logout();
  };
  return document.getElementById("main");
}

/* ---------- guild picker ---------- */
function renderPicker() {
  const gs = S.session.guilds;
  app.innerHTML = `
    <main class="login"><div class="login-box">
      <h1>Pick a server</h1>
      <p>${gs.length ? "These are the servers where the bot is present and you're an admin." :
        "The bot isn't in any server you manage yet."}</p>
      <div class="rows" style="min-width:min(420px,86vw)">
        ${gs.map((g) => `<a class="listrow" style="text-decoration:none;color:inherit" href="#/${g.id}/overview">
          ${g.icon ? `<img class="avatar" src="${esc(g.icon)}" alt="">` : `<span class="avatar">${esc(g.name.slice(0, 1).toUpperCase())}</span>`}
          <span><b>${esc(g.name)}</b><br><small class="muted">${g.members.toLocaleString()} members</small></span></a>`).join("")}
        <div class="listrow"><a class="btn" href="${esc(S.session.invite)}" target="_blank" rel="noopener">Add the bot to a server</a></div>
      </div>
      <p style="margin-top:20px"><button class="btn small ghost" id="logout2">Sign out as ${esc(S.session.user.name)}</button></p>
    </div></main>`;
  document.getElementById("logout2").onclick = logout;
}

/* ---------- router ---------- */
async function route() {
  if (!S.session) { try { S.session = await api("/session"); } catch (_) { return; } }
  if (S.dirty && !confirm("You have unsaved changes. Leave this page?")) {
    location.hash = S.lastHash; return;
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
  el.onclick = (e) => { const a = e.target.dataset.act; if (a && bar) bar[a](); };
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
    save: guard(async () => {
      const diff = {};
      changed().forEach((k) => (diff[k] = cur[k]));
      const res = await view.save(diff);
      Object.assign(orig, res); Object.assign(cur, res);
      refresh(); toast("Saved");
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

/* A filterable, paged table. cfg: {url, filters:[html], cols:[[label, fn, cls]], emptyTitle, emptyText} */
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
    tbl.innerHTML = d.items.length ? `<div class="tablewrap"><table><thead><tr>${cfg.cols.map(([l, , c]) =>
      `<th class="${c || ""}">${esc(l)}</th>`).join("")}</tr></thead><tbody>${d.items.map((r) =>
      `<tr>${cfg.cols.map(([, fn, c]) => `<td class="${c || ""}">${fn(r, d)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : `<div class="tablewrap">${empty(cfg.emptyTitle, cfg.emptyText)}</div>`;
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
  main.innerHTML = head(S.meta.guild.name, "Protection status and recent activity.") + `
    <div class="armed-band">${defs.map(([k, name, text]) => `
      <div class="armed ${d.protections[k] ? "on" : ""}" data-p="${k}">
        <div class="armed-top"><h3>${name}</h3>
          <label class="switch"><input type="checkbox" role="switch" aria-label="${name}" ${d.protections[k] ? "checked" : ""}><i></i></label></div>
        <div class="state">${d.protections[k] ? "Armed" : "Off"}</div>
        <p>${text}</p><a href="#/${S.gid}/${k}">Settings</a></div>`).join("")}</div>
    <div class="facts">
      <div class="fact"><b>${st.open_tickets}</b><span>open tickets</span></div>
      <div class="fact"><b>${st.cases_week}</b><span>cases this week</span></div>
      <div class="fact"><b>${st.warns_total}</b><span>warnings issued</span></div>
      <div class="fact"><b>${st.whitelist}</b><span>trusted users</span></div>
      <div class="fact"><b>${d.log_channels_set}/${d.log_channels_total}</b><span>log channels set</span></div>
      ${st.avg_rating != null ? `<div class="fact"><b>${st.avg_rating}</b><span>average ticket rating</span></div>` : ""}
    </div>
    <section class="group"><h3>Recent cases</h3>
    ${d.recent_cases.length ? `<div class="tablewrap"><table><thead><tr><th>Case</th><th>Action</th><th>Member</th><th>Moderator</th><th>When</th></tr></thead><tbody>
      ${d.recent_cases.map((c) => `<tr><td class="mono">#${c.number}</td><td><span class="pill ${esc(c.action)}">${esc(c.action)}</span></td>
        <td>${who(d.users, c.user_id)}</td><td>${who(d.users, c.moderator_id)}</td><td>${when(c.created_at)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="tablewrap">${empty("No cases yet", "Bans, kicks, mutes and warnings will show up here.")}</div>`}
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
      : empty("No rewards yet", "Give members a role when they reach a level.")) +
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
    url: "/levels/leaderboard", emptyTitle: "No XP earned yet", emptyText: "Members appear here after they chat with levels turned on.",
    cols: [["Member", (r) => userObj(r.user)], ["Level", (r) => r.level, "num mono"], ["XP", (r) => r.xp.toLocaleString(), "num mono"]],
  });
});

/* ---- add/remove list helper used by several pages ---- */
function simpleList(el, cfg) {
  const draw = (items) => {
    el.innerHTML = (items.length ? items.map(cfg.row).join("") : empty(cfg.emptyTitle, cfg.emptyText)) +
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
    emptyTitle: "Nobody is trusted yet", emptyText: "Add every admin and bot you rely on, or they may be stopped by anti-nuke.",
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
    emptyTitle: "No one is blocked", emptyText: "Block a member by ID if they abuse the ticket system.",
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
    emptyTitle: "No filtered words", emptyText: "Add a word or pattern below.",
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
          : empty("Nothing ignored", "")}
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
    url: "/cases", emptyTitle: "No cases found", emptyText: "Cases appear when members are banned, kicked, muted or warned.",
    toolbar: `<input type="search" name="user" placeholder="Filter by user ID" inputmode="numeric" aria-label="Filter by user ID">
      <select name="action" aria-label="Filter by action"><option value="">All actions</option></select>`,
    onData: (d, tb) => {
      const sel = tb.querySelector("select"), v = sel.value;
      sel.innerHTML = `<option value="">All actions</option>` + d.actions.map((a) =>
        `<option ${a === v ? "selected" : ""}>${esc(a)}</option>`).join("");
    },
    cols: [["Case", (r) => "#" + r.number, "mono"], ["Action", (r) => `<span class="pill ${esc(r.action)}">${esc(r.action)}</span>${r.duration ? ` <span class="muted">${span(r.duration)}</span>` : ""}`],
      ["Member", (r, d) => who(d.users, r.user_id)], ["Moderator", (r, d) => who(d.users, r.moderator_id)],
      ["Reason", (r) => `<div class="reason">${esc(r.reason || "No reason given")}</div>`], ["When", (r) => when(r.created_at)]],
  });
};

PAGES.warns = (main) => {
  main.innerHTML = head("Warnings", "Active warnings. Remove one to take it off a member's record.");
  const t = pagedTable(main, {
    url: "/warns", emptyTitle: "No warnings", emptyText: "Nobody has been warned yet.",
    toolbar: `<input type="search" name="user" placeholder="Filter by user ID" inputmode="numeric" aria-label="Filter by user ID">`,
    cols: [["Member", (r, d) => who(d.users, r.user_id)], ["Moderator", (r, d) => who(d.users, r.moderator_id)],
      ["Reason", (r) => `<div class="reason">${esc(r.reason || "No reason given")}</div>`], ["When", (r) => when(r.created_at)],
      ["", (r) => `<button class="btn small danger" data-w="${r.id}">Remove</button>`, "num"]],
    onClick: guard(async (e) => {
      const id = e.target.dataset.w;
      if (id && confirm("Remove this warning? This can't be undone.")) { await send("DELETE", `/warns/${id}`); toast("Warning removed"); t.reload(); }
    }),
  });
};

PAGES.tickets = (main) => {
  main.innerHTML = head("Tickets", "Every ticket opened in this server, newest first.");
  pagedTable(main, {
    url: "/tickets", emptyTitle: "No tickets found", emptyText: "Tickets show up here once members open them from a panel.",
    toolbar: `<select name="status" aria-label="Filter by status"><option value="">All statuses</option><option value="open">Open</option><option value="closed">Closed</option><option value="deleted">Deleted</option></select>
      <input type="search" name="user" placeholder="Filter by user ID" inputmode="numeric" aria-label="Filter by user ID">`,
    cols: [["Ticket", (r) => "#" + r.number, "mono"], ["Member", (r, d) => who(d.users, r.user_id)], ["Category", (r) => esc(r.category_name || "—")],
      ["Priority", (r) => `<span class="pill ${esc(r.priority)}">${esc(r.priority)}</span>`], ["Status", (r) => `<span class="pill ${esc(r.status)}">${esc(r.status)}</span>`],
      ["Claimed by", (r, d) => who(d.users, r.claimed_by)], ["Opened", (r) => when(r.opened_at)],
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
      : `<div class="tablewrap">${empty("No panels yet", "Create one in Discord with /panel crear.")}</div>`);
};

PAGES.backups = async (main) => {
  const { items } = await G("/backups");
  main.innerHTML = head("Backups", "Saved copies of the server structure. Create and restore them in Discord with /backup.") +
    (items.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Created</th><th>By</th><th class="num">Roles</th><th class="num">Categories</th><th class="num">Channels</th></tr></thead><tbody>
      ${items.map((b) => `<tr><td>${esc(b.name || "Untitled")}</td><td>${when(b.created_at)}</td><td>${userObj(b.by)}</td>
        <td class="num mono">${b.roles}</td><td class="num mono">${b.categories}</td><td class="num mono">${b.channels}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="tablewrap">${empty("No backups yet", "Run /backup crear in Discord to save the current structure.")}</div>`);
};

/* ---------- boot ---------- */
window.addEventListener("hashchange", guard(route));
document.addEventListener("click", (e) => {
  const side = document.getElementById("side");
  if (side && e.target.closest("nav a")) side.classList.remove("open");
  const menu = document.getElementById("gmenu");
  if (menu && !menu.hidden && !e.target.closest(".guild-switch")) menu.hidden = true;
});
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
(async () => {
  try { S.session = await api("/session"); } catch (_) { return; }
  guard(route)();
})();
