// Member Selector Component - Reusable Discord member picker with search and pagination
// Must be imported and used in all User ID-based features

import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../core';

export const MemberSelector = ({ guildId, onSelect, selected, onClear, placeholder = 'Select a member...' }) => {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalMembers, setTotalMembers] = useState(0);
  const timeoutRef = useRef(null);
  const searchRef = useRef(null);

  const fetchMembers = async (searchTerm = '', pageNum = 1) => {
    if (loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('guildId', guildId);
      if (searchTerm) params.append('search', searchTerm);
      params.append('page', pageNum.toString());
      const response = await api(`/members?${params.toString()}`, { method: 'GET' });
      setMembers(response.members);
      setTotalMembers(response.total);
      setTotalPages(Math.ceil(response.total / 50));
    } catch (error) {
      console.error('Failed to fetch members:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      fetchMembers(search, page);
    }, 300);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [search, page, guildId]);

  useEffect(() => {
    if (!selected) return;
    const member = members.find((m) => m.id === selected);
    if (!member) {
      // Selected member not in current list, fetch fresh
      fetchMembers('', 1);
    }
  }, [selected, members]);

  const filtered = useMemo(() => {
    if (!search) return members;
    const lower = search.toLowerCase();
    return members.filter((m) => {
      return (
        m.username?.toLowerCase().includes(lower) ||
        m.global_name?.toLowerCase().includes(lower) ||
        m.nick?.toLowerCase().includes(lower) ||
        m.id.includes(lower)
      );
    });
  }, [members, search]);

  const handleSelect = (member) => {
    onSelect?.(member);
    searchRef.current?.blur();
  };

  const handleClear = () => {
    onClear?.();
    setSearch('');
    setPage(1);
  };

  return (
    <div className="member-selector">
      <div className="selector-controls">
        <input
          ref={searchRef}
          type="search"
        placeholder={selected ? members.find((m) => m.id === selected)?.global_name || selected : placeholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => {
            if (!members.length) fetchMembers('', 1);
          }}
          autoComplete="off"
        />
        {selected && (
          <button
            className="clear-btn"
            onClick={handleClear}
            aria-label="Clear selection"
          >
            ×
          </button>
        )}
      </div>

      {loading && <div className="loading">Loading members…</div>}

      {!loading && filtered.length === 0 && (
        <div className="no-results">
          <p>No members found</p>
          <small>Try a different search term or check your server permissions</small>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="member-list">
          {filtered.map((member) => (
            <div
              key={member.id}
              className={`member-item ${selected === member.id ? 'selected' : ''}`}
              onClick={() => handleSelect(member)}
            >
              <img
                src={member.avatar ? `https://cdn.discordapp.com/avatars/${member.id}/${member.avatar}.png` : '/img/default-avatar.png'}
                alt={member.global_name || member.username}
                className="avatar"
              />
              <div className="info">
                <div className="name">{member.global_name || member.username}</div>
                <div className="details">
                  {member.nick && <span className="nick">{member.nick}</span>}
                  <span className="id">{member.id}</span>
                </div>
              </div>
              {selected === member.id && <div className="selected-indicator">✓</div>}
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            disabled={page === totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
          <button
            onClick={() => setMembers([])}
            className="refresh"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
};

export const useMemberSelector = (guildId) => {
  const [selected, setSelected] = useState(null);
  const [member, setMember] = useState(null);

  const handleSelect = (m) => {
    setSelected(m.id);
    setMember(m);
  };

  const clear = () => {
    setSelected(null);
    setMember(null);
  };

  return { selected, member, onSelect: handleSelect, onClear: clear };
};
};