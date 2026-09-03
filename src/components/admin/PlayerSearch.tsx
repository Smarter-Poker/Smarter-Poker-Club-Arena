/**
 * ♠ CLUB ARENA — Player Search (Admin)
 * Search and manage players across clubs - Real Supabase integration
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import './PlayerSearch.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

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
  // Distinguishes "the search ran and found nobody" from "the search did not
  // run". Those were the same screen until 2026-08-26.
  const [searchError, setSearchError] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);
    setSearchError(null);
    try {
      // SCOPED TO THE CLUB. Always.
      //
      // `clubId` has been a declared prop of this component all along and was
      // referenced NOWHERE in the query - so a staff member on one club's
      // Players tab searched every profile on the platform, all 1,022 of them,
      // email included. `profiles_select` is `USING (true)` for authenticated,
      // so nothing downstream narrowed it either.
      //
      // The inner embed on club_members does the scoping in the same round
      // trip: PostgREST turns `club_members!inner(club_id)` plus the matching
      // .eq into a join, so a profile with no membership in this club cannot
      // come back at all - it is filtered in the database, not after the rows
      // have already crossed the wire. Doing it by fetching the club's member
      // ids and passing them to .in() is not an option: 590 uuids is a 22KB
      // query string.
      //
      // The only mount is AgentManagementPage, which always has a club in its
      // route, so a missing clubId is a wiring mistake and says so rather than
      // quietly falling back to searching everybody.
      if (!clubId) {
        setResults([]);
        setSearchError('No Club Selected. Open This From A Club.');
        return;
      }

      let profileQuery = supabase
        .from('profiles')
        .select(
          `
                    id,
                    username,
                    avatar_url:arena_avatar_url,
                    email,
                    status,
                    created_at,
                    last_active,
                    club_members!inner(club_id)
                `
        )
        .eq('club_members.club_id', clubId)
        .limit(20);

      // Apply search filter based on type.
      //
      // `%` and `_` are ILIKE wildcards and used to pass straight through, so a
      // username containing an underscore over-matched. The locator escapes the
      // same three characters server-side, in fn_search_players (see
      // 20260903040000_player_search_escapes_like_wildcards.sql). This comment
      // used to cite a FindPlayerModal helper that never existed, which is part
      // of how the locator went so long without the guard.
      const likeSafe = query.trim().replace(/([\\%_])/g, '\\$1');

      if (searchType === 'username') {
        profileQuery = profileQuery.ilike('username', `%${likeSafe}%`);
      } else if (searchType === 'email') {
        profileQuery = profileQuery.ilike('email', `%${likeSafe}%`);
      } else if (searchType === 'id') {
        // profiles.id is a uuid. Anything that is not one made Postgres raise
        // 22P02 invalid input syntax, which the handler below turned into an
        // empty result set - so a hard database error and a genuine miss looked
        // exactly the same to the user. Answer the question we can answer.
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          query.trim()
        );
        if (!isUuid) {
          setResults([]);
          setSearchError('That Is Not A Valid Player ID. Search By Username Or Email Instead.');
          return;
        }
        profileQuery = profileQuery.eq('id', query.trim());
      }

      const { data: profiles, error } = await profileQuery;

      if (error) {
        // Say that the search FAILED. Reporting a failure as "no players found"
        // sends someone looking for a player who may well exist.
        reportError(error, 'PlayerSearch.Search_error');
        setResults([]);
        setSearchError('The Search Could Not Run. Please Try Again.');
        return;
      }

      // Get club memberships for each player
      const playerIds = profiles?.map((p) => p.id) || [];

      const clubCounts: Record<string, number> = {};
      const balances: Record<string, number> = {};

      if (playerIds.length > 0) {
        // Club membership counts, and the CLUB CHIP BALANCE, from the one table
        // that actually holds both.
        //
        // The balance used to come from `wallets` filtered to wallet_type
        // 'PLAYER'. That column read 0 for every player, structurally and
        // always: `wallets`' only SELECT policy is `Users can read own wallets`
        // (auth.uid() = user_id), so an admin querying .in('user_id', [...])
        // got back their own row and nothing else. A staff screen showing every
        // player with 0 chips is worse than showing no column.
        //
        // club_members.chip_balance is the live pool - it is what
        // fn_club_chip_circulation() counts - and it is already being read here
        // for the club count, so this costs no extra round trip.
        const { data: memberships } = await supabase
          .from('club_members')
          .select('user_id, club_id, chip_balance')
          .in('user_id', playerIds);

        if (memberships) {
          memberships.forEach((m) => {
            clubCounts[m.user_id] = (clubCounts[m.user_id] || 0) + 1;
            balances[m.user_id] = (balances[m.user_id] || 0) + Number(m.chip_balance || 0);
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
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = players.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    } catch (error) {
      reportError(error, 'PlayerSearch.Failed_to_search_players');
      setResults([]);
    } finally {
      if (isMounted.current) setLoading(false);
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
        <h2>Player Search</h2>
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
            placeholder={`Search By ${searchType}...`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button className="search-btn" onClick={handleSearch} disabled={loading}>
            {loading ? '...' : '⌕'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="search-results">
        {!searched ? (
          <div className="empty-state">
            <span>◉</span>
            <p>Search For Players To Manage</p>
          </div>
        ) : loading ? (
          <div className="empty-state">
            <span>◷</span>
            <p>Searching...</p>
          </div>
        ) : searchError ? (
          <div className="empty-state">
            <span>!</span>
            <p>{searchError}</p>
          </div>
        ) : results.length === 0 ? (
          <div className="empty-state">
            <span>⌕</span>
            <p>No Players Found Matching "{query}"</p>
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
                  <img
                    loading="lazy"
                    decoding="async"
                    src={player.avatar}
                    alt={player.username}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = generateDefaultAvatar();
                    }}
                  />
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
                  ◉
                </button>
                {player.status !== 'banned' && (
                  <button
                    className="action-btn ban"
                    onClick={(e) => {
                      e.stopPropagation();
                      onBanPlayer?.(player.id);
                    }}
                  >
                    ⊘
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
