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
import { reportError } from '../utils/errorReporter';

interface HeaderDataState {
  // Data
  avatarUrl: string | null;
  notificationCount: number;
  unreadMessages: number;
  isMessengerPageActive: boolean;

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
  setMessengerPageActive: (active: boolean) => void;
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

/**
 * ── AVATAR CACHE ─────────────────────────────────────────────────────────────
 *
 * The badge counts have been hydrated from localStorage since this store was
 * written, and the avatar never was. So every cold entry into Club Arena
 * painted the empty orb first and popped the picture in once a round trip to
 * Supabase came back — the World Hub's UniversalHeader carries a long comment
 * about never showing "the un-hydrated (avatar-less) frame" and solved exactly
 * this; Club Arena had not.
 *
 * Cached WITH the user id it belongs to, and only read back for that same id.
 * A bare url under a shared key would flash the previous account's face at
 * whoever logs in next on a shared device, which is worse than the flash it
 * removes.
 */
const AVATAR_KEY = 'ca-avatar-cache';

function hydrateAvatar(userId: string): string | null {
  try {
    const raw = localStorage.getItem(AVATAR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { u?: string; a?: string };
    return parsed?.u === userId && typeof parsed.a === 'string' ? parsed.a : null;
  } catch {
    return null;
  }
}

function persistAvatar(userId: string | null, url: string | null): void {
  try {
    if (!userId || !url) {
      localStorage.removeItem(AVATAR_KEY);
      return;
    }
    localStorage.setItem(AVATAR_KEY, JSON.stringify({ u: userId, a: url }));
  } catch {
    /* quota */
  }
}

// PERF 2026-08-24: coalesce badge count refetches.
// The realtime handlers below each ran an exact COUNT per delivered row. This
// collapses a burst into a single trailing query per kind.
const COUNT_DEBOUNCE_MS = 1200;
const countTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
function scheduleCount(kind: string, run: () => void | Promise<void>): void {
  const existing = countTimers[kind];
  if (existing) clearTimeout(existing);
  countTimers[kind] = setTimeout(() => {
    countTimers[kind] = undefined;
    void run();
  }, COUNT_DEBOUNCE_MS);
}

export const useHeaderDataStore = create<HeaderDataState>()((set, get) => ({
  avatarUrl: null,
  notificationCount: hydrateCount('ca-notif-count'),
  unreadMessages: hydrateCount('ca-msg-count'),
  isMessengerPageActive: false,

  _loaded: false,
  _userId: null,
  _channelKey: null,
  _busUnsubscribers: [],

  setAvatarUrl: (url) => {
    set({ avatarUrl: url });
    persistAvatar(get()._userId, url);
  },

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

  setMessengerPageActive: (active) => set({ isMessengerPageActive: active }),

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
        } catch (e) {
          reportError(e, 'useHeaderDataStore.forEach');
          /* silent */
        }
      });
    }

    // Paint the cached avatar SYNCHRONOUSLY, before the fetch is even issued,
    // so the first frame of the header already has the player's face.
    set({ _loaded: true, _userId: userId, avatarUrl: hydrateAvatar(userId) });

