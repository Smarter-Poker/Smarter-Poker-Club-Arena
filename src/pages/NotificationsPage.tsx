/**
 * NOTIFICATIONS — Club Arena surface
 * ═══════════════════════════════════════════════════════════════════════
 * Dan, 2026-08-27: "NOTIFICATIONS PAGE SHOULD NOT TAKE SO LONG TO LOAD, IT
 * SHOULD INSTANTLY OPEN AND DISPLAY WHEN CLICKED LIKE IT DOES ON ANY OTHER
 * PLATFORM... AND IT NEEDS TO BE RAISED UP TO THE TOP TO BE ATTACHED TO THE
 * GLOBAL HEADER."
 *
 * WHAT WAS SLOW, AND WHY NO AMOUNT OF TUNING WOULD HAVE FIXED IT
 * ───────────────────────────────────────────────────────────────────────
 * Until now this route rendered an <iframe src="/hub/notifications?embed=ca">.
 * Tapping the bell therefore booted a SECOND application on top of the warm
 * one: a fresh HTML document, the Next.js runtime, _app, that page's chunk,
 * hydration, a second Supabase client, a second auth read, and only THEN the
 * feed request. Every one of those steps was serial, and Club Arena — already
 * loaded, already authenticated, already holding a Supabase client — could
 * not contribute a single one of them. The spinner covered the whole chain,
 * so the page could not paint until the last step finished.
 *
 * It also violated section 1.3 of CLAUDE.md ("Never add iframe code
 * (window.parent, postMessage, ClubArenaEmbed)"), which is the rule that
 * exists precisely because embedding one of our apps inside the other costs
 * a whole second boot.
 *
 * WHAT MAKES IT INSTANT NOW
 * ───────────────────────────────────────────────────────────────────────
 *  1. The list renders natively in this SPA. No second document, no second
 *     hydration — a route change and a render, like every other CA page.
 *  2. First paint reads the current account's local cache synchronously.
 *     The account key also remounts the feed, so another account's rows never
 *     become its first frame while authentication or a request is pending.
 *  3. The legacy World Hub cache carries no account owner. It cannot safely
 *     warm this page. Club Arena now uses an account-scoped cache and only
 *     writes it from the current owner's confirmed feed response.
 *  4. The network refresh runs behind the painted list and reconciles.
 *
 * "ONE DISPLAY" IS STILL TRUE WHERE IT MATTERS
 * ───────────────────────────────────────────────────────────────────────
 * Dan, 2026-08-25: "we need ONE DISPLAY... and you need to enable the ability
 * to click on the notification and it direct you directly to the page it's
 * notifying you about." The failure that request came from was TWO ROUTING
 * IMPLEMENTATIONS disagreeing — this page read `metadata`, producers wrote
 * `data`, and 1219 "Seat Open" rows resolved to nothing.
 *
 * That cannot recur here, because this file contains no routing rules at all.
 * `/api/notifications/feed` runs the one canonical resolver server-side
 * (World Hub src/lib/notificationRoute.js) and hands back `n.link` already
 * resolved. We render it and we follow it. Same feed, same resolver, same
 * read/dismiss endpoints as the hub page and as NotificationDropdown — only
 * the markup is local, which is the part that has to be local for the route
 * to be fast.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PushEnableBanner from '../components/notifications/PushEnableBanner';
import AccountSurfaceHeader from '../components/account/AccountSurfaceHeader';
import './NotificationsPage.css';
import { leaveForHub, openInBrowser } from '../lib/openExternal';

/** The WEB path Club Arena lives under. A notification's destination is
    written by the server as a web URL, so this is the prefix to strip before
    handing the rest to react-router - on every target. It is deliberately NOT
    the router basename: inside the native app the basename is '/', but the
    destinations the server writes still say /hub/club-arena/... */
const CA_BASE = '/hub/club-arena';

/* The placeholder portrait lives in THIS bundle's public/. A bare
   '/default-avatar.png' resolves against the World Hub root, which is a
   different deployment and owes us nothing at that path. */
