/**
 *  NOTIFICATIONS PAGE — With Real-Time Updates
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { PremiumSFX } from '../services/PremiumSFX';
import { haptic } from '../services/HapticService';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useSwipeAction } from '../hooks/useSwipeAction';
import { notificationService } from '../services/NotificationService';
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import NotificationSettingsPanel from '../components/social/NotificationSettingsPanel';
import { timeAgo } from '../utils/format';
import './NotificationsPage.css';
import { reportError } from '../utils/errorReporter';

type NotifCategory = 'all' | 'games' | 'social' | 'achievements' | 'system';

const NOTIF_CATEGORIES: { id: NotifCategory; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '📋' },
  { id: 'games', label: 'Games', icon: '🎰' },
  { id: 'social', label: 'Social', icon: '👥' },
  { id: 'achievements', label: 'Achievements', icon: '🏆' },
  { id: 'system', label: 'System', icon: '⚙️' },
];

function categorizeNotification(notif: Notification): NotifCategory {
  const title = (notif.title || '').toLowerCase();
  const msg = (notif.message || '').toLowerCase();
  const combined = title + ' ' + msg;

  if (/table|hand|game|seat|tournament|tourney|mtt|sng|waitlist|blind/.test(combined))
    return 'games';
  if (/friend|message|chat|club|invite|joined|member/.test(combined)) return 'social';
  if (/achievement|badge|unlock|level|streak|bonus|reward|diamond/.test(combined))
    return 'achievements';
  return 'system';
}

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  read: boolean;
  created_at: string;
  action_url?: string;
}

// ── SWR Cache helpers ──
const NOTIF_CACHE_PREFIX = 'notif_cache_';
function getCachedNotifs(userId: string) {
  try {
    const raw = sessionStorage.getItem(NOTIF_CACHE_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedNotifs(userId: string, data: any) {
  try {
    sessionStorage.setItem(NOTIF_CACHE_PREFIX + userId, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

export default function NotificationsPage() {
  useEffect(() => {
    document.title = 'Notifications | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();
  const hasDataRef = useRef(false);
  useVisibilityRefresh(() => loadNotifications());
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNotifId, setNewNotifId] = useState<string | null>(null);
  const [visibleNotifications, setVisibleNotifications] = useState(new Set<number>());
  const [activeCategory, setActiveCategory] = useState<NotifCategory>('all');
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Q3: DND state
  const [dndActive, setDndActive] = useState(() => notificationService.isDndActive());
  const [showDndPicker, setShowDndPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // SWR: show cached notifications instantly on mount
  useEffect(() => {
    if (!user?.id) return;
    const cached = getCachedNotifs(user.id);
    if (cached && cached.length > 0) {
      setNotifications(cached);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [user?.id]);

  // Safety timeout: if auth or data takes too long, stop showing skeletons
  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoading(false);
    }, 5000);
    return () => clearTimeout(timeout);
  }, []);

  const handleDndToggle = useCallback(
    (minutes: number) => {
      notificationService.setDnd(minutes);
      setDndActive(true);
      setShowDndPicker(false);
      toast.success(`🌙 Do Not Disturb for ${minutes}m`);
    },
    [toast]
  );

  const handleDndClear = useCallback(() => {
    notificationService.clearDnd();
    setDndActive(false);
    toast.success('Notifications resumed');
  }, [toast]);

  useEffect(() => {
    let isMounted = true;
    if (user?.id) {
      loadNotifications(() => isMounted);

      // Subscribe to real-time notifications
      const channelKey = 'user-notifications';

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
            if (!isMounted) return;
            const newNotif = payload.new as Notification;
            setNotifications((prev) => [newNotif, ...prev]);

            // Highlight new notification
            setNewNotifId(newNotif.id);
            if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
            highlightTimerRef.current = setTimeout(() => setNewNotifId(null), 3000);

            // Play notification sound via PremiumSFX
            try {
              PremiumSFX.notification();
            } catch (e) {
              /* silent */
            }
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            reportError(err?.message || err, 'NotificationsPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[NotificationsPage] ⏱️ Realtime channel timed out');
          }
        });

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      };
    }
  }, [user?.id]);

  // ── Bus Listeners: cross-page notification reactivity (debounced) ──
  useEffect(() => {
    let isMounted = true;
    const unsubs = [
      masterBus.subscribeDebounced(
        'NOTIFICATION_RECEIVED',
        () => {
          if (isMounted) loadNotifications(() => isMounted);
        },
        500
      ),
      masterBus.subscribeDebounced(
        'NOTIFICATION_COUNT_CHANGED',
        () => {
          if (isMounted) loadNotifications(() => isMounted);
        },
        500
      ),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadingRef = useRef(false);

  const loadNotifications = async (getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!hasDataRef.current) setLoading(true);
    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .from('notifications')
            .select('id, type, title, message, read, created_at, action_url')
            .eq('user_id', user?.id)
            .order('created_at', { ascending: false })
            .limit(50)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (getIsMounted && !getIsMounted()) return;
      if (!isMounted.current) return;

      if (!error && data) {
        setNotifications(data);
        hasDataRef.current = data.length > 0;
        setCachedNotifs(user?.id || '', data);
      }
    } catch (error) {
      reportError(error, 'NotificationsPage.Failed_to_load_notifications');
      if (isMounted.current) toast.error('Failed to load notifications');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) {
        if (isMounted.current) setLoading(false);
      }
    }
  };

  const markAsRead = async (id: string) => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', id)
        .eq('user_id', user?.id);
      if (error) throw error;

      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      masterBus.emit('NOTIFICATION_READ', { notifId: id, allRead: false });
    } catch (err) {
      reportError(err, 'NotificationsPage.markAsRead_error');
      toast.error('Failed to mark as read');
    }
  };

  const markAllRead = async () => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', user?.id);

      if (error) throw error;
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
    } catch (err) {
      reportError(err, 'NotificationsPage.markAllRead_error');
      toast.error('Failed to mark notifications as read');
    }
  };

  const deleteNotification = async (id: string) => {
    try {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', id)
        .eq('user_id', user?.id);
      if (error) throw error;
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      reportError(err, 'NotificationsPage.delete_error');
      toast.error('Failed to delete notification');
    }
  };

  const getRichIcon = (notif: Notification): string => {
    const cat = categorizeNotification(notif);
    const catObj = NOTIF_CATEGORIES.find((c) => c.id === cat);
    return catObj ? catObj.icon : '📋';
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Filter by category, then apply notification grouping
  const filteredNotifications = useMemo(() => {
    const catFiltered =
      activeCategory === 'all'
        ? notifications
        : notifications.filter((n) => categorizeNotification(n) === activeCategory);
    // Q3: Collapse similar notifications (3+ of same type within 30min → summary)
    return notificationService.groupNotifications(catFiltered as any) as unknown as Notification[];
  }, [notifications, activeCategory]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<NotifCategory, number> = {
      all: 0,
      games: 0,
      social: 0,
      achievements: 0,
      system: 0,
    };
    notifications.forEach((n) => {
      if (!n.read) {
        counts.all++;
        counts[categorizeNotification(n)]++;
      }
    });
    return counts;
  }, [notifications]);

  // Group by Time
  type TimeGroup = 'Today' | 'Yesterday' | 'This Week' | 'Earlier';
  const groupedNotifications = useMemo(() => {
    const groups: Record<TimeGroup, typeof filteredNotifications> = {
      Today: [],
      Yesterday: [],
      'This Week': [],
      Earlier: [],
    };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const thisWeek = today - 86400000 * 7;

    filteredNotifications.forEach((notif) => {
      const date = new Date(notif.created_at).getTime();
      if (date >= today) groups['Today'].push(notif);
      else if (date >= yesterday) groups['Yesterday'].push(notif);
      else if (date >= thisWeek) groups['This Week'].push(notif);
      else groups['Earlier'].push(notif);
    });

    return groups;
  }, [filteredNotifications]);

  // Stagger notification rows
  useEffect(() => {
    setVisibleNotifications(new Set());
    const timers = filteredNotifications.map((_, i) =>
      setTimeout(() => setVisibleNotifications((prev) => new Set([...prev, i])), i * 30)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [filteredNotifications.length, activeCategory]);

  return (
    <div className="notifications-page">
      {/* Real-time indicator + DND toggle */}
      <div className="realtime-indicator">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="live-dot"></span>
          <span>Live updates</span>
        </div>
        <button
          className={`dnd-toggle ${dndActive ? 'dnd-active' : ''}`}
          onClick={() => (dndActive ? handleDndClear() : setShowDndPicker(!showDndPicker))}
          title={
            dndActive
              ? `DND active (${notificationService.getDndRemaining()}m left)`
              : 'Do Not Disturb'
          }
        >
          {dndActive ? '🌙 DND On' : '🔔'}
        </button>
        <button
          className="dnd-toggle"
          onClick={() => setShowSettings(true)}
          title="Notification Settings"
          style={{ marginLeft: 4 }}
        >
          ⚙️
        </button>
      </div>

      {/* Q3: DND Duration Picker */}
      {showDndPicker && (
        <div className="dnd-picker">
          <span className="dnd-label">Mute notifications for:</span>
          <div className="dnd-options">
            {[15, 30, 60, 120, 480].map((mins) => (
              <button key={mins} className="dnd-option" onClick={() => handleDndToggle(mins)}>
                {mins < 60 ? `${mins}m` : `${mins / 60}h`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Q3: DND Active Banner */}
      {dndActive && (
        <div className="dnd-banner">
          🌙 Do Not Disturb — {notificationService.getDndRemaining()}m remaining
          <button className="dnd-clear" onClick={handleDndClear}>
            Resume
          </button>
        </div>
      )}

      {/* Category Filter — Pill Chips (Initiative 11) */}
      <div className="notif-category-tabs nf-chip-bar">
        {NOTIF_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`nf-filter-chip ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={() => {
              haptic.selection();
              setActiveCategory(cat.id);
            }}
          >
            <span className="cat-icon">{cat.icon}</span>
            <span className="cat-label">{cat.label}</span>
            {categoryCounts[cat.id] > 0 && cat.id !== 'all' && (
              <span className="nf-count-badge">{categoryCounts[cat.id]}</span>
            )}
          </button>
        ))}
      </div>

      {unreadCount > 0 && (
        <div className="mark-all-bar">
          <button className="mark-all-btn" onClick={markAllRead}>
            Mark all as read ({unreadCount})
          </button>
        </div>
      )}

      <div className="notifications-list">
        {loading ? (
          <div className="nf-skeleton-list">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="nf-skeleton-row" />
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <span
              className="empty-icon"
              style={{ fontSize: '3rem', display: 'block', marginBottom: '0.75rem' }}
            >
              ✅
            </span>
            <p style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
              You're all caught up!
            </p>
            <p style={{ color: 'var(--soft-white, #B0B3B8)', fontSize: '0.85rem', margin: 0 }}>
              No new notifications. We'll let you know when something happens.
            </p>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              {NOTIF_CATEGORIES.find((c) => c.id === activeCategory)?.icon || '○'}
            </span>
            <p>No {activeCategory} notifications</p>
          </div>
        ) : (
          (Object.keys(groupedNotifications) as TimeGroup[]).map((groupName) => {
            const groupNotifs = groupedNotifications[groupName];
            if (groupNotifs.length === 0) return null;
            return (
              <div key={groupName} className="notif-group">
                <div className="time-group-header">
                  <span>{groupName}</span>
                </div>
                {groupNotifs.map((notif) => {
                  const globalIndex = filteredNotifications.indexOf(notif);
                  return (
                    <SwipeableNotificationItem
                      key={notif.id}
                      notif={notif}
                      visible={visibleNotifications.has(globalIndex)}
                      newHighlight={newNotifId === notif.id}
                      icon={getRichIcon(notif)}
                      timeStr={timeAgo(notif.created_at)}
                      onRead={() => {
                        markAsRead(notif.id);
                        if (notif.action_url) navigate(notif.action_url);
                      }}
                      onDelete={() => deleteNotification(notif.id)}
                    />
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {/* Q3 Phase 10: Notification Settings Modal */}
      {showSettings && (
        <NotificationSettingsPanel
          onClose={() => {
            setShowSettings(false);
            setDndActive(notificationService.isDndActive());
          }}
        />
      )}
    </div>
  );
}

function SwipeableNotificationItem({
  notif,
  visible,
  newHighlight,
  icon,
  timeStr,
  onRead,
  onDelete,
}: any) {
  const { handlers, rowStyle, offset, reset } = useSwipeAction({
    actionWidth: 80,
    threshold: 40,
    onSwipeLeft: () => {
      // Swipe left reveals right action (Delete)
    },
  });

  return (
    <div
      className="swipe-container"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.3s, transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div
        className="swipe-actions-right"
        onClick={(e) => {
          e.stopPropagation();
          reset();
          onDelete();
        }}
      >
        🗑️
      </div>
      <div
        className={`notification-item surface ${notif.read ? 'read' : 'unread'} ${newHighlight ? 'new-highlight' : ''}`}
        style={rowStyle}
        {...handlers}
        onClick={() => {
          if (offset !== 0) reset();
          else {
            haptic.light();
            onRead();
          }
        }}
      >
        <span className="notif-icon">{icon}</span>
        <div className="notif-content">
          <span className="notif-title">{notif.title}</span>
          <span className="notif-message">{notif.message}</span>
          <span className="notif-time">{timeStr}</span>
        </div>
        {!notif.read && <span className="unread-dot" />}
      </div>
    </div>
  );
}
