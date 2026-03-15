import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useNavigate } from 'react-router-dom';
import NotificationGrouper, { type NotificationCategory } from './NotificationGrouper';
import './NotificationCenter.css';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  actionUrl?: string;
  isRead: boolean;
  createdAt: Date;
}

interface NotificationCenterProps {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  userId,
  isOpen,
  onClose,
}) => {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const animationTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      animationTimers.current.forEach(clearTimeout);
      animationTimers.current = [];
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadNotifications();
    }
  }, [isOpen, userId]);

  useEffect(() => {
    // Real-time subscription
    const channelKey = `notifications:${userId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newNotif = mapNotification(payload.new);
          setNotifications((prev) => [newNotif, ...prev]);
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [userId]);

  const loadNotifications = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('notifications')
        .select('id, user_id, type, title, body, read, data, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (data && isMounted.current) {
        const mapped = data.map(mapNotification);
        setNotifications(mapped);
        setVisibleItems(new Set());
        animationTimers.current.forEach(clearTimeout);
        animationTimers.current = [];
        mapped.forEach((_, i) => {
          const t = setTimeout(() => {
            if (isMounted.current) setVisibleItems((prev) => new Set(prev).add(i));
          }, i * 60);
          animationTimers.current.push(t);
        });
      }
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const mapNotification = (n: any): Notification => ({
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    actionUrl: n.action_url,
    isRead: n.read,
    createdAt: new Date(n.created_at),
  });

  const handleNotificationClick = async (notif: Notification) => {
    // Mark as read
    if (!notif.isRead) {
      try {
        const { error } = await supabase
          .from('notifications')
          .update({ read: true })
          .eq('id', notif.id);
        if (!error) {
          setNotifications((prev) =>
            prev.map((n) => (n.id === notif.id ? { ...n, isRead: true } : n))
          );
          masterBus.emit('NOTIFICATION_READ', { notifId: notif.id, allRead: false });
        }
      } catch (err) {
        console.error('[NotificationCenter] mark-read error:', err);
      }
    }

    // Navigate if action URL
    if (notif.actionUrl) {
      navigate(notif.actionUrl);
      onClose();
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', userId)
        .eq('read', false);

      if (!error) {
        setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
        masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
      }
    } catch (err) {
      console.error('[NotificationCenter] mark-all-read error:', err);
    }
  };

  const handleClearAll = async () => {
    try {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('user_id', userId)
        .eq('read', true);

      if (!error) {
        setNotifications((prev) => prev.filter((n) => !n.isRead));
      }
    } catch (err) {
      console.error('[NotificationCenter] clear-all error:', err);
    }
  };

  const getTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      club_invite: '',
      agent_invite: '👔',
      message: '',
      table_ready: '',
      tournament_start: '',
      settlement: '',
      achievement: '',
      bonus: '',
      friend_request: '',
      system: '',
    };
    return icons[type] || '';
  };

  const formatTime = (date: Date) => {
    const diff = Date.now() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="notification-backdrop" onClick={onClose} />
      <div className="notification-center">
        <div className="notification-header">
          <h3>Notifications</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="notification-actions">
          <button onClick={handleMarkAllRead}>Mark all read</button>
          <button onClick={handleClearAll}>Clear read</button>
        </div>

        <div className="notification-list-wrapper" style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div className="notification-loading">Loading...</div>
          ) : (
            <NotificationGrouper
              notifications={notifications.map((n) => {
                let cat: NotificationCategory = 'system';
                const cStr = (n.title + ' ' + n.message).toLowerCase();
                if (/table|hand|game|seat|tournament|tourney|mtt|sng|waitlist|blind/.test(cStr))
                  cat = 'games';
                else if (/friend|message|chat|club|invite|joined|member/.test(cStr)) cat = 'social';
                else if (/achievement|badge|unlock|level|xp|streak|bonus|reward|diamond/.test(cStr))
                  cat = 'achievements';

                return {
                  id: n.id,
                  category: cat,
                  title: n.title,
                  body: n.message,
                  timestamp: n.createdAt.toISOString(),
                  read: n.isRead,
                  icon: getTypeIcon(n.type),
                };
              })}
              onRead={(id) => {
                const notif = notifications.find((n) => n.id === id);
                if (notif) handleNotificationClick(notif);
              }}
            />
          )}
        </div>
      </div>
    </>
  );
};

export default NotificationCenter;
