import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './BlockedPlayersList.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

interface BlockedPlayer {
  id: string;
  blockedUserId: string;
  username: string;
  avatar?: string;
  blockedAt: Date;
  reason?: string;
}

interface BlockedPlayersListProps {
  onUnblock?: (playerId: string) => void;
}

export const BlockedPlayersList: React.FC<BlockedPlayersListProps> = ({ onUnblock }) => {
  const { user } = useAuthUser();
  const toast = useToast();
  const [blockedPlayers, setBlockedPlayers] = useState<BlockedPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (user?.id) {
      loadBlockedPlayers();
    }
  }, [user?.id]);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = blockedPlayers.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [blockedPlayers]);

  const loadBlockedPlayers = async () => {
    setLoading(true);
    try {
      /* Every column name here was wrong, and had been since this component
         was written. `user_blocks` is (id, blocker_id, blocked_id, reason,
         created_at) — there is no blocked_user_id, no blocked_at and no
         user_id. The select 400'd (42703, then PGRST200 once the columns were
         right), `if (error) throw error` sent it to the catch, and the blocked
         list was permanently empty for everyone.
         The embed also needed fk_user_blocks_blocked_id_profiles, added
         2026-08-22 — blocker_id had had its FK all along, blocked_id never
         did. */
      const { data, error } = await supabase
        .from('user_blocks')
        .select(
          `
                    id,
                    blocked_id,
                    created_at,
                    reason,
                    blocked_user:blocked_id(
                        username,
                        avatar_url:arena_avatar_url
                    )
                `
        )
        .eq('blocker_id', user?.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      setBlockedPlayers(
        data?.map((b: any) => ({
          id: b.id,
          blockedUserId: b.blocked_id,
          username: b.blocked_user?.username || 'Unknown',
          avatar: b.blocked_user?.avatar_url,
          blockedAt: new Date(b.created_at),
          reason: b.reason,
        })) || []
      );
    } catch (error) {
      reportError(error, 'BlockedPlayersList.Failed_to_load_blocked_players');
    } finally {
      setLoading(false);
    }
  };

  const handleUnblock = (player: BlockedPlayer) => {
    setUnblocking(player.id);

    // EAGER STATE SYNCHRONIZATION: Remove from list immediately (BFCache-safe)
    const prevBlocked = blockedPlayers;
    setBlockedPlayers((prev) => prev.filter((p) => p.id !== player.id));
    onUnblock?.(player.blockedUserId);
    toast.success(`Unblocked ${player.username}`);

    // Fire-and-forget delete with rollback on failure
    void Promise.resolve(
      supabase
        .from('user_blocks')
        .delete()
        .eq('id', player.id)
        // `user_id` does not exist on this table; the owner column is
        // blocker_id. The delete 400'd, the rollback fired, and the toast said
        // "Failed to unblock player" every time — nobody could unblock anyone.
        .eq('blocker_id', user?.id || '')
    )
      .then(({ error }) => {
        if (error) {
          // Rollback on failure
          setBlockedPlayers(prevBlocked);
          toast.error('Failed to unblock player');
          reportError(error, 'BlockedPlayersList.Failed_to_unblock');
        }
        setUnblocking(null);
      })
      .catch((error: unknown) => {
        setBlockedPlayers(prevBlocked);
        toast.error('Failed to unblock player');
        reportError(error, 'BlockedPlayersList.Failed_to_unblock');
        setUnblocking(null);
      });
  };

  if (loading) {
    return <div className="blocked-players-loading">Loading...</div>;
  }

  return (
    <div className="blocked-players-list">
      <div className="blocked-header">
        <h3>Blocked Players</h3>
        <span className="blocked-count">{blockedPlayers.length}</span>
      </div>

      {blockedPlayers.length === 0 ? (
        <div className="no-blocked">
          <span className="no-blocked-icon">✓</span>
          <p>No Blocked Players</p>
        </div>
      ) : (
        <div className="blocked-items">
          {blockedPlayers.map((player, i) => (
            <div
              key={player.id}
              className="blocked-item"
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="blocked-avatar">
                {player.avatar ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={player.avatar}
                    alt=""
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = generateDefaultAvatar();
                    }}
                  />
                ) : (
                  <span>{player.username[0]}</span>
                )}
              </div>
              <div className="blocked-info">
                <span className="blocked-name">{player.username}</span>
                <span className="blocked-date">
                  Blocked {player.blockedAt.toLocaleDateString()}
                </span>
              </div>
              <button
                className="unblock-btn"
                onClick={() => handleUnblock(player)}
                disabled={unblocking === player.id}
              >
                {unblocking === player.id ? '...' : 'Unblock'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default BlockedPlayersList;
