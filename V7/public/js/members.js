'use strict';
/* MOONWEB Server Member Selector — reusable component for selecting Discord members.
   Provides searchable dropdown with avatar, username, nickname, and user ID. */

const MEM = {
  cache: new Map(), // guildId -> { members: [...], fetchedAt }
  pending: null,
  searchDebounce: null,
};

const MEMBER_LIMIT = 50;
const CACHE_TTL = 60 * 1000; // 1 minute

function avatarUrl(member, size = 32) {
  if (member.avatar) return `https://cdn.discordapp.com/avatars/${member.id}/${member.avatar}.png?size=${size}`;
  // Default avatar based on discriminator (legacy) or hash of ID
  const disc = member.discriminator ? parseInt(member.discriminator, 10) % 5 : 0;
  return `https://cdn.discordapp.com/embed/avatars/${disc}.png`;
}

function memberDisplayName(member) {
  return member.nickname || member.globalName || member.username;
}

function memberUsername(member) {
  return member.globalName ? `@${member.username}` : member.username;
}

async function fetchMembers(guildId, query = '', after = null) {
  const key = `${guildId}:${query}:${after || ''}`;
  const now = Date.now();
  const cached = MEM.cache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL) {
    return cached.members;
  }
  const params = new URLSearchParams({ limit: String(MEMBER_LIMIT) });
  if (query) params.set('q', query);
  if (after) params.set('after', after);
  const r = await api(`/guilds/${guildId}/members/search?${params}`);
  MEM.cache.set(key, { members: r.members, fetchedAt: now });
  return r.members;
}

async function fetchMemberById(guildId, userId) {
  const r = await api(`/guilds/${guildId}/members/${userId}`);
  return r.member;
}

