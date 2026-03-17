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

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
  isRead: boolean;
  createdAt: string;
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
    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, message, data, is_read, created_at')
      .eq('user_id', user?.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (!error && data) {
      const mapped = data.map((n: any) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        data: n.data,
        isRead: n.is_read,
        createdAt: n.created_at,
      }));
      setNotifications(mapped);
      setUnreadCount(mapped.filter((n) => !n.isRead).length);
      setVisibleItems(new Set());
      mapped.forEach((_, i) => {
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
      });
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
    const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id);

    if (error) return;

    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
  };

  const markAllAsRead = async () => {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user?.id)
      .eq('is_read', false);

    if (error) return;

    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  };

  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);

    // Navigate based on notification type
    if (notification.data?.path && onNavigate) {
      onNavigate(notification.data.path);
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
            {unreadCount > 0 && <button onClick={markAllAsRead}>Mark all read</button>}
          </div>

          <div className={styles.list}>
            {loading ? (
              <div className={styles.loading}>Loading...</div>
            ) : notifications.length === 0 ? (
              <div className={styles.empty}>No notifications</div>
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
                  <span className={styles.time}>{formatTime(n.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