const DEFAULT_AVATAR = `${import.meta.env.BASE_URL || '/hub/club-arena/'}default-avatar.png`;

/**
 * Private to the account and this surface. The legacy shared cache has no
 * account provenance, so it is intentionally not imported or overwritten.
 * Element 0 carries the cache timestamp; only confirmed feed reads persist.
 */
const CACHE_KEY = 'ca-notif-cache:v1:';
const CACHE_TTL_MS = 300_000; // 5 minutes, matching the hub page.
const CACHE_MAX = 30;

/** A row exactly as /api/notifications/feed returns it. */
interface FeedNotification {
  id: string;
  type?: string | null;
  title?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  read?: boolean | null;
  is_read?: boolean | null;
  created_at: string;
  actor_name?: string | null;
  actor_avatar_url?: string | null;
  /** Destination, resolved server-side by the one canonical resolver. */
  link?: string | null;
  action_url?: string | null;
  _cache_ts?: number;
}

/* ═══════════════════════════════════════════════════════════════════════
   CATEGORY ICONS
   Inline SVG rather than an icon package: Club Arena does not depend on
   lucide-react (the hub page does), and adding a dependency to make a page
   faster would be self-defeating. Emoji are forbidden in source (CLAUDE.md
   section 5.3 — they break the SWC compiler).
   ═══════════════════════════════════════════════════════════════════════ */

type Glyph = 'bell' | 'seat' | 'money' | 'trophy' | 'chat' | 'person' | 'star' | 'megaphone';

const GLYPH_PATHS: Record<Glyph, string> = {
  bell: 'M12 2a6 6 0 0 0-6 6c0 4-1.5 5-2 6h16c-.5-1-2-2-2-6a6 6 0 0 0-6-6zM10 20a2 2 0 0 0 4 0',
  seat: 'M4 12a8 8 0 0 1 16 0M7.5 15.5a5 5 0 0 1 9 0M11 19h2',
  money: 'M3 6h18v12H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
  trophy: 'M7 4h10v5a5 5 0 0 1-10 0zM4 5h3v3a3 3 0 0 1-3-3M20 5h-3v3a3 3 0 0 0 3-3M10 20h4M12 14v6',
  chat: 'M21 12a8 8 0 0 1-8 8H4l2.5-3A8 8 0 1 1 21 12z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  megaphone: 'M3 10v4h4l7 5V5l-7 5zM18 9a4 4 0 0 1 0 6',
};

interface Category {
  glyph: Glyph;
  bg: string;
}

/**
 * Category, from the notification type. Presentation only — it never decides
 * where a tap goes, so it cannot drift into a second routing table the way
 * the icon map and the routing switch on the old page did.
 */
function categorise(type: string | null | undefined, message: string | null | undefined): Category {
  const t = (type || '').toLowerCase();
  const msg = (message || '').toLowerCase();

  /* #SmarterCasinoRealism palette: seat calls are the one red light on the
     desk, money is green felt, tournaments and distinctions are brass,
     conversation and people are broadcast blue, the house is steel. The old
     map used Instagram pink, Facebook blue and a YouTube-ish yellow. */
  const SEAT = '#c6303f';
  const MONEY = '#1f8f55';
  const BRASS = '#b8902f';
  const BLUE = '#1e7fd0';
  const STEEL = '#4c5f6d';

  if (t.startsWith('waitlist') || t === 'seat_ready' || t === 'called_for_seat')
    return { glyph: 'seat', bg: SEAT };
  if (t === 'table_invite' || t === 'live' || t === 'live_game') return { glyph: 'seat', bg: SEAT };
  if (
    t === 'settlement' ||
    t === 'weekly_settlement' ||
    t === 'settlement_hold' ||
    t === 'payout' ||
    t === 'refund' ||
    t === 'bonus' ||
    t.startsWith('rakeback')
  )
    return { glyph: 'money', bg: MONEY };
  if (t.startsWith('tournament')) return { glyph: 'trophy', bg: BRASS };
  if (t === 'achievement' || t === 'level_up' || t.startsWith('streak'))
    return { glyph: 'star', bg: BRASS };
  if (t === 'message' || t === 'messenger_message' || t === 'comment' || t === 'mention')
    return { glyph: 'chat', bg: BLUE };
  if (t.startsWith('friend') || t === 'member_joined' || t === 'new_follow' || t === 'follow')
    return { glyph: 'person', bg: BLUE };
  if (t.endsWith('announcement') || t === 'club_updates') return { glyph: 'megaphone', bg: BRASS };

  // Content fallback, for types that have not been enumerated yet.
  if (msg.includes('seat')) return { glyph: 'seat', bg: SEAT };
  if (msg.includes('rake') || msg.includes('settlement')) return { glyph: 'money', bg: MONEY };
  if (msg.includes('tournament')) return { glyph: 'trophy', bg: BRASS };

  return { glyph: 'bell', bg: STEEL };
}

