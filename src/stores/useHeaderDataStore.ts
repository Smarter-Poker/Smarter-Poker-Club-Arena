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
import { resolveCosmetic } from '../cosmetics/avatarCosmetics';

interface HeaderDataState {
  // Data
  /** Resolved portrait shown by the global header. */
  avatarUrl: string | null;
  profilePhotoUrl: string | null;
  arenaAvatarUrl: string | null;
  useAvatarAsProfilePic: boolean;
  isVipActive: boolean;
  _vipFlag: boolean;
  _vipExpiresAt: string | null;
  /**
   * The player's own equipped cosmetics, for the header orb and the hamburger.
   *
   * They live beside `avatarUrl` rather than in a store of their own because
   * they are drawn ON the avatar: a surface that has one and not the other
   * paints a gold ring around a stale face. Same fetch, same cache, same
   * realtime channel, same invalidation.
   */
  equippedFrame: string | null;
  equippedAura: string | null;
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
  setProfileHeaderData: (row: Record<string, unknown>) => void;
  setAvatarUrl: (url: string | null) => void;
  setCosmetics: (frame: string | null, aura: string | null) => void;
  setNotificationCount: (count: number) => void;
  setUnreadMessages: (count: number) => void;
  setMessengerPageActive: (active: boolean) => void;
  clearUnreadNotifications: (userId: string) => Promise<boolean>;
  clearUnreadMessages: (userId: string) => Promise<boolean>;
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
const AVATAR_KEY = 'ca-header-portrait-cache-v2';
const LEGACY_AVATAR_KEY = 'ca-avatar-cache';

function cleanUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Match the World Hub's existing profile-picture toggle exactly.
 *
 * The social photo is the global default. The Arena avatar is allowed onto a
 * global surface only after the user explicitly enables "Use Avatar". When an
 * opted-in avatar is later removed, fall back to the real photo rather than a
 * placeholder.
 */
export function resolveHeaderPortrait(
  profilePhotoUrl: string | null,
  arenaAvatarUrl: string | null,
  useAvatarAsProfilePic: boolean
): string | null {
  if (useAvatarAsProfilePic) return arenaAvatarUrl || profilePhotoUrl;
  return profilePhotoUrl;
}

export function resolveActiveVip(
  isVip: boolean,
  expiresAt: string | null,
  now = Date.now()
): boolean {
  if (!isVip) return false;
  if (!expiresAt) return true;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

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
    // Never hydrate the old Arena-only value again. It is exactly the stale
    // KingFish flash this versioned cache is intended to eliminate.
    localStorage.removeItem(LEGACY_AVATAR_KEY);
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
  profilePhotoUrl: null,
  arenaAvatarUrl: null,
  useAvatarAsProfilePic: false,
  isVipActive: false,
  _vipFlag: false,
  _vipExpiresAt: null,
  /* Not hydrated from localStorage the way the avatar is, deliberately. The
     avatar cache exists to kill a visible pop-in of the player's own face; a
     frame that appears a beat later is not that, and caching an entitlement
     locally means a lapsed VIP keeps seeing their frame until the cache is
     cleared. Cosmetics come from the database or they do not appear. */
  equippedFrame: null,
  equippedAura: null,
  notificationCount: hydrateCount('ca-notif-count'),
  unreadMessages: hydrateCount('ca-msg-count'),
  isMessengerPageActive: false,

  _loaded: false,
  _userId: null,
  _channelKey: null,
  _busUnsubscribers: [],

  setProfileHeaderData: (row) => {
    const state = get();
    const has = (column: string) => Object.prototype.hasOwnProperty.call(row, column);
    const profilePhotoUrl = has('avatar_url') ? cleanUrl(row.avatar_url) : state.profilePhotoUrl;
    const arenaAvatarUrl = has('arena_avatar_url')
      ? cleanUrl(row.arena_avatar_url)
      : state.arenaAvatarUrl;
    const useAvatarAsProfilePic = has('use_avatar_as_profile_pic')
      ? row.use_avatar_as_profile_pic === true
      : state.useAvatarAsProfilePic;
    const vipFlag = has('is_vip') ? row.is_vip === true : state._vipFlag;
    const vipExpiresAt = has('vip_expires_at') ? cleanUrl(row.vip_expires_at) : state._vipExpiresAt;
    const avatarUrl = resolveHeaderPortrait(profilePhotoUrl, arenaAvatarUrl, useAvatarAsProfilePic);

    set({
      avatarUrl,
      profilePhotoUrl,
      arenaAvatarUrl,
      useAvatarAsProfilePic,
      isVipActive: resolveActiveVip(vipFlag, vipExpiresAt),
      _vipFlag: vipFlag,
      _vipExpiresAt: vipExpiresAt,
    });
    persistAvatar(state._userId, avatarUrl);
  },

  // Backward-compatible action for the Arena's avatar picker events. It
  // updates the Arena source but cannot replace the global photo unless the
  // user's World Hub preference explicitly opted into that behaviour.
  setAvatarUrl: (url) => {
    get().setProfileHeaderData({ arena_avatar_url: url });
  },

  /**
   * Resolved on the way in, never stored raw.
   *
   * A row can hold a token from a build that is not this one — a retired
   * cosmetic, a Hub-only experiment, something typed into the SQL editor.
   * Resolving here means every consumer of this store gets either a token it
   * can render or null, and no surface has to defend itself individually.
   *
   * The self-echo guard is not decoration: this setter is called by the initial
   * fetch, the retry, the realtime handler and the picker, and without it a
   * realtime echo of the player's own write re-renders the whole header.
   */
  setCosmetics: (frame, aura) => {
    const nextFrame = resolveCosmetic(frame, 'frame')?.id ?? null;
    const nextAura = resolveCosmetic(aura, 'aura')?.id ?? null;
    const state = get();
    if (state.equippedFrame === nextFrame && state.equippedAura === nextAura) return;
    set({ equippedFrame: nextFrame, equippedAura: nextAura });
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

  /* Opening either destination acknowledges the count the player just acted
     on. Zero it synchronously so the badge disappears on the click, then make
     the database authoritative before Messenger performs its full-page
     redirect. A failed write restores the previous count instead of lying. */
  clearUnreadNotifications: async (userId) => {
    const previous = get().notificationCount;
    get().setNotificationCount(0);
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', userId)
        .eq('read', false);
      if (error) throw error;
      return true;
    } catch (error) {
      reportError(error, 'useHeaderDataStore.clear_unread_notifications');
      if (get().notificationCount === 0 && (!get()._userId || get()._userId === userId)) {
        get().setNotificationCount(previous);
      }
      return false;
    }
  },

  clearUnreadMessages: async (userId) => {
    const previous = get().unreadMessages;
    get().setUnreadMessages(0);
    try {
      const { error } = await supabase
        .from('messages')
        .update({ is_read: true })
        .eq('receiver_id', userId)
        .eq('is_read', false);
      if (error) throw error;
      return true;
    } catch (error) {
      reportError(error, 'useHeaderDataStore.clear_unread_messages');
      if (get().unreadMessages === 0 && (!get()._userId || get()._userId === userId)) {
        get().setUnreadMessages(previous);
      }
      return false;
    }
  },

  /**
   * Load header data ONCE for a given userId.
   * Subsequent calls with the same userId are no-ops.
   * If userId changes (different user login), reloads.
   */
  loadOnce: (userId: string) => {
    const state = get();
    const pendingPlayerAppearance = new Set<string>();

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
    set({
      _loaded: true,
      _userId: userId,
      avatarUrl: hydrateAvatar(userId),
      profilePhotoUrl: null,
      arenaAvatarUrl: null,
      useAvatarAsProfilePic: false,
      isVipActive: false,
      _vipFlag: false,
      _vipExpiresAt: null,
    });

    // ── Fetch initial data (non-blocking) ──
    (async () => {
      try {
        // Parallel fetch: avatar + notification count + message count
        const [profileResult, notifResult, msgResult] = await Promise.all([
          supabase
            .from('profiles')
            .select(
              'avatar_url, arena_avatar_url, use_avatar_as_profile_pic, is_vip, vip_expires_at, equipped_frame, equipped_aura'
            )
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
        // with nothing in error reporting and nothing in the console, for every account.
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
        if (!profileResult.error && pendingPlayerAppearance.size === 0) {
          get().setProfileHeaderData((profileResult.data ?? {}) as Record<string, unknown>);
          get().setCosmetics(
            profileResult.data?.equipped_frame ?? null,
            profileResult.data?.equipped_aura ?? null
          );
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
                .select(
                  'avatar_url, arena_avatar_url, use_avatar_as_profile_pic, is_vip, vip_expires_at, equipped_frame, equipped_aura'
                )
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
            if (!pR.error && pendingPlayerAppearance.size === 0) {
              get().setProfileHeaderData((pR.data ?? {}) as Record<string, unknown>);
              get().setCosmetics(pR.data?.equipped_frame ?? null, pR.data?.equipped_aura ?? null);
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
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${userId}`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          /* The player's own row changed. This is what makes a change made on
             ANOTHER surface — the World Hub's avatar page, a second tab, the
             table's settings panel — reach this header without a reload.
             `profiles` is in the supabase_realtime publication (verified
             2026-08-25); `table_seats` is NOT, which is why the identical-looking
             `table-seats-live` subscription in TablePage has never delivered a
             row and could not be copied here.

             A partial payload must not blank the orb. setProfileHeaderData
             merges only columns actually present in the replication payload,
             then applies the same Photo/Avatar preference used by World Hub. */
          const row = payload?.new;
          if (!row) return;
          if (pendingPlayerAppearance.size > 0) return;
          get().setProfileHeaderData(row);
          get().setCosmetics(
            typeof row['equipped_frame'] === 'string' ? (row['equipped_frame'] as string) : null,
            typeof row['equipped_aura'] === 'string' ? (row['equipped_aura'] as string) : null
          );
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

    const unsubAppearanceMutation = masterBus.subscribe('CUSTOMIZATION_MUTATION_STATE', (event) => {
      if (event.payload.kind !== 'player-appearance' || event.payload.scope !== userId) return;
      if (event.payload.state === 'pending') {
        pendingPlayerAppearance.add(event.payload.mutationId);
      } else if (event.payload.state !== 'rolling-back') {
        pendingPlayerAppearance.delete(event.payload.mutationId);
      }
    });

    const unsubPlayerAppearance = masterBus.subscribe('PLAYER_APPEARANCE_CHANGED', (event) => {
      if (event.payload.userId !== userId) return;
      if (typeof event.payload.avatar === 'string' && event.payload.avatar) {
        get().setAvatarUrl(event.payload.avatar);
      }
      if (event.payload.frame !== undefined || event.payload.aura !== undefined) {
        get().setCosmetics(
          event.payload.frame !== undefined ? event.payload.frame : get().equippedFrame,
          event.payload.aura !== undefined ? event.payload.aura : get().equippedAura
        );
      }
    });

    // ── Backward-compatible avatar events from older in-app surfaces ──
    const unsubProfileLoaded = masterBus.subscribe('USER_PROFILE_LOADED', (event) => {
      if (event.payload.userId && event.payload.userId !== userId) return;
      const avatarUrl = event.payload?.avatarUrl;
      if (avatarUrl && typeof avatarUrl === 'string') {
        get().setAvatarUrl(avatarUrl);
      }
    });

    set({
      _busUnsubscribers: [
        unsubNotifRead,
        unsubDmCount,
        unsubAppearanceMutation,
        unsubPlayerAppearance,
        unsubProfileLoaded,
      ],
    });
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
      localStorage.removeItem(LEGACY_AVATAR_KEY);
    } catch {
      /* quota */
    }
    set({
      avatarUrl: null,
      profilePhotoUrl: null,
      arenaAvatarUrl: null,
      useAvatarAsProfilePic: false,
      isVipActive: false,
      _vipFlag: false,
      _vipExpiresAt: null,
      // Cleared with the avatar for the same reason the avatar cache is: on a
      // shared device the next account must not inherit the last one's face,
      // and a frame is part of that face.
      equippedFrame: null,
      equippedAura: null,
      notificationCount: 0,
      unreadMessages: 0,
      _loaded: false,
      _userId: null,
      _channelKey: null,
      _busUnsubscribers: [],
    });
  },
}));
