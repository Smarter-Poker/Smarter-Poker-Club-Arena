import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './WaitlistManager.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

interface VisibleItemsState {
  [key: string]: Set<number>;
}

interface WaitlistEntry {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  position: number;
  joinedAt: Date;
}

interface WaitlistManagerProps {
  tableId: string;
  tableName: string;
  maxSeats: number;
  currentPlayers: number;
  isDealer?: boolean;
  currentUserId?: string;
}

export const WaitlistManager: React.FC<WaitlistManagerProps> = ({
  tableId,
  tableName,
  maxSeats,
  currentPlayers,
  isDealer = false,
  currentUserId,
}) => {
  const { showToast } = useToast();
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const isMounted = useIsMounted();
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const isInWaitlist = waitlist.some((e) => e.userId === currentUserId);
  const myPosition = waitlist.find((e) => e.userId === currentUserId)?.position;

  useEffect(() => {
    loadWaitlist();

    // Real-time subscription
    const channelKey = `waitlist:${tableId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'table_waitlist',
          filter: `table_id=eq.${tableId}`,
        },
        () => {
          loadWaitlist();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'WaitlistManager._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[WaitlistManager] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [tableId]);

  const loadWaitlist = async () => {
    try {
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('id, user_id, created_at')
        .eq('table_id', tableId)
        /* ORDER BY created_at, not by the stored `position`.
           The stored column cannot be trusted: it was written client-side as
           `waitlist.length + 1`, so two players joining at once both claimed
           the same number, and nothing renumbered the queue when someone left
           (leave #2 of 5 and the next joiner takes 5 a second time). Join time
           is the only ordering that is correct without a write, and it is
           already what the engine's seat-offer path and WaitlistService use. */
        .order('created_at', { ascending: true });
      if (error) reportError(error, 'WaitlistManager.Load_failed');

      if (data && data.length > 0) {
        // Fetch profiles separately
        const userIds = data.map((e: any) => e.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url:arena_avatar_url')
          .in('id', userIds);

        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

        const mapped = data.map((e: any, idx: number) => {
          const profile = profileMap.get(e.user_id);
          return {
            id: e.id,
            userId: e.user_id,
            username: profile?.username || 'Unknown',
            displayName: profile?.full_name || profile?.username || 'Unknown',
            avatarUrl: profile?.avatar_url,
            // Display position is the row's place in a created_at-ordered
            // list, so it is always 1..n with no gaps or ties.
            position: idx + 1,
            joinedAt: new Date(e.created_at),
          };
        });
        setWaitlist(mapped);
        setVisibleItems(new Set());
        staggerTimersRef.current.forEach((t) => clearTimeout(t));
        staggerTimersRef.current = mapped.map((_, i) =>
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
        );
      }
    } catch (error) {
      reportError(error, 'WaitlistManager.Failed_to_load_waitlist');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!currentUserId) return;
    setJoining(true);
    try {
      /* `position` is deliberately NOT sent. It is NOT NULL DEFAULT 1 in the
         schema and is now vestigial: order comes from created_at everywhere
         that reads this table. Sending a client-computed value here is what
         made two simultaneous joiners collide on the same number. */
      const { error } = await supabase.from('table_waitlist').insert({
        table_id: tableId,
        user_id: currentUserId,
      });

      /* ALREADY IN THIS QUEUE IS NOT A FAILURE (2026-08-31).
         The partial unique index covers both active states - 'waiting' AND,
         since the sixty-second seat hold landed, 'notified'. So a player who
         is already in line, or who is holding a live offer for this very
         table, gets 23505 here. This path had no recovery at all and reported
         the generic "Failed to join waitlist", which is the one reading that
         is definitely wrong: they did not fail to join, they are already in.
         WaitlistService's own join has handled this for months; this second
         entry point never did. */
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          showToast('You Are Already On This Waiting List', 'info');
          return;
        }
        throw error;
      }
      showToast('Added to waitlist', 'success');
    } catch (error) {
      reportError(error, 'WaitlistManager.handleJoin', { tableId });
      showToast('Failed to join waitlist', 'error');
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    if (!currentUserId) return;
    try {
      const { error } = await supabase
        .from('table_waitlist')
        .delete()
        .eq('table_id', tableId)
        .eq('user_id', currentUserId);

      if (error) throw error;

      showToast('Removed from waitlist', 'info');
    } catch (error) {
      showToast('Failed to leave waitlist', 'error');
    }
  };

  const handleSeatPlayer = async (entry: WaitlistEntry) => {
    // This would be handled by the table service
    showToast(`Seating ${entry.displayName}...`, 'info');
    // After seating, remove from waitlist
    const { error } = await supabase.from('table_waitlist').delete().eq('id', entry.id);

    if (error) {
      showToast('Failed to remove from waitlist after seating', 'error');
    }
  };

  const handleRemove = async (entry: WaitlistEntry) => {
    const { error } = await supabase.from('table_waitlist').delete().eq('id', entry.id);

    if (error) {
      showToast('Failed to remove player', 'error');
      return;
    }
    showToast(`Removed ${entry.displayName} from waitlist`, 'info');
  };

  const seatsAvailable = maxSeats - currentPlayers;

  return (
    <div className="waitlist-manager">
      <div className="waitlist-header">
        <div className="header-info">
          <h4>Table Waitlist</h4>
          <span className="table-name">{tableName}</span>
        </div>
        <div className="seat-status">
          <span className={seatsAvailable > 0 ? 'available' : 'full'}>
            {seatsAvailable > 0
              ? `${seatsAvailable} Seat${seatsAvailable > 1 ? 's' : ''} Available`
              : 'Table Full'}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="waitlist-loading">Loading...</div>
      ) : waitlist.length === 0 ? (
        <div className="waitlist-empty">No Players Waiting</div>
      ) : (
        <div className="waitlist-entries">
          {waitlist.map((entry, idx) => (
            <div
              key={entry.id}
              className="waitlist-entry"
              style={{
                opacity: visibleItems.has(idx) ? 1 : 0,
                transform: visibleItems.has(idx) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="position">#{entry.position}</span>
              <div className="entry-avatar">
                {entry.avatarUrl ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={entry.avatarUrl}
                    alt={entry.displayName}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = generateDefaultAvatar();
                    }}
                  />
                ) : (
                  <span>{(entry.displayName || '?')[0]}</span>
                )}
              </div>
              <div className="entry-info">
                <div className="entry-name">{entry.displayName}</div>
                <div className="entry-time">Waiting {formatWaitTime(entry.joinedAt)}</div>
              </div>
              {isDealer && seatsAvailable > 0 && idx === 0 && (
                <button className="seat-btn" onClick={() => handleSeatPlayer(entry)}>
                  Seat
                </button>
              )}
              {(isDealer || entry.userId === currentUserId) && (
                <button
                  className="remove-btn"
                  onClick={() =>
                    entry.userId === currentUserId ? handleLeave() : handleRemove(entry)
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!isInWaitlist && currentUserId && (
        <button
          className="join-waitlist-btn"
          onClick={handleJoin}
          disabled={joining || seatsAvailable > 0}
        >
          {seatsAvailable > 0
            ? 'Seats Available - Join Table'
            : joining
              ? 'Joining...'
              : 'Join Waitlist'}
        </button>
      )}

      {isInWaitlist && (
        <div className="my-position">
          You Are <strong>#{myPosition}</strong> In Line
          <button className="leave-btn" onClick={handleLeave}>
            Leave Waitlist
          </button>
        </div>
      )}
    </div>
  );
};

function formatWaitTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default WaitlistManager;
