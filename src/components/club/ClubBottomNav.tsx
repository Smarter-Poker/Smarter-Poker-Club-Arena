/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Club Bottom Navigation Bar
 * PokerBros-style fixed bottom navigation for club management
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './ClubBottomNav.module.css';
import { reportError } from '../../utils/errorReporter';

interface ClubBottomNavProps {
  clubId: string;
  userRole?: 'owner' | 'admin' | 'agent' | 'member';
  clubName?: string;
}

export default function ClubBottomNav({
  clubId,
  userRole = 'member',
  clubName,
}: ClubBottomNavProps) {
  const location = useLocation();
  const { user } = useAuthUser();
  const [unreadCount, setUnreadCount] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    const items = ['messages', 'players', 'cashier', 'data', 'admin'];
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = items.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, []);

  // ── Live unread notification badge ──
  useEffect(() => {
    if (!user?.id) return;

    // Initial count
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false)
      .then(({ count, error }) => {
        if (error) {
          console.warn('[ClubBottomNav] Unread count query error:', error.message);
          return;
        }
        setUnreadCount(count || 0);
      });

    // Subscribe to new notifications
    const channelKey = `nav-notif-badge-${user.id}`;

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
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          // If marked as read, decrement
          const newRow = payload.new as Record<string, unknown>;
          const oldRow = payload.old as Record<string, unknown>;
          if (newRow.read === true && oldRow.read === false) {
            setUnreadCount((prev) => Math.max(0, prev - 1));
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          reportError(err?.message || err, 'ClubBottomNav._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[ClubBottomNav] ⏱️ Realtime channel timed out');
        }
      });

    // BUG-08/09 FIX: Listen to NOTIFICATION_COUNT_CHANGED for instant badge sync.
    // DO NOT also subscribe to NOTIFICATION_READ — the store already transforms
    // NOTIFICATION_READ into NOTIFICATION_COUNT_CHANGED with the absolute count.
    // Subscribing to both causes a double-decrement bug.
    const unsubCountChanged = masterBus.subscribe('NOTIFICATION_COUNT_CHANGED', (event) => {
      if (event.payload?.count !== undefined && typeof event.payload.count === 'number') {
        setUnreadCount(event.payload.count);
      }
    });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubCountChanged();
    };
  }, [user?.id]);

  // Check if user has elevated permissions (can see Players/Admin tabs)
  const hasAdminAccess = userRole === 'owner' || userRole === 'admin' || userRole === 'agent';

  // Determine active tab from URL
  const getActiveTab = () => {
    const path = location.pathname;
    if (path.includes('/messages')) return 'messages';
    if (path.includes('/players') || path.includes('/members')) return 'players';
    if (path.includes('/cashier')) return 'cashier';
    if (path.includes('/dashboard') || path.includes('/data')) return 'data';
    if (path.includes('/settings') || path.includes('/admin')) return 'admin';
    return 'messages'; // default
  };

  const activeTab = getActiveTab();

  return (
    <nav className={styles.bottomNav}>
      {/* Navigation icons */}
      <div className={styles.navItems}>
        {/* Messages */}
        <Link
          to={`/clubs/${clubId}/messages`}
          className={`${styles.navItem} ${activeTab === 'messages' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(0) ? 1 : 0,
            transform: visibleItems.has(0) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 15.17L18.83 16H4V4h16v13.17zM7 9h10v2H7zm0-3h10v2H7zm0 6h7v2H7z" />
          </svg>
          {unreadCount > 0 && (
            <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
          )}
          <span className={styles.label}>Msgs</span>
        </Link>

        {/* Players - Always visible */}
        <Link
          to={`/clubs/${clubId}/members`}
          className={`${styles.navItem} ${activeTab === 'players' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(1) ? 1 : 0,
            transform: visibleItems.has(1) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
          </svg>
          <span className={styles.label}>Players</span>
        </Link>

        {/* Cashier */}
        <Link
          to={`/clubs/${clubId}/cashier`}
          className={`${styles.navItem} ${activeTab === 'cashier' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(2) ? 1 : 0,
            transform: visibleItems.has(2) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zm-2 0H3V6h14v8zm-7-7c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3zm13 0v11c0 1.1-.9 2-2 2H4v-2h17V7h2z" />
          </svg>
          <span className={styles.label}>Cashier</span>
        </Link>

        {/* Data/Dashboard */}
        <Link
          to={`/clubs/${clubId}/dashboard`}
          className={`${styles.navItem} ${activeTab === 'data' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(3) ? 1 : 0,
            transform: visibleItems.has(3) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
          </svg>
          <span className={styles.label}>Data</span>
        </Link>

        {/* Admin - Always visible */}
        <Link
          to={`/clubs/${clubId}/settings`}
          className={`${styles.navItem} ${activeTab === 'admin' ? styles.active : ''}`}
          style={{
            opacity: visibleItems.has(4) ? 1 : 0,
            transform: visibleItems.has(4) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <svg className={styles.icon} viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
          </svg>
          <span className={styles.label}>Admin</span>
        </Link>
      </div>
    </nav>
  );
}