function CategoryIcon({ glyph, size = 13 }: { glyph: Glyph; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPH_PATHS[glyph]} />
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   CACHE
   ═══════════════════════════════════════════════════════════════════════ */

/** Synchronous, so the first render already has rows. Never throws. */
function readCache(userId: string | null): FeedNotification[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY + userId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    const age = Date.now() - (parsed[0]?._cache_ts || 0);
    if (age >= CACHE_TTL_MS) return [];
    return parsed as FeedNotification[];
  } catch {
    // A private-mode browser, a cleared store, or a half-written entry. A
    // cold skeleton is the correct outcome, not a crash.
    return [];
  }
}

function writeCache(userId: string | null, rows: FeedNotification[]): void {
  if (!userId) return;
  try {
    const now = Date.now();
    localStorage.setItem(
      CACHE_KEY + userId,
      JSON.stringify(
        rows.slice(0, CACHE_MAX).map((n, i) => (i === 0 ? { ...n, _cache_ts: now } : n))
      )
    );
  } catch {
    // Quota or a blocked store. The list on screen is unaffected.
  }
}

const isUnread = (n: FeedNotification) => !(n.read || n.is_read);

/** The destination the server resolved, or null when there genuinely is none. */
const destinationOf = (n: FeedNotification): string | null =>
  n.link || n.action_url || (typeof n.data?.action_url === 'string' ? n.data.action_url : null);

/** Day bucket for the rail headings. Local time, because that is the clock the player reads. */
function dayBucket(iso: string, now = new Date()): 'Today' | 'Yesterday' | 'This Week' | 'Earlier' {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86_400_000) return 'Yesterday';
  if (t >= startOfToday - 6 * 86_400_000) return 'This Week';
  return 'Earlier';
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════ */

interface FeedOwner {
  active: boolean;
  pending: boolean;
  inFlight: Promise<void> | null;
  controller: AbortController;
  mutations: Set<string>;
  dismissedSynthetic: Set<string>;
  hasSnapshot: boolean;
}

export default function NotificationsPage() {
  const { user } = useAuthUser();
  // A different account gets a different component instance before first paint.
  return <NotificationFeed key={user?.id ?? 'signed-out'} userId={user?.id ?? null} />;
}