    // ── Fetch initial data (non-blocking) ──
    (async () => {
      try {
        // Parallel fetch: avatar + notification count + message count
        const [profileResult, notifResult, msgResult] = await Promise.all([
          supabase
            .from('profiles')
            .select('avatar_url:arena_avatar_url')
            .eq('id', userId)
            .maybeSingle(),
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

        // Guard: if user switched while fetch was in-flight, discard stale result
        if (get()._userId !== userId) return;

        // supabase-js RESOLVES on a rejected request — a 403/42501 arrives as
        // { data: null, error }, never as a throw, so the catch below cannot see
        // it. Reading .data straight through turned a missing column grant on
        // profiles.arena_avatar_url into "the header orb shows the placeholder",
        // with nothing in Sentry and nothing in the console, for every account.
        // Surface each failure on its own; a broken avatar must not look like a
        // user who simply has none.
        if (profileResult.error) {
          reportError(profileResult.error, 'useHeaderDataStore.avatar_fetch');
        }
        if (notifResult.error) {
          reportError(notifResult.error, 'useHeaderDataStore.notification_count_fetch');
        }
        if (msgResult.error) {
          reportError(msgResult.error, 'useHeaderDataStore.message_count_fetch');
        }

        const notifCount = notifResult.count || 0;
        const msgCount = msgResult.count || 0;

        // A FAILED avatar read must not overwrite the cached one with null.
        // Only a query that actually came back gets to say the player has no
        // avatar; anything else keeps the face already on screen.
        if (!profileResult.error) {
          const avatarUrl = profileResult.data?.avatar_url || null;
          set({ avatarUrl });
          persistAvatar(userId, avatarUrl);
        }

        set({ notificationCount: notifCount, unreadMessages: msgCount });
        persistCount('ca-notif-count', notifCount);
        persistCount('ca-msg-count', msgCount);
        masterBus.emit('NOTIFICATION_COUNT_CHANGED', { count: notifCount });
        masterBus.emit('UNREAD_DM_COUNT_CHANGED', { userId, count: msgCount });
      } catch (e) {
        reportError(e, 'useHeaderDataStore.Initial_load_failed');
        // Retry once after 2s — transient network failures are common on mobile
        setTimeout(async () => {
          if (get()._userId !== userId) return; // User switched — abort retry
          try {
            const [pR, nR, mR] = await Promise.all([
              supabase
                .from('profiles')
                .select('avatar_url:arena_avatar_url')
                .eq('id', userId)
                .maybeSingle(),
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
            if (get()._userId !== userId) return;
            if (pR.error) reportError(pR.error, 'useHeaderDataStore.avatar_fetch_retry');
            if (nR.error)
              reportError(nR.error, 'useHeaderDataStore.notification_count_fetch_retry');
            if (mR.error) reportError(mR.error, 'useHeaderDataStore.message_count_fetch_retry');
            if (!pR.error) {
              const retriedAvatar = pR.data?.avatar_url || null;
              set({ avatarUrl: retriedAvatar });
              persistAvatar(userId, retriedAvatar);
            }
            set({
              notificationCount: nR.count || 0,
              unreadMessages: mR.count || 0,
            });
            persistCount('ca-notif-count', nR.count || 0);
            persistCount('ca-msg-count', mR.count || 0);
          } catch (retryErr) {
            reportError(retryErr, 'useHeaderDataStore.Retry_also_failed');
            masterBus.emit('SHOW_TOAST', {
              severity: 'warning',
              message: 'Could not load notifications - pull to refresh',
              source: 'HeaderDataStore',
            });
          }
        }, 2000);
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
        () => {
          // PERF 2026-08-24: this used to run a `count: 'exact'` query
          // SYNCHRONOUSLY ON EVERY EVENT. This channel lives on the global
          // header, so it is mounted for every user for the whole session, and
          // notifications arrive in bursts (a tournament finishing, a club
          // announcement, a settlement run). Ten notifications meant ten exact
          // counts. Coalesced: a burst now costs one query. A badge does not
          // need sub-second precision.
          scheduleCount('notifications', async () => {
            try {
              const { count } = await supabase
                .from('notifications')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId)
                .eq('read', false);
              get().setNotificationCount(count || 0);
            } catch (e) {
              reportError(e, 'useHeaderDataStore.async');
              /* silent */
            }
          });
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
          // If the premium iframe messenger is currently active in the view,
          // it owns the unread count authoritatively. Skip the database query
          // and manual count calculation to avoid a race condition + wasted query.
          if (get().isMessengerPageActive) {
            console.debug(
              '[HeaderDataStore] Skipping RT messages query because iframe messenger is active.'
            );
            return;
          }
          // Coalesced for the same reason as the notifications handler above -
          // an active conversation delivers many rows in quick succession and
          // each one used to trigger its own exact count.
          scheduleCount('messages', async () => {
            try {
              const { count } = await supabase
                .from('messages')
                .select('*', { count: 'exact', head: true })
                .eq('receiver_id', userId)
                .eq('is_read', false);
              get().setUnreadMessages(count || 0);
            } catch (e) {
              reportError(e, 'useHeaderDataStore.async');
              /* silent */
            }
          });
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.debug('[HeaderDataStore] Realtime channel error:', err?.message || err);
          // Auto-retry: remove stale channel and re-create after 3s
          setTimeout(() => {
            if (get()._userId !== userId || get()._channelKey !== channelKey) return;
            try {
              masterBus.removeRegisteredChannel(channelKey);
              // Re-trigger loadOnce by resetting _loaded flag
              set({ _loaded: false, _channelKey: null });
              get().loadOnce(userId);
            } catch (e) {
              reportError(e, 'useHeaderDataStore.setTimeout');
              /* silent */
            }
          }, 3000);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[HeaderDataStore] Realtime channel timed out - retrying...');
          // Same retry as CHANNEL_ERROR
          setTimeout(() => {
            if (get()._userId !== userId || get()._channelKey !== channelKey) return;
            try {
              masterBus.removeRegisteredChannel(channelKey);
              set({ _loaded: false, _channelKey: null });
              get().loadOnce(userId);
            } catch (e) {
              reportError(e, 'useHeaderDataStore.setTimeout');
              /* silent */
            }
          }, 3000);
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
        // Self-echo guard: skip if count is already the same (avoids redundant localStorage write)
        if (event.payload.count === get().unreadMessages) return;
        set({ unreadMessages: event.payload.count });
        persistCount('ca-msg-count', event.payload.count);
      }
    });

    // ── Sync avatar changes from AvatarGallery (instant, no realtime delay) ──
    const unsubProfileLoaded = masterBus.subscribe('USER_PROFILE_LOADED', (event) => {
      const avatarUrl = event.payload?.avatarUrl;
      if (avatarUrl && typeof avatarUrl === 'string') {
        get().setAvatarUrl(avatarUrl);
      }
    });

    set({ _busUnsubscribers: [unsubNotifRead, unsubDmCount, unsubProfileLoaded] });
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
      } catch (e) {
        reportError(e, 'useHeaderDataStore.forEach');
        /* silent */
      }
    });
    // Clear localStorage counts to prevent cross-user data bleed
    try {
      localStorage.removeItem('ca-notif-count');
      localStorage.removeItem('ca-msg-count');
      localStorage.removeItem(AVATAR_KEY);
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
