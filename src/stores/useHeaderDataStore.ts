/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useHeaderDataStore — Persistent Header Data (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This store owns ALL data displayed in the GlobalHeader:
 *   - Avatar URL
 *   - Notification count (unread)
 *   - Unread message count
 *
 * WHY THIS EXISTS:
 * Previously, GlobalHeader fetched this data from Supabase in a useEffect
 * that re-ran on every route change (because authUser?.id toggled). This
 * caused 3 Supabase queries + realtime channel reconnect on EVERY page
 * navigation — a massive performance drain.
 *
 * NOW:
 * - Data is loaded ONCE on first auth, cached in this store
 * - Updates come ONLY via Supabase Realtime channels (no polling)
 * - Realtime channel is managed at the store level (survives route changes)
 * - Badge counts are hydrated from localStorage for instant re-entry
 *
 * GlobalHeader is now a PURE RENDERER of this store — zero fetches.
 */

import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

interface HeaderDataState {
  // Data
  avatarUrl: string | null;
  notificationCount: number;
  unreadMessages: number;

  // Loading guards
  _loaded: boolean;
  _userId: string | null;
  _channelKey: string | null;
  _busUnsubscribers: Array<() => void>;

  // Actions
  loadOnce: (userId: string) => void;
  setAvatarUrl: (url: string | null) => void;
  setNotificationCount: (count: number) => void;
  setUnreadMessages: (count: number) => void;
  teardown: () => void;
}

// Hydrate from localStorage for instant badge display on SPA re-entry
function hydrateCount(key: string): number {
  try {
    return parseInt(localStorage.getItem(key) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function persistCount(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* quota */
  }
}

export const useHeaderDataStore = create<HeaderDataState>()((set, get) => ({
  avatarUrl: null,
  notificationCount: hydrateCount('ca-notif-count'),
  unreadMessages: hydrateCount('ca-msg-count'),

  _loaded: false,
  _userId: null,
  _channelKey: null,
  _busUnsubscribers: [],

  setAvatarUrl: (url) => set({ avatarUrl: url }),

  setNotificationCount: (count) => {
    set({ notificationCount: count });
    persistCount('ca-notif-count', count);
    masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count });
  },

  setUnreadMessages: (count) => {
    set({ unreadMessages: count });
    persistCount('ca-msg-count', count);
    masterBus.emit('UNREAD_DM_COUNT_CHANGED', { userId: get()._userId || '', count });
  },

  /**
   * Load header data ONCE for a given userId.
   * Subsequent calls with the same userId are no-ops.
   * If userId changes (different user login), reloads.
   */
  loadOnce: (userId: string) => {
    const state = get();

    // Already loaded for this user — skip
    if (state._loaded && state._userId === userId) return;

    // If switching users, teardown old channel + bus subscriptions first
    if (state._channelKey) {
      masterBus.removeRegisteredChannel(state._channelKey);
    }
    // Clean up old bus subscriptions to prevent zombie handlers
    if (state._busUnsubscribers.length > 0) {
      state._busUnsubscribers.forEach((unsub) => {
        try {
          unsub();
        } catch {
          /* silent */
        }
      });
    }

    set({ _loaded: true, _userId: userId });

    // ── Fetch initial data (non-blocking) ──
    (async () => {
      try {
        // Parallel fetch: avatar + notification count + message count
        const [profileResult, notifResult, msgResult] = await Promise.all([
          supabase.from('profiles').select('avatar_url').eq('id', userId).maybeSingle(),
          supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('read', false),
          supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('is_read', false),
        ]);

        const avatarUrl = profileResult.data?.avatar_url || null;
        const notifCount = notifResult.count || 0;
        const msgCount = msgResult.count || 0;

        set({ avatarUrl, notificationCount: notifCount, unreadMessages: msgCount });
        persistCount('ca-notif-count', notifCount);
        persistCount('ca-msg-count', msgCount);
        masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count: notifCount });
        masterBus.emit('UNREAD_DM_COUNT_CHANGED', { userId, count: msgCount });
      } catch (e) {
        console.error('[HeaderDataStore] Initial load failed:', e);
      }
    })();

    // ── Set up Supabase Realtime channel (persists across route changes) ──
    const channelKey = `header-data-${userId}`;
    set({ _channelKey: channelKey });

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        async () => {
          try {
            const { count } = await supabase
              .from('notifications')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', userId)
              .eq('read', false);
            get().setNotificationCount(count || 0);
          } catch {
            /* silent */
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${userId}`,
        },
        async () => {
          try {
            const { count } = await supabase
              .from('messages')
              .select('*', { count: 'exact', head: true })
              .eq('receiver_id', userId)
              .eq('is_read', false);
            get().setUnreadMessages(count || 0);
          } catch {
            /* silent */
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[HeaderDataStore] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[HeaderDataStore] ⏱️ Realtime channel timed out');
        }
      });

    // ── Bus listeners for in-app actions (instant, no realtime delay) ──
    // CRITICAL: Store unsubscribe functions to prevent zombie listeners on logout/login
    const unsubNotifRead = masterBus.subscribe('NOTIFICATION_READ', (event) => {
      if (event.payload?.allRead) {
        get().setNotificationCount(0);
      } else {
        const current = get().notificationCount;
        get().setNotificationCount(Math.max(0, current - 1));
      }
    });

    const unsubDmCount = masterBus.subscribe('UNREAD_DM_COUNT_CHANGED', (event) => {
      if (event.payload?.count !== undefined && typeof event.payload.count === 'number') {
        set({ unreadMessages: event.payload.count });
        persistCount('ca-msg-count', event.payload.count);
      }
    });

    set({ _busUnsubscribers: [unsubNotifRead, unsubDmCount] });
  },

  teardown: () => {
    const state = get();
    // Remove realtime channel
    if (state._channelKey) {
      masterBus.removeRegisteredChannel(state._channelKey);
    }
    // Unsubscribe bus listeners to prevent zombie handlers
    state._busUnsubscribers.forEach((unsub) => {
      try {
        unsub();
      } catch {
        /* silent */
      }
    });
    // Clear localStorage counts to prevent cross-user data bleed
    try {
      localStorage.removeItem('ca-notif-count');
      localStorage.removeItem('ca-msg-count');
    } catch {
      /* quota */
    }
    set({
      avatarUrl: null,
      notificationCount: 0,
      unreadMessages: 0,
      _loaded: false,
      _userId: null,
      _channelKey: null,
      _busUnsubscribers: [],
    });
  },
}));
