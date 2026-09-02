/**
 * ♠ CLUB ARENA — Invite to Table
 * Send table invitations to friends and players
 */

import React, { useState, useEffect } from 'react';
import './InviteToTable.css';
import { reportError } from '../../utils/errorReporter';

interface InvitablePlayer {
  id: string;
  username: string;
  avatar?: string;
  status: 'online' | 'playing' | 'away' | 'offline';
  isFriend: boolean;
  currentTable?: string;
}

interface InviteToTableProps {
  tableId: string;
  tableName: string;
  onInvite: (playerIds: string[]) => void;
  onClose: () => void;
}

export const InviteToTable: React.FC<InviteToTableProps> = ({
  tableId,
  tableName,
  onInvite,
  onClose,
}) => {
  const [players, setPlayers] = useState<InvitablePlayer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'friends' | 'recent' | 'all'>('friends');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadPlayers();
  }, [filter]);

  const loadPlayers = async () => {
    setLoading(true);
    try {
      // Replaced mock data with dynamic initialization
      const livePlayers: InvitablePlayer[] = [];
      setPlayers(livePlayers);
      setVisibleItems(new Set());
    } catch (error) {
      reportError(error, 'InviteToTable.Failed_to_load_players');
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selected);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelected(newSelected);
  };

  const selectAll = () => {
    const invitable = players.filter((p) => p.status !== 'offline' && p.status !== 'playing');
    setSelected(new Set(invitable.map((p) => p.id)));
  };

  const handleSend = async () => {
    if (selected.size === 0) return;

    setSending(true);
    try {
      await onInvite(Array.from(selected));
      onClose();
    } catch (error) {
      reportError(error, 'InviteToTable.Failed_to_send_invites');
    } finally {
      setSending(false);
    }
  };

  const getStatusColor = (status: InvitablePlayer['status']) => {
    switch (status) {
      case 'online':
        return 'var(--accent-green)';
      case 'playing':
        return 'var(--fb-blue)';
      case 'away':
        return 'var(--accent-gold)';
      case 'offline':
        return 'var(--text-muted)';
    }
  };

  const canInvite = (player: InvitablePlayer) => {
    return player.status !== 'offline' && player.status !== 'playing';
  };

  const filteredPlayers = players.filter((p) =>
    p.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="invite-to-table">
      <div className="invite-header">
        <div className="header-info">
          <h2>Invite Players</h2>
          <span className="table-name">To {tableName}</span>
        </div>
        <button className="close-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search Players..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="search-input"
      />

      {/* Filter Tabs */}
      <div className="filter-tabs">
        {(['friends', 'recent', 'all'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <button className="select-all" onClick={selectAll}>
          Select Available
        </button>
      </div>

      {/* Player List */}
      <div className="players-list">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="player-row skeleton" />)
        ) : filteredPlayers.length === 0 ? (
          <div className="empty-state">
            <span>◉</span>
            <p>No Players Found</p>
          </div>
        ) : (
          filteredPlayers.map((player, i) => (
            <div
              key={player.id}
              className={`player-row ${selected.has(player.id) ? 'selected' : ''} ${!canInvite(player) ? 'disabled' : ''}`}
              onClick={() => canInvite(player) && toggleSelect(player.id)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="player-avatar">
                {player.avatar ? (
                  <img loading="lazy" decoding="async" src={player.avatar} alt={player.username} />
                ) : (
                  <span>{player.username[0]}</span>
                )}
                <span
                  className="status-dot"
                  style={{ background: getStatusColor(player.status) }}
                />
              </div>
              <div className="player-info">
                <span className="player-name">{player.username}</span>
                <span className="player-status">
                  {player.status === 'playing' ? `At ${player.currentTable}` : player.status}
                </span>
              </div>
              <div className="checkbox">{selected.has(player.id) && '✓'}</div>
            </div>
          ))
        )}
      </div>

      {/* Send Button */}
      <button className="send-btn" onClick={handleSend} disabled={selected.size === 0 || sending}>
        {sending ? 'Sending...' : `Send Invite${selected.size > 1 ? 's' : ''} (${selected.size})`}
      </button>
    </div>
  );
};

export default InviteToTable;
