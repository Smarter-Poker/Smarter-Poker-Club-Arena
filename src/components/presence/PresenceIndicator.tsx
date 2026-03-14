import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './PresenceIndicator.css';

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
    const channelKey = `presence:${userId}-${Math.random().toString(36).substring(7)}`;

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
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [userId]);

  const fetchPresence = async () => {
    try {
      const { data, error: presenceErr } = await supabase
        .from('player_presence')
        .select('status, last_seen_at, current_table_id')
        .eq('user_id', userId)
        .maybeSingle();
      if (presenceErr) console.error('[PresenceIndicator] Fetch failed:', presenceErr.message);

      if (data) {
        setPresence({
          status: data.status || 'offline',
          lastSeen: data.last_seen_at ? new Date(data.last_seen_at) : null,
          currentTable: data.current_table_id,
        });
      }
    } catch (error) {
      // User not in presence table = offline
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
