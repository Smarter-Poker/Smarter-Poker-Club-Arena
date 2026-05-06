import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { PresenceIndicator } from './PresenceIndicator';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './OnlinePlayersList.css';
import { reportError } from '../../utils/errorReporter';

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
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

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
          table: 'profiles',
        },
        () => {
          loadOnlinePlayers();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'OnlinePlayersList._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[OnlinePlayersList] ⏱️ Realtime channel timed out');
        }
      });

    // Refresh every 30 seconds
    const interval = setInterval(loadOnlinePlayers, 30000);

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      clearInterval(interval);
    };
  }, [clubId]);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = players.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [players]);

  const loadOnlinePlayers = async () => {
    try {
      // NOTE: player_presence table does not exist yet (future feature).
      // Use profiles.is_online as fallback for online player listing.

      if (clubId) {
        const resolvedId = await resolveClubUUID(clubId);
        // Get online club members via join
        const { data: members } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', resolvedId);

        if (!members || members.length === 0) {
          setPlayers([]);
          setOnlineCount(0);
          setLoading(false);
          return;
        }

        const memberIds = members.map((m) => m.user_id);
        // Chunk to avoid URI length issues
        const chunkSize = 150;
        let allProfiles: any[] = [];
        for (let i = 0; i < memberIds.length; i += chunkSize) {
          const chunk = memberIds.slice(i, i + chunkSize);
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, username, full_name, avatar_url, is_online, last_seen')
            .in('id', chunk)
            .eq('is_online', true);
          if (profiles) allProfiles.push(...profiles);
        }

        // Sort by last_seen descending, limit
        allProfiles.sort(
          (a, b) => new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime()
        );
        allProfiles = allProfiles.slice(0, limit);

        const mapped = allProfiles.map((p: any) => ({
          id: p.id,
          username: p.username || 'Unknown',
          displayName: p.full_name || p.username || 'Unknown',
          avatarUrl: p.avatar_url,
          status: 'online' as const,
          currentTable: undefined,
        }));
        setPlayers(mapped);
        setOnlineCount(mapped.length);
      } else {
        // Global fetch — get online profiles
        const { data: profiles, count } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url, is_online, last_seen', { count: 'exact' })
          .eq('is_online', true)
          .order('last_seen', { ascending: false })
          .limit(limit);

        const mapped = (profiles || []).map((p: any) => ({
          id: p.id,
          username: p.username || 'Unknown',
          displayName: p.full_name || p.username || 'Unknown',
          avatarUrl: p.avatar_url,
          status: 'online' as const,
          currentTable: undefined,
        }));
        setPlayers(mapped);
        setOnlineCount(count || mapped.length);
      }
    } catch (error) {
      reportError(error, 'OnlinePlayersList.Failed_to_load_online_players');
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
