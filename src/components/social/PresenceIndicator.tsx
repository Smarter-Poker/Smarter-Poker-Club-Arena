/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRESENCE INDICATOR — Online/Offline Status Display
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows user's real-time presence status with optional pulse animation
 */

import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import styles from './PresenceIndicator.module.css';
import { reportError } from '../../utils/errorReporter';

interface PresenceIndicatorProps {
  userId: string;
  size?: 'small' | 'medium' | 'large';
  showLabel?: boolean;
  className?: string;
}

type PresenceStatus = 'online' | 'away' | 'offline';

export default function PresenceIndicator({
  userId,
  size = 'medium',
  showLabel = false,
  className = '',
}: PresenceIndicatorProps) {
  const [status, setStatus] = useState<PresenceStatus>('offline');
  const [lastSeen, setLastSeen] = useState<Date | null>(null);

  useEffect(() => {
    if (!userId) return;

    let isMounted = true;

    // Fetch initial presence
    const fetchPresence = async () => {
      /* AUDIT 2026-08-20 — this read `user_presence`, and there is no such
         table in the database. It has never returned a row.

         Worse than the missing table was the shape of the failure. The
         Supabase client RETURNS `{ data, error }`; it does not throw. So
         `if (!error && data)` simply fell through, the catch below never ran,
         and the profiles fallback sitting inside it was unreachable code. The
         dot has read "offline" for every player since the day it was written,
         and the fallback written precisely to prevent that could not fire.

         profiles.is_online and profiles.last_seen are real columns and are the
         only presence data that exists, so they are now the primary read
         rather than a fallback nobody could reach. */
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_online, last_seen')
          .eq('id', userId)
          .maybeSingle();

        if (profile && isMounted) {
          setStatus(profile.is_online ? 'online' : 'offline');
          if (profile.last_seen) {
            setLastSeen(new Date(profile.last_seen));
          }
        }
      } catch (e) {
        /* The old fallback lived here and duplicated the query above, from
           back when this catch was expected to fire. It cannot: the client
           returns errors rather than throwing. Nothing is retried — a player
           whose presence cannot be read is shown as offline, which is the
           honest default. */
        reportError(e, 'PresenceIndicator.fetchPresence');
      }
    };

    fetchPresence();

    // Subscribe to realtime changes with a unique key per component instance
    // This prevents one unmounting component from killing the channel for other components showing the same user
    const channelKey = `social-presence:${userId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          /* Same missing table, same silence: a subscription to a table that
             does not exist never delivers a row, so the dot never updated
             after its first read either. profiles is where is_online lives. */
          table: 'profiles',
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          if (payload.new && isMounted) {
            const newData = payload.new as { is_online?: boolean; last_seen?: string };
            setStatus(newData.is_online ? 'online' : 'offline');
            if (newData.last_seen) {
              setLastSeen(new Date(newData.last_seen));
            }
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'PresenceIndicator._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[PresenceIndicator] Realtime channel timed out');
        }
      });

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [userId]);

  const getStatusLabel = (): string => {
    if (status === 'online') return 'Online';
    if (status === 'away') return 'Away';
    if (lastSeen) {
      const diffMs = Date.now() - lastSeen.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      return 'Offline';
    }
    return 'Offline';
  };

  return (
    <div className={`${styles.container} ${styles[size]} ${className}`}>
      <span className={`${styles.dot} ${styles[status]}`} />
      {showLabel && <span className={styles.label}>{getStatusLabel()}</span>}
    </div>
  );
}

// Utility function for external use
export function usePresence(userId: string): PresenceStatus {
  const [status, setStatus] = useState<PresenceStatus>('offline');

  useEffect(() => {
    if (!userId) return;

    const fetchPresence = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_online')
        .eq('id', userId)
        .maybeSingle();
      if (error) reportError(error, 'PresenceIndicator.Fetch_failed');

      if (data) {
        setStatus(data.is_online ? 'online' : 'offline');
      }
    };

    fetchPresence();
  }, [userId]);

  return status;
}
