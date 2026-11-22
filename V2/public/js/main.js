'use strict';
window.addEventListener('hashchange', onRoute);
(async function boot() {
  try { state.me = await api('/me'); } catch { state.me = null; }
  state.loading = false;
  const saved = ssGet('guild');
  if (state.me && saved && state.me.guilds.some((g) => g.id === saved && g.botPresent)) await openGuild(saved);
  else render();
})();
