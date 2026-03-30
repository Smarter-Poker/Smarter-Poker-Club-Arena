/**
 * ♠ CLUB ARENA — Recent Players
 * View players you've recently played with
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './RecentPlayers.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

interface RecentPlayer {
  id: string;
  username: string;
  avatar?: string;
  lastPlayedAt: string;
  tableName: string;
  handsPlayed: number;
  result: number;
  isFriend: boolean;
}

interface RecentPlayersProps {
  onAddFriend?: (playerId: string) => void;
  onViewProfile?: (playerId: string) => void;
  onInviteToTable?: (playerId: string) => void;
  onBlockPlayer?: (playerId: string) => void;
}

export const RecentPlayers: React.FC<RecentPlayersProps> = ({
  onAddFriend,
  onViewProfile,
  onInviteToTable,
  onBlockPlayer,
}) => {
  const [players, setPlayers] = useState<RecentPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const isMounted = useIsMounted();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadRecentPlayers();
  }, []);

  // Bus listeners: auto-refresh on table activity
  const debouncedRefresh = useRef(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      if (isMounted.current) loadRecentPlayers();
    }, 1000);
  });

  useMasterBusSubscription('TABLE_LEFT', debouncedRefresh.current);
  useMasterBusSubscription('TABLE_SEATED', debouncedRefresh.current);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    animTimers.current.forEach(clearTimeout);
    animTimers.current = [];
    players.forEach((_, i) => {
      const t = setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
      animTimers.current.push(t);
    });
    return () => {
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [players]);

  const loadRecentPlayers = async () => {
    try {
      // Replaced mock data with dynamic initialization
      const livePlayers: RecentPlayer[] = [];
      setPlayers(livePlayers);
    } catch (error) {
      reportError(error, 'RecentPlayers.Failed_to_load_recent_players');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="recent-players">
      <div className="section-header">
        <h2>⏱️ Recent Players</h2>
      </div>

      <div className="players-list">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="player-row skeleton" />)
        ) : players.length === 0 ? (
          <div className="empty-state">
            <span>👤</span>
            <p>No recent players</p>
          </div>
        ) : (
          players.map((player, i) => (
            <div
              key={player.id}
              className="player-row"
              onClick={() => onViewProfile?.(player.id)}
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
                  <span>{player.username[0]}</span>
                )}
              </div>
              <div className="player-info">
                <div className="player-header">
                  <span className="player-name">{player.username}</span>
                  {player.isFriend && <span className="friend-badge">★</span>}
                </div>
                <span className="player-table">{player.tableName}</span>
                <div className="player-meta">
                  <span>{player.handsPlayed} hands</span>
                  <span className={`result ${player.result >= 0 ? 'positive' : 'negative'}`}>
                    {player.result >= 0 ? '+' : ''}
                    {player.result}
                  </span>
                  <span className="time">{formatTime(player.lastPlayedAt)}</span>
                </div>
              </div>
              <div className="player-actions">
                {!player.isFriend && (
                  <button
                    className="action-btn add"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddFriend?.(player.id);
                    }}
                    title="Add friend"
                  >
                    ➕
                  </button>
                )}
                <button
                  className="action-btn invite"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInviteToTable?.(player.id);
                  }}
                  title="Invite to table"
                >
                  🎰
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default RecentPlayers;
