import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { PresenceIndicator } from './PresenceIndicator';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './OnlinePlayersList.css';

interface OnlinePlayer {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  status: 'online' | 'playing';
  currentTable?: string;
}

interface OnlinePlayersListProps {
  clubId?: string;
  limit?: number;
  onPlayerClick?: (player: OnlinePlayer) => void;
}

export const OnlinePlayersList: React.FC<OnlinePlayersListProps> = ({
  clubId,
  limit = 20,
  onPlayerClick,
}) => {
  const [players, setPlayers] = useState<OnlinePlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlineCount, setOnlineCount] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadOnlinePlayers();

    // Subscribe to presence changes
    const channelKey = 'online_players';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'player_presence',
        },
        () => {
          loadOnlinePlayers();
        }
      )
      .subscribe();

    // Refresh every 30 seconds
    const interval = setInterval(loadOnlinePlayers, 30000);

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      clearInterval(interval);
    };
  }, [clubId]);

  useEffect(() => {
    players.forEach((_, i) => {
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
    });
  }, [players]);

  const loadOnlinePlayers = async () => {
    try {
      let userIdsFilter: string[] = [];
      if (clubId) {
        const resolvedId = await resolveClubUUID(clubId);
        const { data: members } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', resolvedId);

        if (members && members.length > 0) {
          userIdsFilter = members.map((m) => m.user_id);
        } else {
          setPlayers([]);
          setOnlineCount(0);
          setLoading(false);
          return;
        }
      }

      let allPresenceData: any[] = [];
      let totalPresenceCount = 0;

      if (clubId && userIdsFilter.length > 0) {
        // Chunk the filter array to prevent 414 URI Too Long errors in PostgREST on massive clubs
        const chunkSize = 150;
        const chunks = [];
        for (let i = 0; i < userIdsFilter.length; i += chunkSize) {
          chunks.push(userIdsFilter.slice(i, i + chunkSize));
        }

        const responses = await Promise.all(
          chunks.map((chunk) =>
            supabase
              .from('player_presence')
              .select('user_id, status, table_id, last_seen_at', { count: 'exact' })
              .in('status', ['online', 'playing'])
              .in('user_id', chunk)
          )
        );

        responses.forEach(({ data, count }) => {
          if (data) allPresenceData.push(...data);
          if (count) totalPresenceCount += count;
        });

        // Sort combined results descending by last_seen_at and enforce limit locally
        allPresenceData.sort(
          (a, b) =>
            new Date(b.last_seen_at || 0).getTime() - new Date(a.last_seen_at || 0).getTime()
        );
        allPresenceData = allPresenceData.slice(0, limit);
      } else if (!clubId) {
        // Global fetch
        const { data, count } = await supabase
          .from('player_presence')
          .select('user_id, status, table_id, last_seen_at', { count: 'exact' })
          .in('status', ['online', 'playing'])
          .order('last_seen_at', { ascending: false })
          .limit(limit);

        allPresenceData = data || [];
        totalPresenceCount = count || 0;
      }

      const data = allPresenceData;
      const count = totalPresenceCount;

      if (data && data.length > 0) {
        // Fetch profiles separately
        const userIds = data.map((p: any) => p.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .in('id', userIds);

        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

        const mapped = data.map((p: any) => {
          const profile = profileMap.get(p.user_id);
          return {
            id: p.user_id,
            username: profile?.username || 'Unknown',
            displayName: profile?.full_name || profile?.username || 'Unknown',
            avatarUrl: profile?.avatar_url,
            status: p.status,
            currentTable: p.table_id,
          };
        });
        setPlayers(mapped);
        setOnlineCount(count || mapped.length);
      }
    } catch (error) {
      console.error('Failed to load online players:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="online-players-loading">Loading...</div>;
  }

  return (
    <div className="online-players-list">
      <div className="list-header">
        <h4>Online Players</h4>
        <span className="online-count">{onlineCount} online</span>
      </div>

      {players.length === 0 ? (
        <div className="no-players">No players online</div>
      ) : (
        <div className="players-grid">
          {players.map((player, i) => (
            <div
              key={player.id}
              className="player-card"
              onClick={() => onPlayerClick?.(player)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="player-avatar">
                {player.avatarUrl ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={player.avatarUrl}
                    alt={player.displayName}
                  />
                ) : (
                  <span>{(player.displayName || '?')[0]}</span>
                )}
                <PresenceIndicator userId={player.id} size="small" />
              </div>
              <div className="player-name">{player.displayName}</div>
              {player.status === 'playing' && <div className="playing-badge"> In Game</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default OnlinePlayersList;
