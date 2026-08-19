import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './PresenceIndicator.css';
import { reportError } from '../../utils/errorReporter';

interface PresenceState {
  status: 'online' | 'away' | 'playing' | 'offline';
  lastSeen: Date | null;
  currentTable?: string;
}

interface PresenceIndicatorProps {
  userId: string;
  showLabel?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export const PresenceIndicator: React.FC<PresenceIndicatorProps> = ({
  userId,
  showLabel = false,
  size = 'medium',
}) => {
  const [presence, setPresence] = useState<PresenceState>({
    status: 'offline',
    lastSeen: null,
  });

  useEffect(() => {
    // Initial fetch
    fetchPresence();

    // Subscribe to presence changes with a unique channel key
    const channelKey = `presence-indicator:${userId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const rawState = state[userId]?.[0];
        if (rawState && typeof rawState === 'object' && 'status' in rawState) {
          const userState = rawState as unknown as PresenceState;
          setPresence(userState);
        }
      })
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'PresenceIndicator._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[PresenceIndicator] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [userId]);

  const fetchPresence = async () => {
    try {
      // NOTE: player_presence table does not exist yet (future feature).
      // Fall back to profiles.is_online + profiles.last_seen for basic presence.
      const { data, error: presenceErr } = await supabase
        .from('profiles')
        .select('is_online, last_seen')
        .eq('id', userId)
        .maybeSingle();
      if (presenceErr) {
        console.warn('[PresenceIndicator] Fetch failed:', presenceErr.message);
        return;
      }

      if (data) {
        setPresence({
          status: data.is_online ? 'online' : 'offline',
          lastSeen: data.last_seen ? new Date(data.last_seen) : null,
        });
      }
    } catch (error) {
      // Fallback: treat as offline
      setPresence({ status: 'offline', lastSeen: null });
    }
  };

  const getStatusLabel = () => {
    switch (presence.status) {
      case 'online':
        return 'Online';
      case 'away':
        return 'Away';
      case 'playing':
        return presence.currentTable ? 'In Game' : 'Playing';
      default:
        return presence.lastSeen ? formatLastSeen(presence.lastSeen) : 'Offline';
    }
  };

  const formatLastSeen = (date: Date) => {
    const diff = Date.now() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className={`presence-indicator size-${size}`}>
      <span className={`presence-dot status-${presence.status}`} />
      {showLabel && <span className="presence-label">{getStatusLabel()}</span>}
    </div>
  );
};

export default PresenceIndicator;
