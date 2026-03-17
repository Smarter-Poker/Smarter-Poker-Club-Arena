/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION BELL — Header Badge with Unread Count (v3.0 — Phase 28)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Displays a bell icon with unread count badge. Tapping navigates to /notifications.
 *
 * v3.0: Added window focus refetch — when user returns from another tab or device,
 *       the badge count refreshes to catch notifications marked read elsewhere.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { masterBus } from '../../core/MasterBus';

export default function NotificationBell() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const [unreadCount, setUnreadCount] = useState(0);

  // Memoized fetch function for reuse on mount AND window focus
  const fetchCount = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('read', false);
      setUnreadCount(count || 0);
    } catch (err) {
      console.error('[NotificationBell] count fetch error:', err);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;

    // Initial fetch
    fetchCount();

    // Real-time: ONLY listen for new INSERTs (new notifications arriving)
    const channelKey = `notif-bell-${user.id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          setUnreadCount((prev) => prev + 1);
        }
      )
      .subscribe();

    // #6: Refetch on window focus — catches reads on other tabs/devices
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchCount();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user?.id, fetchCount]);

  // masterBus subscriber for NOTIFICATION_READ (sole source of mark-read sync)
  useMasterBusSubscription('NOTIFICATION_READ', (payload) => {
    if (payload?.allRead) {
      setUnreadCount(0);
    } else {
      setUnreadCount((prev) => Math.max(0, prev - 1));
    }
  });

  return (
    <button
      onClick={() => navigate('/notifications')}
      style={{
        position: 'relative',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 6,
        fontSize: '1.2rem',
      }}
      title="Notifications"
    >
      🔔
      {unreadCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: '#ef4444',
            color: '#fff',
            fontSize: '0.55rem',
            fontWeight: 800,
            borderRadius: '50%',
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
          }}
        >
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </button>
  );
}
