/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WAITLIST MANAGER — Table Waitlist
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './WaitlistManager.css';

interface WaitlistManagerProps {
  tableId: string;
  isAdmin?: boolean;
  onSeatPlayer?: (userId: string) => void;
}

interface WaitlistEntry {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string;
  position: number;
  joinedAt: Date;
  preferredSeat?: number;
}

export function WaitlistManager({ tableId, isAdmin, onSeatPlayer }: WaitlistManagerProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const isMounted = useIsMounted();
  const [loading, setLoading] = useState(true);
  const [myPosition, setMyPosition] = useState<number | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadWaitlist();

    const channelKey = `waitlist-${tableId}`;

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
        () => loadWaitlist()
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [tableId]);

  const loadWaitlist = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('table_waitlists')
        .select('*, player:profiles!user_id(username, avatar_url)')
        .eq('table_id', tableId)
        .order('position', { ascending: true });

      if (!error && data) {
        const list = data.map((w, idx) => {
          const player = Array.isArray(w.player) ? w.player[0] : w.player;
          return {
            id: w.id,
            userId: w.user_id,
            username: player?.username || 'Unknown',
            avatarUrl: player?.avatar_url || '',
            position: idx + 1,
            joinedAt: new Date(w.created_at),
            preferredSeat: w.preferred_seat,
          };
        });
        setWaitlist(list);
        setVisibleItems(new Set());
        list.forEach((_, i) => {
          setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        });

        const myEntry = list.find((w) => w.userId === user?.id);
        setMyPosition(myEntry?.position || null);
      }
    } catch (error) {
      toast.error('Failed to load waitlist');
    }
    setLoading(false);
  };

  const joinWaitlist = async () => {
    if (!user?.id) return;

    try {
      const { error } = await supabase.from('table_waitlists').insert({
        table_id: tableId,
        user_id: user.id,
        position: waitlist.length + 1,
      });

      if (error) throw error;
      toast.success('Joined waitlist!');
      loadWaitlist();
    } catch (error) {
      toast.error('Failed to join waitlist');
    }
  };

  const leaveWaitlist = async () => {
    if (!user?.id) return;

    try {
      const { error } = await supabase
        .from('table_waitlists')
        .delete()
        .eq('table_id', tableId)
        .eq('user_id', user.id);

      if (error) throw error;

      toast.success('Left waitlist');
      loadWaitlist();
    } catch (error) {
      toast.error('Failed to leave waitlist');
    }
  };

  const seatPlayer = async (entry: WaitlistEntry) => {
    if (!isAdmin) return;

    try {
      const { error } = await supabase.from('table_waitlists').delete().eq('id', entry.id);

      if (error) throw error;

      onSeatPlayer?.(entry.userId);
      toast.success(`${entry.username} seated`);
      loadWaitlist();
    } catch (error) {
      toast.error('Failed to seat player');
    }
  };

  if (loading) {
    return <div className="waitlist loading">Loading...</div>;
  }

  return (
    <div className="waitlist">
      <div className="waitlist__header">
        <h3> Waitlist ({waitlist.length})</h3>
        {myPosition !== null ? (
          <button className="leave-btn" onClick={leaveWaitlist}>
            Leave (#{myPosition})
          </button>
        ) : (
          <button className="join-btn" onClick={joinWaitlist}>
            Join
          </button>
        )}
      </div>

      {waitlist.length === 0 ? (
        <div className="empty-state">No one waiting</div>
      ) : (
        <div className="waitlist__list">
          {waitlist.map((entry, i) => (
            <div
              key={entry.id}
              className={`waitlist-row ${entry.userId === user?.id ? 'me' : ''}`}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="position">#{entry.position}</span>
              <span className="avatar">{entry.avatarUrl}</span>
              <span className="username">
                {entry.username}
                {entry.preferredSeat && <span className="pref">Seat {entry.preferredSeat}</span>}
              </span>
              {isAdmin && (
                <button className="seat-btn" onClick={() => seatPlayer(entry)}>
                  Seat
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WaitlistManager;
