/**
 * ♠ CLUB ARENA — Player Search (Admin)
 * Search and manage players across clubs - Real Supabase integration
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import './PlayerSearch.css';

interface Player {
  id: string;
  username: string;
  avatar?: string;
  email?: string;
  status: 'active' | 'banned' | 'suspended';
  joinedAt: string;
  lastActive: string;
  balance: number;
  clubs: string[];
}

interface PlayerSearchProps {
  clubId?: string;
  onPlayerSelect?: (player: Player) => void;
  onBanPlayer?: (playerId: string) => void;
  onViewProfile?: (playerId: string) => void;
}

export const PlayerSearch: React.FC<PlayerSearchProps> = ({
  clubId,
  onPlayerSelect,
  onBanPlayer,
  onViewProfile,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);
  const isMounted = useIsMounted();
  const [searchType, setSearchType] = useState<'username' | 'email' | 'id'>('username');
  const [searched, setSearched] = useState(false);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);
    try {
      // Real Supabase search
      let profileQuery = supabase
        .from('profiles')
        .select(
          `
                    id,
                    username,
                    avatar_url,
                    email,
                    status,
                    created_at,
                    last_active
                `
        )
        .limit(20);

      // Apply search filter based on type
      if (searchType === 'username') {
        profileQuery = profileQuery.ilike('username', `%${query}%`);
      } else if (searchType === 'email') {
        profileQuery = profileQuery.ilike('email', `%${query}%`);
      } else if (searchType === 'id') {
        profileQuery = profileQuery.eq('id', query);
      }

      const { data: profiles, error } = await profileQuery;

      if (error) {
        console.error('Search error:', error);
        setResults([]);
        return;
      }

      // Get club memberships for each player
      const playerIds = profiles?.map((p) => p.id) || [];

      const clubCounts: Record<string, number> = {};
      const balances: Record<string, number> = {};

      if (playerIds.length > 0) {
        // Get club membership counts
        const { data: memberships } = await supabase
          .from('club_members')
          .select('user_id, club_id')
          .in('user_id', playerIds);

        if (memberships) {
          memberships.forEach((m) => {
            clubCounts[m.user_id] = (clubCounts[m.user_id] || 0) + 1;
          });
        }

        // Get wallet balances
        const { data: wallets } = await supabase
          .from('wallets')
          .select('user_id, play_balance')
          .in('user_id', playerIds);

        if (wallets) {
          wallets.forEach((w) => {
            balances[w.user_id] = w.play_balance || 0;
          });
        }
      }

      // Map to Player interface
      const players: Player[] = (profiles || []).map((p) => ({
        id: p.id,
        username: p.username || 'Unknown',
        avatar: p.avatar_url,
        email: p.email,
        status: (p.status || 'active') as Player['status'],
        joinedAt: p.created_at,
        lastActive: p.last_active || p.created_at,
        balance: balances[p.id] || 0,
        clubs: Array(clubCounts[p.id] || 0).fill('Club'),
      }));

      setResults(players);
      setVisibleItems(new Set());
      players.forEach((_, i) => {
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
      });
    } catch (error) {
      console.error('Failed to search players:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, searchType]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString();
  };

  const getStatusBadge = (status: Player['status']) => {
    switch (status) {
      case 'active':
        return <span className="status-badge active">Active</span>;
      case 'banned':
        return <span className="status-badge banned">Banned</span>;
      case 'suspended':
        return <span className="status-badge suspended">Suspended</span>;
    }
  };

  return (
    <div className="player-search">
      <div className="search-header">
        <h2>🔍 Player Search</h2>
      </div>

      {/* Search Bar */}
      <div className="search-controls">
        <div className="search-type">
          {(['username', 'email', 'id'] as const).map((type) => (
            <button
              key={type}
              className={searchType === type ? 'active' : ''}
              onClick={() => setSearchType(type)}
            >
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
        <div className="search-input">
          <input
            type="text"
            placeholder={`Search by ${searchType}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button className="search-btn" onClick={handleSearch} disabled={loading}>
            {loading ? '...' : '🔍'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="search-results">
        {!searched ? (
          <div className="empty-state">
            <span>👤</span>
            <p>Search for players to manage</p>
          </div>
        ) : loading ? (
          <div className="empty-state">
            <span>⏳</span>
            <p>Searching...</p>
          </div>
        ) : results.length === 0 ? (
          <div className="empty-state">
            <span>🔍</span>
            <p>No players found matching "{query}"</p>
          </div>
        ) : (
          results.map((player, i) => (
            <div
              key={player.id}
              className="player-row"
              onClick={() => onPlayerSelect?.(player)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="player-avatar">
                {player.avatar ? (
                  <img src={player.avatar} alt={player.username} />
                ) : (
                  <span>{player.username[0]?.toUpperCase() || '?'}</span>
                )}
              </div>
              <div className="player-info">
                <div className="player-header">
                  <span className="player-name">{player.username}</span>
                  {getStatusBadge(player.status)}
                </div>
                {player.email && <span className="player-email">{player.email}</span>}
                <div className="player-meta">
                  <span>Joined: {formatDate(player.joinedAt)}</span>
                  <span>Clubs: {player.clubs.length}</span>
                  <span>Balance: {player.balance.toLocaleString()}</span>
                </div>
              </div>
              <div className="player-actions">
                <button
                  className="action-btn view"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewProfile?.(player.id);
                  }}
                >
                  👁️
                </button>
                {player.status !== 'banned' && (
                  <button
                    className="action-btn ban"
                    onClick={(e) => {
                      e.stopPropagation();
                      onBanPlayer?.(player.id);
                    }}
                  >
                    🚫
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default PlayerSearch;