function createMemberOption(member, onSelect, close) {
  const name = memberDisplayName(member);
  const user = memberUsername(member);
  const isBot = member.bot;
  return h('button', {
    class: `mem-opt${isBot ? ' bot' : ''}`,
    role: 'option',
    onclick: () => { onSelect(member); close(); },
  },
    h('span', { class: 'mem-avatar' },
      h('img', { src: avatarUrl(member), alt: '', loading: 'lazy' })),
    h('div', { class: 'mem-info' },
      h('div', { class: 'mem-name' }, name, member.nickname && member.globalName && h('span', { class: 'mem-real', text: ` (@${member.username})`) }),
      h('div', { class: 'mem-meta' }, h('span', { class: 'mem-user', text: user }), h('span', { class: 'mem-id mono faint', text: member.id })));
}

function memberSelector(inputEl, { guildId, onSelect, placeholder = 'Search members…', allowClear = true, allowManual = true }) {
  let open = false;
  let selectedMember = null;
  let searchQuery = '';
  let selectedIndex = -1;
  let options = [];
  let loading = false;
  let fetchMore = null;
  let popoverEl = null;
  let closePopover = null;

  const input = inputEl;

  function buildPopover(close) {
    popoverEl = h('div', { class: 'mem-popover', role: 'listbox' },
      h('div', { class: 'mem-search' },
        h('input', {
          type: 'search',
          placeholder,
          'aria-label': 'Search members',
          autocomplete: 'off',
          spellcheck: 'false',
          oninput: (e) => {
            searchQuery = e.target.value.trim();
            selectedIndex = -1;
            debouncedSearch();
          },
          onkeydown: (e) => handleKeyDown(e),
          onfocus: () => { if (!open) openDropdown(); },
        }),
        loading && h('span', { class: 'mem-loading' }, icon('trend', 16), ' Loading…')),
      h('div', { class: 'mem-list', role: 'listbox' }, ...options.map((m, i) => createMemberOption(m, onSelectMember, close))),
      (options.length === 0 && !loading) && h('div', { class: 'mem-empty' }, searchQuery ? 'No members match your search' : 'No members found in this server'),
      fetchMore && h('button', { class: 'mem-more', onclick: loadMore }, 'Load more…'),
      allowManual && h('div', { class: 'mem-manual' },
        h('hr'),
        h('label', {}, 'Or enter a User ID manually:'),
        h('input', {
          type: 'text',
          inputmode: 'numeric',
          placeholder: '123456789012345678',
          maxlength: 20,
          oninput: (e) => { manualInput = e.target.value.trim(); },
          onkeydown: (e) => { if (e.key === 'Enter' && manualInput) { validateManual(); } },
        }),
        h('button', { class: 'btn small primary', onclick: validateManual }, 'Use this ID')));

    return popoverEl;
  }

  let manualInput = '';
  async function validateManual() {
    if (!SNOWFLAKE.test(manualInput)) return toast('Enter a valid Discord user ID (17–20 digits)', 'error');
    try {
      const member = await fetchMemberById(guildId, manualInput);
      onSelectMember(member);
      closePopover();
    } catch (e) {
      toast(e.message || 'That user is not in this server', 'error');
    }
  }

  function debouncedSearch() {
    clearTimeout(MEM.searchDebounce);
    MEM.searchDebounce = setTimeout(() => {
      searchMembers();
    }, 200);
  }

  async function searchMembers(afterId = null) {
    loading = true;
    fetchMore = null;
    if (!afterId) { options = []; selectedIndex = -1; }
    renderList();
    try {
      const members = await fetchMembers(guildId, searchQuery, afterId);
      if (!afterId) options = members;
      else options.push(...members);
      fetchMore = members.length >= MEMBER_LIMIT ? options[options.length - 1].id : null;
    } catch (e) {
      console.error('[memberSelector] search failed:', e);
      options = [];
    } finally {
      loading = false;
      renderList();
    }
  }

  function loadMore() {
    if (fetchMore) searchMembers(fetchMore);
  }

  function onSelectMember(member) {
    selectedMember = member;
    input.value = memberDisplayName(member);
    input.dataset.userId = member.id;
    if (onSelect) onSelect(member);
    input.dispatchEvent(new Event('change'));
  }

  function clearSelection() {
    selectedMember = null;
    input.value = '';
    delete input.dataset.userId;
    if (onSelect) onSelect(null);
    input.dispatchEvent(new Event('change'));
  }

  function renderList() {
    if (!popoverEl) return;
    const list = popoverEl.querySelector('.mem-list');
    if (!list) return;
    list.replaceChildren(...options.map((m, i) => createMemberOption(m, onSelectMember, closePopover)));
    const empty = popoverEl.querySelector('.mem-empty');
    if (empty) empty.remove();
    if (options.length === 0 && !loading) {
      list.insertAdjacentHTML('afterend', `<div class="mem-empty">${searchQuery ? 'No members match your search' : 'No members found in this server'}</div>`);
    }
    const moreBtn = popoverEl.querySelector('.mem-more');
    if (moreBtn) moreBtn.style.display = fetchMore ? '' : 'none';
    const loadingEl = popoverEl.querySelector('.mem-loading');
    if (loadingEl) loadingEl.style.display = loading ? '' : 'none';
  }

  function handleKeyDown(e) {
    if (!options.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
      highlightOption();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(0, selectedIndex - 1);
      highlightOption();
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      onSelectMember(options[selectedIndex]);
      closePopover();
    } else if (e.key === 'Escape') {
      closePopover();
    }
  }

  function highlightOption() {
    const items = popoverEl?.querySelectorAll('.mem-opt');
    items?.forEach((el, i) => el.classList.toggle('sel', i === selectedIndex));
    const sel = items?.[selectedIndex];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function openDropdown() {
    if (open) return;
    open = true;
    searchQuery = '';
    selectedIndex = -1;
    closePopover = popover(input, buildPopover, { minWidth: 360 });
    // Focus the search input inside popover
    setTimeout(() => popoverEl?.querySelector('input[type="search"]')?.focus(), 10);
    searchMembers();
  }

  function closeDropdown() {
    if (!open) return;
    open = false;
    if (closePopover) closePopover();
    closePopover = null;
    popoverEl = null;
  }

  // Input click/focus opens dropdown
  input.addEventListener('click', (e) => {
    if (!open) openDropdown();
  });
  input.addEventListener('focus', () => {
    if (!open) openDropdown();
  });

  // Clear button
  if (allowClear) {
    const clearBtn = h('button', { class: 'mem-clear', type: 'button', 'aria-label': 'Clear selection', onclick: (e) => { e.stopPropagation(); clearSelection(); } }, icon('x', 14));
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(clearBtn);
    const updateClear = () => { clearBtn.style.display = selectedMember ? 'flex' : 'none'; };
    input.addEventListener('input', updateClear);
    updateClear();
  }

  // Expose methods
  return {
    getValue: () => selectedMember?.id || null,
    getMember: () => selectedMember,
    setMember: (member) => { if (member) onSelectMember(member); else clearSelection(); },
    clear: clearSelection,
    open: openDropdown,
    close: closeDropdown,
  };
}

// Helper: create a member selector input group
function memberSelectorField(label, { guildId, onSelect, placeholder, allowClear = true, allowManual = true, required = false } = {}) {
  const wrapper = h('div', { class: 'field mem-field' });
  const lbl = h('label', { text: label });
  const input = h('input', {
    type: 'text',
    placeholder: placeholder || 'Search members…',
    readonly: true,
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    required,
  });
  wrapper.append(lbl, input);
  const selector = memberSelector(input, { guildId, onSelect, placeholder, allowClear, allowManual });
  return { wrapper, input, selector };
}

module.exports = { memberSelector, memberSelectorField, fetchMembers, fetchMemberById, MEM };