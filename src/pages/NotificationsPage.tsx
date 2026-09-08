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
 *  2. First paint comes from the `sp-notif-cache` entry in localStorage,
 *     read SYNCHRONOUSLY in the useState initializer so rows are present on
 *     frame one rather than after an effect. This is a Vite SPA with no SSR,
 *     so there is no hydration mismatch to guard against.
 *  3. That cache key is the SAME one the World Hub page writes, and we are
 *     same-origin with it, so a user who has opened notifications anywhere on
 *     smarter.poker arrives here with a warm list. We rewrite it on every
 *     successful fetch, keeping the sharing symmetrical.
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
 * Shared with the World Hub notifications page, which writes the same shape
 * to the same key. Same origin, so both surfaces warm each other's first
 * paint. Element 0 carries `_cache_ts`; that is the hub's convention and
 * changing it here would silently halve the sharing.
 */
const CACHE_KEY = 'sp-notif-cache';
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
function readCache(): FeedNotification[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
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

function writeCache(rows: FeedNotification[]): void {
  try {
    const now = Date.now();
    localStorage.setItem(
      CACHE_KEY,
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

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();

  // Painted on frame one. See the header note: synchronous by design.
  const [notifications, setNotifications] = useState<FeedNotification[]>(readCache);
  const [loading, setLoading] = useState(() => readCache().length === 0);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    document.title = 'Notifications | Smarter Poker';
  }, []);

  const unreadCount = useMemo(() => notifications.filter(isUnread).length, [notifications]);
  const visibleNotifications = useMemo(
    () => (filter === 'unread' ? notifications.filter(isUnread) : notifications),
    [filter, notifications]
  );

  /* ── Refresh from the one feed endpoint ──────────────────────────── */

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        if (mounted.current) setLoading(false);
        return;
      }

      const res = await fetch('/api/notifications/feed?limit=50', {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!res.ok) {
        // Keep whatever is already on screen; a stale list beats a blank one.
        if (mounted.current) setLoading(false);
        return;
      }

      const json = await res.json();
      if (!json?.success || !Array.isArray(json.notifications)) {
        if (mounted.current) setLoading(false);
        return;
      }

      const rows = json.notifications as FeedNotification[];
      if (mounted.current) {
        setNotifications(rows);
        setLoading(false);
      }
      writeCache(rows);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        console.warn('[Notifications] refresh failed:', (err as Error)?.message || err);
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
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
        if (!token || cancelled) return;
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
  }, []);

  /* ── Realtime INSERT ─────────────────────────────────────────────────
   * A row arriving straight from Postgres has NOT passed through the feed
   * API, so nothing has resolved a destination for it. It carries whatever
   * `link` / `action_url` the producer wrote and nothing more. Rather than
   * re-deriving a route here — which is exactly the duplicate-resolver bug
   * that made 1219 rows dead — we prepend it for visibility and let the
   * next refresh replace it with the resolved version. */

  const handleInsert = useCallback(
    (payload: { new: Record<string, unknown> }) => {
      const n = payload?.new as unknown as FeedNotification | undefined;
      if (!n?.id || !mounted.current) return;
      setNotifications((prev) => {
        if (prev.some((p) => p.id === n.id)) return prev;
        return [{ ...n, actor_name: n.actor_name || n.title || 'New Notification' }, ...prev];
      });
      // Pull the resolved row in so the newest notification is not the only
      // one in the list that cannot be tapped.
      refresh();
    },
    [refresh]
  );

  useMasterBusChannel({
    // Distinct from NotificationDropdown's `notifications:${id}` channel —
    // two subscribers on one channel name would fight over the same handle.
    channelName: user?.id ? `ca-notif-page:${user.id}` : null,
    table: 'notifications',
    filter: user?.id ? `user_id=eq.${user.id}` : null,
    event: 'INSERT',
    onPayload: handleInsert,
    enabled: !!user?.id,
  });

  /* ── Read / dismiss ──────────────────────────────────────────────── */

  const markAsRead = useCallback((id: string) => {
    let wasUnread = false;
    setNotifications((prev) => {
      wasUnread = prev.some((n) => n.id === id && isUnread(n));
      if (!wasUnread) return prev;
      const next = prev.map((n) => (n.id === id ? { ...n, read: true, is_read: true } : n));
      writeCache(next);
      return next;
    });
    if (!wasUnread) return;

    masterBus.emit('NOTIFICATION_READ', { notifId: id, allRead: false });
    supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id)
      .then(({ error }) => {
        if (error) console.warn('[Notifications] mark read failed:', error.message);
      });
  }, []);

  const markAllAsRead = useCallback(() => {
    if (!user?.id) return;
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true, is_read: true }));
      writeCache(next);
      return next;
    });
    masterBus.emit('NOTIFICATION_READ', { notifId: null, allRead: true });
    supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', user.id)
      .eq('read', false)
      .then(({ error }) => {
        if (error) console.warn('[Notifications] mark all read failed:', error.message);
      });
  }, [user?.id]);

  const handleDelete = useCallback(
    async (id: string) => {
      // Fade out first so the row does not vanish under the finger.
      setDeletingIds((prev) => new Set(prev).add(id));

      let wasUnread = false;
      setNotifications((prev) => {
        wasUnread = prev.some((n) => n.id === id && isUnread(n));
        return prev;
      });
      if (wasUnread) masterBus.emit('NOTIFICATION_READ', { notifId: id, allRead: false });

      window.setTimeout(() => {
        if (!mounted.current) return;
        setNotifications((prev) => {
          const next = prev.filter((n) => n.id !== id);
          writeCache(next);
          return next;
        });
        setDeletingIds((prev) => {
          const s = new Set(prev);
          s.delete(id);
          return s;
        });
      }, 300);

      // Synthetic poker-prefixed ids have no row to delete.
      if (id.startsWith('poker-')) return;

      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        const res = await fetch('/api/notifications/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ id }),
        });
        // The server refused. Re-sync rather than guess — the row may still
        // exist, and inventing a rollback here would be a second source of
        // truth about what the list contains.
        if (!res.ok) refresh();
      } catch (err) {
        console.warn('[Notifications] delete failed:', (err as Error)?.message || err);
        refresh();
      }
    },
    [refresh]
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
            window.open(raw, '_blank', 'noopener,noreferrer');
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
      window.location.href = path;
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
        status={loading ? 'Synchronizing' : 'Live Feed'}
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
        ) : notifications.length === 0 ? (
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
