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
          console.warn('[OnlinePlayersList] Realtime channel timed out');
        }
      });

    // Refresh every 30 seconds.
    // PERF 2026-08-24: gated on visibility. This runs a full club-roster fetch
    // plus a fan-out over profiles; in a hidden background tab it was doing all
    // of that forever for a list nobody was looking at. Refreshes once on
    // return so the list is never stale when it becomes visible again.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadOnlinePlayers();
    };
    const interval = setInterval(tick, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadOnlinePlayers();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
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
        // Chunk to avoid URI length issues.
        //
        // PERF 2026-08-24: these chunks were awaited ONE AT A TIME inside a for
        // loop, so a 1,200-member club paid EIGHT sequential round-trips every
        // 30 seconds to render roughly ten names. The chunks are completely
        // independent of one another - each is a disjoint set of ids - so
        // running them together costs the slowest one instead of the sum.
        // Promise.all preserves input order, and the results are sorted by
        // last_seen immediately below regardless, so the output is identical.
        const chunkSize = 150;
        const chunks: string[][] = [];
        for (let i = 0; i < memberIds.length; i += chunkSize) {
          chunks.push(memberIds.slice(i, i + chunkSize));
        }
        const chunkResults = await Promise.all(
          chunks.map((chunk) =>
            supabase
              .from('profiles')
              .select('id, username, full_name, avatar_url:arena_avatar_url, is_online, last_seen')
              .in('id', chunk)
              .eq('is_online', true)
          )
        );
        let allProfiles: any[] = [];
        for (const { data: profiles } of chunkResults) {
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
          .select('id, username, full_name, avatar_url:arena_avatar_url, is_online, last_seen', {
            count: 'exact',
          })
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
        <span className="online-count">{onlineCount} Online</span>
      </div>

      {players.length === 0 ? (
        <div className="no-players">No Players Online</div>
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
