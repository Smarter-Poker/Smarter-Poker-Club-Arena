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
      try {
        const { data, error } = await supabase
          .from('user_presence')
          .select('status, last_seen')
          .eq('user_id', userId)
          .maybeSingle();

        if (!error && data && isMounted) {
          setStatus(data.status as PresenceStatus);
          if (data.last_seen) {
            setLastSeen(new Date(data.last_seen));
          }
        }
      } catch (e) {
        // Fallback: check profiles table
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('is_online, last_active')
            .eq('id', userId)
            .maybeSingle();

          if (profile && isMounted) {
            setStatus(profile.is_online ? 'online' : 'offline');
            if (profile.last_active) {
              setLastSeen(new Date(profile.last_active));
            }
          }
        } catch (err) {

          console.error("[PresenceIndicator] Error:", err);
          // no-op
        }
      }
    };

    fetchPresence();

    // Subscribe to realtime changes with a unique key per component instance
    // This prevents one unmounting component from killing the channel for other components showing the same user
    const channelKey = `presence:${userId}-${Math.random().toString(36).substring(7)}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_presence',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.new && isMounted) {
            const newData = payload.new as { status: string; last_seen: string };
            setStatus(newData.status as PresenceStatus);
            if (newData.last_seen) {
              setLastSeen(new Date(newData.last_seen));
            }
          }
        }
      )
      .subscribe();

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
      if (error) console.error('[PresenceIndicator] Fetch failed:', error.message);

      if (data) {
        setStatus(data.is_online ? 'online' : 'offline');
      }
    };

    fetchPresence();
  }, [userId]);

  return status;
}