function NotificationFeed({ userId }: { userId: string | null }) {
  const navigate = useNavigate();

  // Painted on frame one. See the header note: synchronous by design.
  const [notifications, setNotifications] = useState<FeedNotification[]>(() => readCache(userId));
  const [loading, setLoading] = useState(() => !!userId && readCache(userId).length === 0);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('Connecting');
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const ownerRef = useRef<FeedOwner | null>(null);
  const rowsRef = useRef(notifications);
  const applyRows = useCallback(
    (rows: FeedNotification[], cache = true) => {
      rowsRef.current = rows;
      setNotifications(rows);
      if (cache) writeCache(userId, rows);
    },
    [userId]
  );

  useEffect(() => {
    const owner: FeedOwner = {
      active: true,
      pending: false,
      inFlight: null,
      controller: new AbortController(),
      mutations: new Set(),
      dismissedSynthetic: new Set(),
      hasSnapshot: rowsRef.current.length > 0,
    };
    ownerRef.current = owner;
    return () => {
      owner.active = false;
      owner.controller.abort();
    };
  }, [userId]);

  useEffect(() => {
    document.title = 'Notifications | Smarter Poker';
  }, []);

  const unreadCount = useMemo(() => notifications.filter(isUnread).length, [notifications]);
  const visibleNotifications = useMemo(
    () => (filter === 'unread' ? notifications.filter(isUnread) : notifications),
    [filter, notifications]
  );

  /* ── Refresh from the one feed endpoint ──────────────────────────── */

  const refresh = useCallback(async () => {
    const owner = ownerRef.current;
    if (!userId || !owner?.active) return;
    const isCurrent = () => owner.active && ownerRef.current === owner;
    owner.pending = true;
    if (owner.inFlight) return owner.inFlight;
    if (owner.mutations.size > 0) return;

    const run = async () => {
      try {
        do {
          owner.pending = false;
          try {
            const { data: sessionData } = await supabase.auth.getSession();
            if (!isCurrent() || owner.pending || owner.mutations.size > 0) continue;
            const session = sessionData?.session;
            if (!session?.access_token || session.user.id !== userId) {
              throw new Error('The Feed Could Not Verify Your Sign In.');
            }
            const res = await fetch('/api/notifications/feed?limit=50&bust=1', {
              cache: 'no-store',
              headers: { Authorization: `Bearer ${session.access_token}` },
              signal: owner.controller.signal,
            });
            if (!isCurrent() || owner.pending || owner.mutations.size > 0) continue;
            if (!res.ok) throw new Error('Notification Feed Read Refused');
            const json = await res.json();
            if (!isCurrent() || owner.pending || owner.mutations.size > 0) continue;
            if (!json?.success || !Array.isArray(json.notifications)) {
              throw new Error('Notification Feed Response Was Invalid');
            }
            applyRows(
              (json.notifications as FeedNotification[]).filter(
                (row) => !owner.dismissedSynthetic.has(row.id)
              )
            );
            owner.hasSnapshot = true;
            setError(null);
            setLoading(false);
          } catch (err) {
            if (!isCurrent() || owner.pending || owner.mutations.size > 0) continue;
            console.warn('[Notifications] refresh failed:', (err as Error)?.message || err);
            setError(
              owner.hasSnapshot
                ? 'Notifications Could Not Be Refreshed. Showing The Last Confirmed Feed.'
                : 'Notifications Could Not Be Loaded.'
            );
            setLoading(false);
          }
        } while (isCurrent() && owner.pending && owner.mutations.size === 0);
      } finally {
        owner.inFlight = null;
      }
    };
    owner.inFlight = run();
    return owner.inFlight;
  }, [userId, applyRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A tab left open through a session and brought back should not show the
  // list as it stood an hour ago.
  useVisibilityRefresh(() => refresh());

  /* ── Clear the header badge on open ──────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (!token || cancelled || !userId || data?.session?.user.id !== userId) return;
        await fetch('/api/notifications/mark-seen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
        });
      } catch {
        // Badge cosmetics. Never worth surfacing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Events invalidate the canonical feed. Raw event rows have not passed
  // through its destination resolver and must not overwrite resolved rows.
  const handleChange = useCallback(
    (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
      const changed = payload?.new?.id ? payload.new : payload?.old;
      if (!changed?.id || (changed.user_id && changed.user_id !== userId)) return;
      void refresh();
    },
    [refresh, userId]
  );

  useMasterBusChannel({
    channelName: userId ? `ca-notif-page:${userId}` : null,
    table: 'notifications',
    filter: userId ? `user_id=eq.${userId}` : null,
    event: '*',
    onPayload: handleChange,
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') {
        setConnectionStatus('Live Feed');
        void refresh();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setConnectionStatus('Reconnecting');
      }
    },
    enabled: !!userId,
  });

  /* ── Read / dismiss ──────────────────────────────────────────────── */

  const markAsRead = useCallback(
    async (id: string | null) => {
      const owner = ownerRef.current;
      if (!userId || !owner?.active) return;
      const before = new Map(
        rowsRef.current
          .filter((n) => isUnread(n) && (id === null || n.id === id))
          .map((n) => [n.id, n])
      );
      const key = id === null ? 'read-all' : `read:${id}`;
      if (before.size === 0 || owner.mutations.has(key)) return;
      owner.mutations.add(key);
      owner.pending = true;
      applyRows(
        rowsRef.current.map((n) => (before.has(n.id) ? { ...n, read: true, is_read: true } : n)),
        false
      );
      try {
        const { data } = await supabase.auth.getSession();
        if (!owner.active || ownerRef.current !== owner) return;
        const session = data?.session;
        if (!session?.access_token || session.user.id !== userId) {
          throw new Error('The Read Could Not Verify Your Sign In.');
        }
        const send = async (url: string, method: string, body: Record<string, unknown>) => {
          const res = await fetch(url, {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(body),
          });
          if (!res.ok || !(await res.json())?.success) {
            throw new Error('Notification Read Refused');
          }
        };
        const writes: Promise<void>[] = [];
        if ([...before.keys()].some((key) => !key.startsWith('poker-'))) {
          writes.push(
            send('/api/notifications/mark-read', 'POST', id === null ? {} : { notificationId: id })
          );
        }
        if ([...before.keys()].some((key) => key.startsWith('poker-'))) {
          writes.push(
            send(
              '/api/poker/notifications',
              'PUT',
              id === null ? { mark_all: true } : { notification_id: id.slice('poker-'.length) }
            )
          );
        }
        // Both owners must settle before refreshing after a partial refusal.
        const results = await Promise.allSettled(writes);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (owner.active && ownerRef.current === owner) {
          masterBus.emit('NOTIFICATION_READ', { notifId: id, allRead: id === null });
        }
      } catch (err) {
        if (owner.active && ownerRef.current === owner) {
          // Keep the last confirmed marker until the feed resolves the outcome.
          applyRows(
            rowsRef.current.map((n) => {
              const previous = before.get(n.id);
              return previous ? { ...n, read: previous.read, is_read: previous.is_read } : n;
            }),
            false
          );
          console.warn('[Notifications] mark read failed:', (err as Error)?.message || err);
        }
      } finally {
        owner.mutations.delete(key);
        if (owner.active && ownerRef.current === owner) void refresh();
      }
    },
    [userId, applyRows, refresh]
  );

  const markAllAsRead = useCallback(() => {
    void markAsRead(null);
  }, [markAsRead]);

  const handleDelete = useCallback(
    async (id: string) => {
      const owner = ownerRef.current;
      if (!userId || !owner?.active) return;
      const key = `delete:${id}`;
      if (owner.mutations.has(key)) return;
      owner.mutations.add(key);
      owner.pending = true;
      setDeletingIds((prev) => new Set(prev).add(id));
      const wasUnread = rowsRef.current.some((n) => n.id === id && isUnread(n));
      const synthetic = id.startsWith('poker-');
      try {
        if (!synthetic) {
          const { data } = await supabase.auth.getSession();
          if (!owner.active || ownerRef.current !== owner) return;
          const session = data?.session;
          if (!session?.access_token || session.user.id !== userId) {
            throw new Error('The Dismissal Could Not Verify Your Sign In.');
          }
          const res = await fetch('/api/notifications/delete', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ id }),
          });
          if (!res.ok || !(await res.json())?.success) {
            throw new Error('Notification Dismissal Refused');
          }
        }
        if (!owner.active || ownerRef.current !== owner) return;
        if (synthetic) owner.dismissedSynthetic.add(id);
        // Remove only after confirmation. A refused response cannot race a fade timer.
        applyRows(
          rowsRef.current.filter((n) => n.id !== id),
          false
        );
        if (wasUnread) masterBus.emit('NOTIFICATION_READ', { notifId: id, allRead: false });
      } catch (err) {
        if (owner.active && ownerRef.current === owner) {
          console.warn('[Notifications] delete failed:', (err as Error)?.message || err);
        }
      } finally {
        owner.mutations.delete(key);
        if (owner.active && ownerRef.current === owner) {
          setDeletingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          void refresh();
        }
      }
    },
    [userId, applyRows, refresh]
  );

  /* ── Tap ─────────────────────────────────────────────────────────────
   * No routing rules live here. `link` came from the server-side resolver;
   * all this decides is whether the destination is inside this SPA (a route
   * change, keeping the warm client and its sockets alive) or outside it (a
   * real navigation). */

  const handleTap = useCallback(
    (n: FeedNotification) => {
      if (isUnread(n)) markAsRead(n.id);

      const raw = destinationOf(n);
      if (!raw) {
        // Rendered unclickable, so this is unreachable in practice. It exists
        // so a future type that slips past the resolver fails visibly in the
        // console rather than looking like a broken tap.
        console.warn('[Notifications] No route for type:', n.type, n.id);
        return;
      }

      let path = raw;
      if (path.startsWith('http://') || path.startsWith('https://')) {
        try {
          const url = new URL(path);
          if (url.hostname === window.location.hostname || url.hostname === 'smarter.poker') {
            path = url.pathname + url.search;
          } else {
            openInBrowser(raw);
            return;
          }
        } catch {
          console.warn('[Notifications] Invalid URL:', raw);
          return;
        }
      }

      if (path.startsWith(CA_BASE)) {
        // Strip the basename — react-router re-applies it.
        navigate(path.slice(CA_BASE.length) || '/');
        return;
      }
      leaveForHub(path);
    },
    [markAsRead, navigate]
  );

  /* ── Render ──────────────────────────────────────────────────────── */

  const showSkeleton = loading && notifications.length === 0;

  return (
    <div className="ca-notif">
      <AccountSurfaceHeader
        artwork="images/account/signal-desk-hero-v1.webp"
        eyebrow="Signal Inbox // Live Player Network"
        title="Notifications"
        description="Seat Calls, Tournament Starts, Settlements, Messages And Club Announcements. Tap A Signal To Go Straight To It."
        status={
          error
            ? 'Refresh Needed'
            : loading
              ? 'Synchronizing'
              : userId
                ? connectionStatus
                : 'Sign In Required'
        }
      >
        <span className="ca-notif__heroMetric">
          <small>Unread</small>
          {unreadCount}
        </span>
        <span className="ca-notif__heroMetric">
          <small>Loaded</small>
          {notifications.length}
        </span>
      </AccountSurfaceHeader>

      <div className="ca-notif__bar">
        <div className="ca-notif__filters" role="group" aria-label="Filter Notifications">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All <span>{notifications.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={filter === 'unread'}
            onClick={() => setFilter('unread')}
          >
            Unread <span>{unreadCount}</span>
          </button>
        </div>
        <div className="ca-notif__actions">
          <button type="button" onClick={() => navigate('/settings?tab=notifications')}>
            Alert Controls
          </button>
          {unreadCount > 0 && (
            <button type="button" className="ca-notif__markall" onClick={markAllAsRead}>
              Mark All Read
            </button>
          )}
        </div>
      </div>

      {/* The way back into push enrolment. FirstRunPushPrompt asks once and
        then never again, which is right for a modal and wrong as the only
        door: this page is where somebody goes when they wonder why their
        phone has been quiet. Renders nothing when this device is already
        subscribed or the player has explicitly turned push off. */}
      <PushEnableBanner />

      {error && (
        <div className="ca-notif__empty" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
          >
            Try Again
          </button>
        </div>
      )}
      <div className="ca-notif__list">
        {showSkeleton ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div className="ca-notif__skelRow" key={i} aria-hidden="true">
              <div className="ca-notif__skelAvatar" />
              <div className="ca-notif__skelLines">
                <div className="ca-notif__skelLine ca-notif__skelLine--long" />
                <div className="ca-notif__skelLine ca-notif__skelLine--short" />
              </div>
            </div>
          ))
        ) : error && notifications.length === 0 ? null : notifications.length === 0 ? (
          <div className="ca-notif__empty">
            <h3>No Signals Yet</h3>
            <p>
              Seat Calls, Tournament Starts, Settlements, Friend Requests And Club Announcements
              Will Land Here.
            </p>
          </div>
        ) : visibleNotifications.length === 0 ? (
          <div className="ca-notif__empty" role="status">
            <h3>All Signals Cleared</h3>
            <p>There Are No Unread Notifications.</p>
            <button type="button" onClick={() => setFilter('all')}>
              View All Notifications
            </button>
          </div>
        ) : (
          visibleNotifications.map((n, index) => {
            const unread = isUnread(n);
            const clickable = !!destinationOf(n);
            const { glyph, bg } = categorise(n.type, n.message);
            const rowClass = [
              'ca-notif__row',
              unread ? 'ca-notif__row--unread' : '',
              deletingIds.has(n.id) ? 'ca-notif__row--deleting' : '',
            ]
              .filter(Boolean)
              .join(' ');

            const bucket = dayBucket(n.created_at);
            const previous = index > 0 ? visibleNotifications[index - 1] : null;
            const showHeading = !previous || dayBucket(previous.created_at) !== bucket;

            return (
              <Fragment key={n.id}>
                {showHeading && (
                  <h2 className="ca-notif__day" aria-label={`${bucket} Notifications`}>
                    {bucket}
                  </h2>
                )}
                <article className={rowClass} data-notif-id={n.id}>
                  <button
                    type="button"
                    className={`ca-notif__tap${clickable ? ' ca-notif__tap--clickable' : ''}`}
                    onClick={clickable ? () => handleTap(n) : undefined}
                    disabled={!clickable}
                    aria-label={
                      clickable
                        ? `${n.actor_name || n.title || 'Notification'} ${n.message || ''}. ${timeAgo(n.created_at)}`
                        : undefined
                    }
                  >
                    <div className="ca-notif__avatarWrap">
                      {n.actor_avatar_url ? (
                        <>
                          <img
                            className="ca-notif__avatar"
                            src={n.actor_avatar_url}
                            alt=""
                            loading="lazy"
                            width={54}
                            height={54}
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (img.src !== DEFAULT_AVATAR) img.src = DEFAULT_AVATAR;
                            }}
                          />
                          <span className="ca-notif__badge" style={{ background: bg }}>
                            <CategoryIcon glyph={glyph} />
                          </span>
                        </>
                      ) : (
                        /* A system signal has no actor. It used to borrow the
                           hub's placeholder portrait (a hooded figure), which
                           made every ledger alert look like a stranger's DM.
                           The category plate is the honest face for it. */
                        <span
                          className="ca-notif__systemTile"
                          style={{ borderColor: bg, color: bg }}
                          aria-hidden="true"
                        >
                          <CategoryIcon glyph={glyph} size={22} />
                        </span>
                      )}
                    </div>

                    <div className="ca-notif__body">
                      <div className="ca-notif__text">
                        <span className="ca-notif__actor">{n.actor_name || n.title}</span>{' '}
                        {n.message}
                      </div>
                      <div className="ca-notif__time">{timeAgo(n.created_at)}</div>
                    </div>

                    {unread && <span className="ca-notif__dot" aria-label="Unread" />}
                  </button>
                  <button
                    type="button"
                    className="ca-notif__delete"
                    title="Dismiss"
                    aria-label={`Dismiss ${n.title || n.message || 'Notification'}`}
                    onClick={() => handleDelete(n.id)}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </article>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Matches the World Hub page's format exactly ("Just now", "5m", "2h", "3d")
 * rather than lib/date's formatRelativeShort ("5m ago"), so the two surfaces
 * do not disagree about the same row. Deliberate, not an oversight.
 */
function timeAgo(date: string | null | undefined): string {
  if (!date) return '';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
