import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './WaitlistManager.css';

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
          table: 'table_waitlists',
          filter: `table_id=eq.${tableId}`,
        },
        () => {
          loadWaitlist();
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [tableId]);

  const loadWaitlist = async () => {
    try {
      const { data, error } = await supabase
        .from('table_waitlists')
        .select('id, user_id, position, created_at')
        .eq('table_id', tableId)
        .order('position', { ascending: true });
      if (error) console.error('[WaitlistManager] Load failed:', error.message);

      if (data && data.length > 0) {
        // Fetch profiles separately
        const userIds = data.map((e: any) => e.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .in('id', userIds);

        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

        const mapped = data.map((e: any) => {
          const profile = profileMap.get(e.user_id);
          return {
            id: e.id,
            userId: e.user_id,
            username: profile?.username || 'Unknown',
            displayName: profile?.full_name || profile?.username || 'Unknown',
            avatarUrl: profile?.avatar_url,
            position: e.position,
            joinedAt: new Date(e.created_at),
          };
        });
        setWaitlist(mapped);
        setVisibleItems(new Set());
        mapped.forEach((_, i) => {
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        });
      }
    } catch (error) {
      console.error('Failed to load waitlist:', error);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!currentUserId) return;
    setJoining(true);
    try {
      const { error } = await supabase.from('table_waitlists').insert({
        table_id: tableId,
        user_id: currentUserId,
        position: waitlist.length + 1,
      });

      if (error) throw error;
      showToast('Added to waitlist', 'success');
    } catch (error) {
      showToast('Failed to join waitlist', 'error');
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    if (!currentUserId) return;
    try {
      const { error } = await supabase
        .from('table_waitlists')
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
    const { error } = await supabase.from('table_waitlists').delete().eq('id', entry.id);

    if (error) {
      showToast('Failed to remove from waitlist after seating', 'error');
    }
  };

  const handleRemove = async (entry: WaitlistEntry) => {
    const { error } = await supabase.from('table_waitlists').delete().eq('id', entry.id);

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
              ? `${seatsAvailable} seat${seatsAvailable > 1 ? 's' : ''} available`
              : 'Table Full'}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="waitlist-loading">Loading...</div>
      ) : waitlist.length === 0 ? (
        <div className="waitlist-empty">No players waiting</div>
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
                  <img src={entry.avatarUrl} alt={entry.displayName} />
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
          You are <strong>#{myPosition}</strong> in line
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
