/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION DROPDOWN — Alert Center
 * Shows recent notifications with actions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusChannel } from '../../hooks/useMasterBusChannel';
import { useAuthUser } from '../../hooks/useAuthUser';
import { formatRelativeShort as formatTime } from '@/lib/date';
import styles from './NotificationDropdown.module.css';
import { leaveForHub } from '../../lib/openExternal';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  isRead: boolean;
  createdAt: string;
  /**
   * Destination, already resolved by /api/notifications/feed using the one
   * canonical resolver (World Hub src/lib/notificationRoute.js). Null means
   * there is genuinely nowhere to go, and the row must not pretend otherwise.
   */
  link?: string | null;
}

interface NotificationDropdownProps {
  onNavigate?: (path: string) => void;
}

export default function NotificationDropdown({ onNavigate }: NotificationDropdownProps) {
  const { user } = useAuthUser();
  const [isOpen, setIsOpen] = useState(false);
  const isMounted = useIsMounted();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user?.id) {
      loadNotifications();
    }
  }, [user?.id]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadNotifications = async () => {
    setLoading(true);

    /**
     * Read through /api/notifications/feed, not straight from Supabase.
     *
     * This dropdown used to query the table itself and then re-derive a
     * destination from the `data` column, while the notifications page next
     * to it derived one from `metadata` — two components, one table, two
     * disagreeing answers, and most rows dead in both. The feed API now
     * resolves the destination once, server-side, and also joins the actor
     * profile that friend_* notifications need in order to route at all.
     * Consuming it here means this component holds no routing rules.
     */
    let mapped: Notification[] | null = null;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (token) {
        const res = await fetch('/api/notifications/feed?limit=20', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          if (json?.success && Array.isArray(json.notifications)) {
            mapped = json.notifications.map((n: any) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              message: n.message,
              data: n.data,
              isRead: !!(n.read || n.is_read),
              createdAt: n.created_at,
              link: n.link || null,
            }));
          }
        }
      }
    } catch (_) {
      // Fall through to the direct query below.
    }

    // Fallback: the API is unreachable (offline, cold start, auth blip).
    // Show the list rather than an empty dropdown; rows still carry
    // action_url so the common cases stay clickable.
    if (!mapped) {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, type, title, message, data, read, created_at, action_url, link')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (!error && data) {
        mapped = data.map((n: any) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          data: n.data,
          isRead: n.read,
          createdAt: n.created_at,
          link: n.link || n.action_url || null,
        }));
      }
    }

    if (mapped) {
      setNotifications(mapped);
      setUnreadCount(mapped.filter((n) => !n.isRead).length);
      setVisibleItems(new Set());
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = mapped.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    }
    if (isMounted.current) setLoading(false);
  };

  // Real-time subscription for new notifications
  useMasterBusChannel({
    channelName: user?.id ? `notifications:${user.id}` : null,
    table: 'notifications',
    filter: user?.id ? `user_id=eq.${user.id}` : null,
    event: 'INSERT',
    onPayload: (payload) => {
      const n = payload.new as any;
      setNotifications((prev) =>
        [
          {
            id: n.id,
            type: n.type,
            title: n.title,
            message: n.message,
            data: n.data,
            isRead: false,
            createdAt: n.created_at,
          },
          ...prev,
        ].slice(0, 20)
      );
      setUnreadCount((prev) => prev + 1);
    },
    enabled: !!user?.id,
  });

  const markAsRead = async (id: string) => {
    const { error } = await supabase.from('notifications').update({ read: true }).eq('id', id);

    if (error) return;

    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    // BUG-07 FIX: Emit NOTIFICATION_READ so header badge decrements instantly
    masterBus.emit('NOTIFICATION_READ', { notifId: id, allRead: false });
  };

  const markAllAsRead = async () => {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user?.id)
      .eq('read', false);

    if (error) return;

    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    // BUG-07 FIX: Emit NOTIFICATION_READ so header badge zeros instantly
    masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
  };

  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);

    // `link` was resolved server-side by the one canonical resolver. This
    // component deliberately holds no routing rules of its own — that
    // duplication is exactly what made notification taps silently fail.
    const url =
      notification.link || notification.data?.action_url || notification.data?.path || null;

    if (url) {
      // Club Arena paths route in-SPA; anything else is a real navigation
      // out of the SPA and onNavigate (react-router) cannot serve it.
      if (url.startsWith('/hub/club-arena')) {
        const inner = url.slice('/hub/club-arena'.length) || '/';
        if (onNavigate) onNavigate(inner);
        else leaveForHub(url);
      } else if (url.startsWith('/')) {
        leaveForHub(url);
      } else if (onNavigate) {
        onNavigate(url);
      }
    }
    setIsOpen(false);
  };

  const getIcon = (type: string): string => {
    switch (type) {
      case 'achievement':
        return '★';
      case 'friend_request':
        return '●';
      case 'message':
        return '◈';
      case 'tournament':
        return 'T';
      case 'table_invite':
        return '♠';
      case 'payment':
        return '◉';
      case 'club':
        return '♛';
      default:
        return '○';
    }
  };

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button className={styles.trigger} onClick={() => setIsOpen(!isOpen)}>
        {unreadCount > 0 && <span className={styles.badge}>{unreadCount}</span>}
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.header}>
            <h4>Notifications</h4>
            {unreadCount > 0 && <button onClick={markAllAsRead}>Mark All Read</button>}
          </div>

          <div className={styles.list}>
            {loading ? (
              <div className={styles.loading}>Loading...</div>
            ) : notifications.length === 0 ? (
              <div className={styles.empty}>No Notifications</div>
            ) : (
              notifications.map((n, i) => (
                <div
                  key={n.id}
                  className={`${styles.item} ${!n.isRead ? styles.unread : ''}`}
                  onClick={() => handleNotificationClick(n)}
                  style={{
                    opacity: visibleItems.has(i) ? 1 : 0,
                    transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className={styles.icon}>{getIcon(n.type)}</span>
                  <div className={styles.content}>
                    <span className={styles.title}>{n.title}</span>
                    <span className={styles.message}>{n.message}</span>
                  </div>
                  <div className={styles.meta}>
                    <span className={styles.time}>{formatTime(n.createdAt)}</span>
                    {!n.isRead && (
                      <button
                        className={styles.markReadBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          markAsRead(n.id);
                        }}
                        title="Mark As Read"
                      >
                        ●
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
