/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION CENTER — In-App Notification Feed
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Centralized feed for all platform notifications:
 * - Club activity (new members, table activity)
 * - Tournament alerts (starting, registration)
 * - Settlement notifications
 * - Achievement unlocks
 * - System messages
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './NotificationCenter.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';

interface Notification {
  id: string;
  type: 'club' | 'tournament' | 'settlement' | 'achievement' | 'system' | 'friend' | 'table';
  title: string;
  message: string;
  link?: string;
  read: boolean;
  created_at: string;
  icon?: string;
}

const ICON_MAP: Record<string, string> = {
  club: '♠',
  tournament: '★',
  settlement: '◆',
  achievement: '◆',
  system: '⚙',
  friend: '◉',
  table: '◎',
};

export default function NotificationCenter() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => loadNotifications());
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [visibleNotifications, setVisibleNotifications] = useState(new Set<number>());
  const isMounted = useIsMounted();

  const loadNotifications = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, type, title, message, body:message, link, action_url, read, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) reportError(error, 'NotificationCenter.Load_failed');

      if (data && isMounted.current) {
        setNotifications(
          data.map((n) => ({
            id: n.id,
            type: n.type || 'system',
            title: n.title || 'Notification',
            message: n.message || n.body || '',
            link: n.link || n.action_url,
            read: n.read || false,
            created_at: n.created_at,
            icon: ICON_MAP[n.type] || '✉',
          }))
        );
      }
    } catch (err) {
      reportError(err, 'NotificationCenter.Failed_to_load_notifications');
      if (isMounted.current) toast.error('Failed to load notifications');
    }
    if (isMounted.current) setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    loadNotifications();

    // #1: Real-time updates via Channel Registry
    if (!user?.id) return;
    const channelKey = `notifications-${user.id}`;

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
        (payload) => {
          const n = payload.new as any;
          setNotifications((prev) => [
            {
              id: n.id,
              type: n.type || 'system',
              title: n.title || 'Notification',
              message: n.message || n.body || '',
              link: n.link || n.action_url,
              read: false,
              created_at: n.created_at,
              icon: ICON_MAP[n.type] || '✉',
            },
            ...prev,
          ]);
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
          const updated = payload.new as any;
          setNotifications((prev) =>
            prev.map((n) => (n.id === updated.id ? { ...n, read: updated.read } : n))
          );
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'NotificationCenter._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[NotificationCenter] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id, loadNotifications]);

  const markAsRead = async (notifId: string) => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notifId);
      if (error) throw error;
      setNotifications((prev) => prev.map((n) => (n.id === notifId ? { ...n, read: true } : n)));
      // #3: Emit NOTIFICATION_READ for instant bell badge sync
      masterBus.emit('NOTIFICATION_READ', { notifId, allRead: false });
    } catch (err) {
      reportError(err, 'NotificationCenter.markAsRead_error');
      toast.error('Failed to mark as read');
    }
  };

  const markAllRead = async () => {
    if (!user?.id) return;
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', user.id)
        .eq('read', false);
      if (error) throw error;
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      // #3: Emit NOTIFICATION_READ for instant bell badge sync
      masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
    } catch (err) {
      reportError(err, 'NotificationCenter.markAllRead_error');
      toast.error('Failed to mark all as read');
    }
  };

  const handleClick = (notif: Notification) => {
    if (!notif.read) markAsRead(notif.id);
    if (notif.link) navigate(notif.link);
  };

  const unreadCount = notifications.filter((n) => !n.read).length;
  const filtered =
    filter === 'all'
      ? notifications
      : filter === 'unread'
        ? notifications.filter((n) => !n.read)
        : notifications.filter((n) => n.type === filter);

  // Stagger notification rows
  useEffect(() => {
    setVisibleNotifications(new Set());
    const timers = filtered.map((_, i) =>
      setTimeout(() => setVisibleNotifications((prev) => new Set([...prev, i])), i * 40)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [filtered.length]);

  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: `Unread (${unreadCount})` },
    { id: 'club', label: 'Club' },
    { id: 'tournament', label: 'Tournaments' },
    { id: 'settlement', label: 'Settlement' },
    { id: 'achievement', label: 'Achievements' },
  ];

  return (
    <div className="notification-center">
      <div className="notif-header">
        <h1>Notifications</h1>
        {unreadCount > 0 && (
          <button className="mark-all-btn" onClick={markAllRead}>
            Mark All Read
          </button>
        )}
      </div>

      <div className="notif-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`notif-filter ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="notif-list">
        {loading ? (
          <div
            className="notif-loading"
            style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px' }}
          >
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    background: 'rgba(255,255,255,0.08)',
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }}
                />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div
                    style={{
                      width: `${60 + i * 5}%`,
                      height: 14,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.08)',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }}
                  />
                  <div
                    style={{
                      width: `${40 + i * 3}%`,
                      height: 10,
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.06)',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="notif-empty">
            <div className="notif-empty-illustration">
              <div className="notif-empty-bell-ring">
                <span className="notif-empty-bell">◉</span>
                <span className="notif-empty-sparkle notif-sparkle-1">✦</span>
                <span className="notif-empty-sparkle notif-sparkle-2">✦</span>
                <span className="notif-empty-sparkle notif-sparkle-3">✧</span>
              </div>
            </div>
            <h3 className="notif-empty-title">
              {filter === 'unread' ? "You're all caught up!" : 'No notifications yet'}
            </h3>
            <p className="notif-empty-subtitle">
              {filter === 'unread'
                ? 'Every notification has been read. Nice work keeping things tidy!'
                : 'Join a club, sit at a table, or enter a tournament — your activity feed will light up here.'}
            </p>
          </div>
        ) : (
          filtered.map((notif, index) => (
            <div
              key={notif.id}
              className={`notif-item ${!notif.read ? 'unread' : ''}`}
              onClick={() => handleClick(notif)}
              style={{
                opacity: visibleNotifications.has(index) ? 1 : 0,
                transform: visibleNotifications.has(index) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="notif-icon">{notif.icon || ICON_MAP[notif.type]}</span>
              <div className="notif-body">
                <span className="notif-title">{notif.title}</span>
                <span className="notif-message">{notif.message}</span>
                <span className="notif-time">{formatTime(notif.created_at)}</span>
              </div>
              {!notif.read && <span className="notif-dot" />}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
