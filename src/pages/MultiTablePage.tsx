/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MULTI-TABLE PAGE — Premium-Style Multi-Table Container
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps up to 4 concurrent TablePage instances with:
 * - Top tab bar for switching tables
 * - Horizontal swipe navigation between tables
 * - Auto-switch when action timer is urgent
 * - Add/remove table management
 *
 * URL pattern: /tables (manages its own table instances)
 * Legacy URL: /table/:tableId still routes here with a single table
 */

import React, { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import { matchPath, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { TableTabBar, type TabInfo } from '../components/table/TableTabBar';
import LiveTablesBar from '../components/table/LiveTablesBar';
import { useMasterBusSubscription } from '../hooks/useMasterBusSubscription';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { supabase } from '../lib/supabase';
import './MultiTablePage.css';

// Lazy-load TablePage for code splitting
const TablePage = lazy(() => import('./TablePage'));
// Dan 2026-08-15: the lobby rendered INSIDE a tab, so the in-table "+" can
// show it without navigating away and unmounting the running games.
const HomePage = lazy(() => import('./HomePage'));
/**
 * Dan 2026-08-19: leaving a table must land on the CLUB lobby (the club's game
 * list, BBJ banner and wallet rows), not the pre-lobby landing page with
 * Create/Find/Join. HomePage is the pre-lobby and is now only the fallback for
 * when we genuinely cannot resolve which club the player came from.
 */
const ClubHomePage = lazy(() => import('./ClubHomePage'));
/**
 * Dan 2026-08-19: tournament cards in the in-tab lobby link to
 * /tournaments/:id, a route OUTSIDE table/:tableId — following it unmounted
 * this whole container and killed every live game. The lobby tab now renders
 * TournamentDetails IN PLACE instead (see handleLobbyLinkCapture), so
 * registering for a tournament keeps the other tables dealing.
 */
const TournamentDetails = lazy(() => import('./tournament/TournamentDetails'));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableInstance {
  id: string;
  name: string;
  stakes: string;
  isMyTurn: boolean;
  /** Absolute epoch-ms deadline of the hero's turn on this table. */
  turnDeadlineMs?: number;
  /** Absolute epoch-ms the hero's turn clock started (with the deadline it
   *  drives the depleting timer bar under the tab — PokerBros parity). */
  turnStartMs?: number;
  pot: number;
  /**
   * Hero's hole cards at this table as ONE comma-joined string ("Ah,Qc"; ""
   * when not in a hand or folded). A string, not an array, so
   * updateTableInfo's shallow !== bail-out keeps working (P1-2 fix).
   */
  holeCards?: string;
  /** Hero's last action this street at this table ('fold', 'call', ...). */
  lastAction?: string;
  /**
   * Dan 2026-08-15: a tab is either a live table or a LOBBY placeholder.
   *
   * The in-table "+" opens a `kind: 'lobby'` tab so the player can browse for
   * a second game while their current table keeps dealing in its own tab.
   * When they sit down, TABLE_SEATED converts this tab in place into a
   * `kind: 'table'` tab rather than appending a new one — otherwise picking a
   * game would strand a dead lobby tab and burn one of the 4 slots.
   *
   * Absent means 'table', so every pre-existing construction site stays valid.
   */
  kind?: 'table' | 'lobby';
  /**
   * Dan 2026-08-19: a lobby tab drilled into a tournament. Set when the user
   * taps a tournament card inside the in-tab lobby; the tab then renders
   * TournamentDetails instead of the club lobby so the running tables never
   * unmount. Cleared by the tab's own "back to lobby" affordance, or wholesale
   * when TABLE_SEATED / the route effect converts the lobby tab into a table.
   */
  lobbyTournamentId?: string;
}

/** Lobby tabs carry a synthetic id so they can share the tabs array. */
const LOBBY_TAB_PREFIX = 'lobby:';
const isLobbyTab = (t: TableInstance) => t.kind === 'lobby' || t.id.startsWith(LOBBY_TAB_PREFIX);

const MAX_TABLES = 4;

/**
 * Dan 2026-08-19 (persistence upgrade): what the GLOBAL dock should show while
 * the container is hidden on a non-/table route. Pure so the logic harness
 * can lift it verbatim.
 * - Some table needs the hero's action -> 'urgent' (most pressing deadline
 *   wins): the player must be pulled back before their hand is folded out.
 * - Tables merely running -> 'return': a quiet re-entry affordance.
 * - On /table/* the container itself is visible -> 'none' (no dock).
 */
const dockStateFor = (
  tabs: TableInstance[],
  hidden: boolean,
  nowMs: number,
  lastActiveId?: string
) => {
  if (!hidden) return { kind: 'none' as const };
  const live = tabs.filter((t) => !isLobbyTab(t));
  if (live.length === 0) return { kind: 'none' as const };
  const urgent = live
    .filter((t) => t.isMyTurn)
    .sort((a, b) => (a.turnDeadlineMs ?? Infinity) - (b.turnDeadlineMs ?? Infinity))[0];
  if (urgent) {
    return {
      kind: 'urgent' as const,
      targetId: urgent.id,
      name: urgent.name,
      secondsLeft:
        urgent.turnDeadlineMs !== undefined
          ? Math.max(0, Math.ceil((urgent.turnDeadlineMs - nowMs) / 1000))
          : undefined,
    };
  }
  /**
   * Dan 2026-08-20: the quiet dock used to hand back live[0] — the OLDEST tab —
   * so a player browsing away from table 4 was returned to table 1 and had to
   * find their way back. Prefer the tab they were last looking at.
   */
  const preferred = live.find((t) => t.id === lastActiveId) ?? live[0];
  return { kind: 'return' as const, count: live.length, targetId: preferred.id };
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function MultiTablePage() {
  const { user } = useAuthUser();
  /**
   * Dan 2026-08-19 (persistence upgrade): this container no longer lives under
   * the /table/:tableId route — App.tsx mounts it ONCE via
   * PersistentTableLayer, as a sibling of <Routes>, so navigating ANYWHERE
   * keeps every TablePage (and its EngineStateClient socket) mounted. The
   * route param is therefore derived from the location, and `hidden` collapses
   * the whole container to display:none while the player browses other routes.
   */
  const location = useLocation();
  const routeTableId = matchPath('/table/:tableId', location.pathname)?.params.tableId;
  const hidden = routeTableId === undefined;
  /**
   * The club whose lobby the player should return to. Resolved from the tables
   * they actually sat at, so it survives closing every tab. Kept in state (not
   * just a ref) because the in-tab lobby renders from it.
   */
  const [homeClubId, setHomeClubId] = useState<string | null>(null);
  const homeClubIdRef = useRef<string | null>(null);
  const clubLookupCacheRef = useRef<Map<string, string>>(new Map());
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();

  /**
   * Dan 2026-08-20 (E2E audit): the 4-table device cap used to fail SILENTLY in
   * three places — the route effect, TABLE_SEATED and OPEN_LOBBY_TAB each just
   * `return`ed. Tapping "+" at four tables did nothing at all, and (worst case)
   * a TOURNAMENT table the player was already seated at by the engine could not
   * be opened, so they blinded out of a game they had paid to enter.
   *
   * The cap itself is correct and stays: 4 concurrent tables per device, which
   * is exactly what the server enforces for CASH seats (atomic_table_buyin,
   * v_max_tables = 4, tournament_id IS NULL). Tournament REGISTRATIONS are
   * never capped — thousands are fine — so the only thing the client must do
   * when a fifth table shows up is SAY SO, loudly and specifically, instead of
   * swallowing it. Never auto-close a table to make room: that would cash a
   * player out of a live game without consent.
   */
  /**
   * Throttled PER REASON, not globally.
   *
   * The first version kept one timestamp for all three. That meant a player
   * who tapped "+" and was then seated into a tournament by the engine within
   * four seconds got the trivial "+" notice and had the seating one silently
   * dropped — the one case that actually costs money, suppressed by the one
   * that costs nothing. Exactly the swallowing this function exists to stop.
   *
   * 'seated' is also never suppressed by the others: it is rare, it is the
   * only one the player cannot cause themselves, and missing it means blinding
   * out of a paid tournament.
   */
  const capNoticeAtRef = useRef<Record<string, number>>({});
  const notifyCapReached = useCallback(
    (reason: 'add' | 'route' | 'seated') => {
      const now = Date.now();
      // 'route' and 'add' can fire together for one user action — the route
      // effect and a bus event — so they share a window. 'seated' has its own.
      const key = reason === 'seated' ? 'seated' : 'user-action';
      if (now - (capNoticeAtRef.current[key] ?? 0) < 4000) return;
      capNoticeAtRef.current[key] = now;
      const msg =
        reason === 'seated'
          ? `You are already playing ${MAX_TABLES} tables. Close one to open the table you were just seated at.`
          : `You are playing the maximum of ${MAX_TABLES} tables. Close one first.`;
      toast.warning(msg, 6000);
    },
    [toast]
  );

  // ─── State ───────────────────────────────────────────────────────────
  // FIX: sessionStorage persistence removed — it caused "zombie" tabs to resurrect
  // on every page refresh, compounding the rogue-table problem. Tables are now
  // initialized exclusively from the URL param; they are rebuilt naturally when
  // a user sits down (TABLE_SEATED) or follows a /table/:id link.
  const [tables, setTables] = useState<TableInstance[]>(() => {
    // Clean up any leftover zombie session so old data never re-hydrates
    sessionStorage.removeItem('multi_table_session');
    // Initialize with the table from URL
    if (routeTableId) {
      return [
        {
          id: routeTableId,
          name: searchParams.get('name') || 'Table 1',
          stakes: searchParams.get('stakes') || '',
          isMyTurn: false,
          pot: 0,
        },
      ];
    }
    return [];
  });

  const [activeIndex, setActiveIndex] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isTileView, setIsTileView] = useState(false);
  // Single-table mode: skip entrance animation entirely (prevents blank screen)
  const [tabEntranceComplete, setTabEntranceComplete] = useState(() => tables.length <= 1);

  // Keep a ref to tables for use in bus handlers that may fire between renders
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  // Same for the active index: the route effect intentionally does not depend
  // on it (re-running on every tab switch would fight the router), so it reads
  // the live value through a ref instead of closing over a stale one.
  const activeIndexRef = useRef(0);

  // Swipe tracking refs
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const lastActiveTableIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Tab entrance animation — only used for multi-table mode with tab bar
  useEffect(() => {
    if (tables.length > 1 && !tabEntranceComplete) {
      const timer = setTimeout(() => setTabEntranceComplete(true), 200);
      return () => clearTimeout(timer);
    } else if (tables.length > 0 && !tabEntranceComplete) {
      // Safety: always ensure content becomes visible
      setTabEntranceComplete(true);
    }
  }, [tables.length, tabEntranceComplete]);

  // Listen for table seating events from this user only
  // Type-safe bus handler types (extended beyond base BusPayloadMap)
  interface SeatedPayload {
    tableId: string;
    tableName?: string;
    seat?: number;
    userId?: string; // FIX: added so we can filter to own events only
  }
  interface LeftPayload {
    tableId: string;
  }
  interface HandPayload {
    handId: string;
    tableId: string;
    pot?: number;
  }

  // ─── Rebuild tabs from SERVER TRUTH (2026-08-15 multi-table fix) ─────
  // The add-table flow used to dead-end: the "+" button navigated to the
  // lobby, which unmounted this page and dropped every open tab (the old
  // sessionStorage persistence was removed for causing zombie tabs, and the
  // `returnToMulti` query param it navigated with was read by nothing). The
  // durable source of truth for "which tables am I playing" is the server:
  // every ACTIVE SEAT (table_seats.left_at IS NULL) becomes a tab, additively
  // merged so observer-only tabs (open via URL, not seated) are never
  // removed. Seat at a 2nd/3rd/4th table in the lobby, come back, and every
  // seat is a tab again — the PokerBros flow.
  const droppedRef = useRef(0);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data: seatRows, error: seatErr } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', user.id)
        .is('left_at', null);
      if (cancelled || seatErr || !seatRows || seatRows.length === 0) return;
      const ids = seatRows.map((r) => r.table_id as string).filter(Boolean);
      if (ids.length === 0) return;
      const { data: tblRows } = await supabase
        .from('tables')
        .select('id, name, game_variant, small_blind, big_blind, tournament_id')
        .in('id', ids);
      if (cancelled) return;
      setTables((prev) => {
        const known = new Set(prev.map((t) => t.id));
        const room = Math.max(0, MAX_TABLES - prev.length);
        const candidates = ids.filter((id) => !known.has(id));
        /**
         * Dan 2026-08-20 (audit): this used to `.slice(0, room)` straight off
         * the raw query order — effectively an arbitrary four when a player had
         * more live seats than the device can show, which is entirely possible
         * because the server caps CASH seats at four but never caps tournament
         * seats (registrations are uncapped by design).
         *
         * Arbitrary was the wrong four. A tournament seat cannot be walked away
         * from — miss it and you blind out of something you paid to enter —
         * while a cash seat can be left at any time with the stack refunded. So
         * tournaments are restored first, and if anything still does not fit,
         * the player is told rather than left to discover it.
         */
        const isTourney = (id: string) => !!tblRows?.find((r) => r.id === id)?.tournament_id;
        const ordered = [...candidates].sort((a, b) => {
          const ta = isTourney(a) ? 0 : 1;
          const tb = isTourney(b) ? 0 : 1;
          return ta - tb;
        });
        if (ordered.length > room) droppedRef.current = ordered.length - room;
        const additions = ordered.slice(0, room).map((id, i) => {
          const row = tblRows?.find((r) => r.id === id);
          const stakes =
            row && row.small_blind != null && row.big_blind != null
              ? `${row.small_blind}/${row.big_blind}`
              : '';
          return {
            id,
            name: (row?.name as string) || `Table ${prev.length + i + 1}`,
            stakes,
            isMyTurn: false,
            pot: 0,
          };
        });
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
      // Tell the player OUTSIDE the updater. A setTables callback must stay
      // pure — React may run it twice under StrictMode, and this file has been
      // bitten by side effects in updaters twice already (see TABLE_LEFT and
      // CLOSE_TABLE_TAB above).
      if (!cancelled && droppedRef.current > 0) {
        const n = droppedRef.current;
        droppedRef.current = 0;
        toast.info(
          `You have ${n} more live ${n === 1 ? 'seat' : 'seats'} than this device can show ` +
            `(${MAX_TABLES} at a time). Close a table to bring ${n === 1 ? 'it' : 'them'} in.`,
          7000
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useMasterBusSubscription('TABLE_SEATED', (payload: SeatedPayload) => {
    const e = payload;
    if (!e.tableId) return;

    // FIX: Only open a new tab if THIS user is the one being seated.
    // Without this guard, any other player joining any table on the platform
    // would spawn a rogue tab on the current user's screen.
    if (e.userId && user?.id && e.userId !== user.id) return;

    // Functional updater handles dedup check via prev.find — no closure dep needed
    setTables((prev) => {
      if (prev.find((t) => t.id === e.tableId)) return prev;

      const seatedTab: TableInstance = {
        id: e.tableId,
        name: e.tableName || `Table ${prev.length + 1}`,
        stakes: '',
        isMyTurn: false,
        pot: 0,
        kind: 'table',
      };

      // Dan 2026-08-15: if the player reached this table from a lobby tab
      // opened by the in-table "+", replace that lobby tab IN PLACE. Appending
      // instead would leave a dead lobby tab behind and consume one of the
      // four slots. Oldest lobby tab wins, which is the one they just used.
      const lobbyIdx = prev.findIndex(isLobbyTab);
      if (lobbyIdx !== -1) {
        const next = [...prev];
        next[lobbyIdx] = { ...seatedTab, name: seatedTab.name };
        return next;
      }

      if (prev.length >= MAX_TABLES) {
        // Engine seated us (tournament start, waitlist promotion) but the
        // device is full. Say so — silently dropping this used to leave the
        // player blinding out of a table they could not see.
        notifyCapReached('seated');
        return prev;
      }
      return [...prev, seatedTab];
    });
  });

  // ─── Dan 2026-08-15: in-table "+" → open a lobby tab ──────────────────
  // The old handleAddTable did `navigate('/?returnToMulti=true')`, and nothing
  // in the app ever read `returnToMulti`, so the whole multi-table container
  // unmounted and every open game was torn down. Instead we add a lobby tab
  // beside the running tables and switch to it; the other TablePage instances
  // stay mounted (hidden, not unmounted) and keep their engine sockets alive.
  // A lobby tab has no TablePage behind it, so the tab bar's X — which emits
  // TABLE_MENU_ACTION/FORCE_LEAVE_TABLE for the secure cashout path — has
  // nobody listening and the tab would be unclosable. There are no chips on a
  // lobby tab, so close it directly.
  /**
   * Dan 2026-08-19: leaving a table must CLOSE that table's tab and drop the
   * player back to the lobby — previously the tab stayed open showing the
   * table they had just left. Emitted by the session-summary close handler.
   */
  useMasterBusSubscription(
    'TABLE_MENU_ACTION',
    (payload: { tableId?: string; action?: string }) => {
      if (payload?.action !== 'CLOSE_TABLE_TAB' || !payload.tableId) return;
      // Dan 2026-08-19: this used to call setActiveIndex INSIDE the setTables
      // updater (impure updater — double-fires under StrictMode/concurrent
      // re-basing), and its index math sent anyone LEFT of the closed tab to
      // tab 0 (cur < idx fell through to the `: 0` branch). Compute from the
      // ref, update each piece of state once, keep the math exact.
      const prev = tablesRef.current;
      const idx = prev.findIndex((t) => t.id === payload.tableId);
      if (idx === -1) return;
      const next = prev.filter((t) => t.id !== payload.tableId);
      if (next.length === 0) {
        // Nothing left to play — surface the lobby so there is always
        // somewhere to go next.
        setTables([
          {
            // Dan 2026-08-20: this literal was `as TableInstance` with three
            // required fields missing, so `pot`/`stakes`/`isMyTurn` arrived at
            // TableTabBar as undefined. Construct it whole and drop the cast —
            // the cast was the only reason the compiler stayed quiet.
            id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
            kind: 'lobby',
            name: 'Lobby',
            stakes: '',
            isMyTurn: false,
            pot: 0,
          },
        ]);
        setActiveIndex(0);
        return;
      }
      setTables(next);
      setActiveIndex((cur) => (cur > idx ? cur - 1 : cur === idx ? Math.max(0, cur - 1) : cur));
    }
  );

  useMasterBusSubscription(
    'TABLE_MENU_ACTION',
    (payload: { tableId?: string; action?: string }) => {
      if (!payload?.tableId || !payload.tableId.startsWith(LOBBY_TAB_PREFIX)) return;
      if (payload.action !== 'FORCE_LEAVE_TABLE' && payload.action !== 'LEAVE_TABLE') return;
      const prev = tablesRef.current;
      const idx = prev.findIndex((t) => t.id === payload.tableId);
      if (idx === -1) return;
      setTables(prev.filter((t) => t.id !== payload.tableId));
      setActiveIndex((cur) => (cur > idx ? cur - 1 : cur === idx ? Math.max(0, cur - 1) : cur));
    }
  );

  useMasterBusSubscription('OPEN_LOBBY_TAB', () => {
    const prev = tablesRef.current;
    const existingLobby = prev.findIndex(isLobbyTab);
    if (existingLobby !== -1) {
      // Already have one — just focus it rather than stacking duplicates.
      setActiveIndex(existingLobby);
      return;
    }
    if (prev.length >= MAX_TABLES) {
      notifyCapReached('add');
      return;
    }
    setTables([
      ...prev,
      {
        id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
        name: 'Lobby',
        stakes: '',
        isMyTurn: false,
        pot: 0,
        kind: 'lobby',
      },
    ]);
    setActiveIndex(prev.length);
  });

  useMasterBusSubscription('TABLE_LEFT', (payload: LeftPayload) => {
    const e = payload;
    if (e.tableId) {
      // Dan 2026-08-19: goToLobby() (a navigate call) used to run INSIDE the
      // setTables updater — a side effect in a function React may invoke
      // during render, and twice under StrictMode. Compute outside, then
      // apply each state change once.
      const prev = tablesRef.current;
      const closedIdx = prev.findIndex((t) => t.id === e.tableId);
      if (closedIdx === -1) return;
      const newTables = prev.filter((t) => t.id !== e.tableId);
      setTables(newTables);
      setActiveIndex((prevIdx) => {
        if (closedIdx < prevIdx) return prevIdx - 1;
        if (closedIdx === prevIdx && prevIdx > 0) return prevIdx - 1;
        return prevIdx;
      });
      // If all tables closed, return to the club lobby they came from.
      if (newTables.length === 0) goToLobby();
    }
  });

  useMasterBusSubscription(
    'HAND_COMPLETED',
    (payload: HandPayload) => {
      const e = payload;
      if (e.tableId && typeof e.pot === 'number') {
        setTables((prev) => prev.map((t) => (t.id === e.tableId ? { ...t, pot: e.pot! } : t)));
      }
    },
    { debounce: 300 }
  );

  /**
   * Dan 2026-08-20 (audit): these two handlers used to do
   * `setTables((prev) => [...prev])` with the comment "force re-render to show
   * disconnection indicator". There was no such indicator — TabInfo carries no
   * connection field and TableTabBar rendered none — so the only effect was a
   * brand-new tables array on every realtime blip, re-rendering up to four
   * mounted poker tables for no visual change and defeating the
   * same-reference optimisation in updateTableInfo (the P1-2 fix above).
   *
   * The indicator now actually exists. WS_* describes the SUPABASE REALTIME
   * link (see supabaseConnectionWatchdog — the payload is a url, not a
   * tableId), so it is surfaced honestly as ONE global chip rather than faked
   * per-tab.
   */
  const [realtimeDown, setRealtimeDown] = useState(false);
  useMasterBusSubscription('WS_DISCONNECTED', () => setRealtimeDown(true));
  useMasterBusSubscription('WS_RECONNECTING', () => setRealtimeDown(true));
  useMasterBusSubscription('WS_CONNECTED', () => setRealtimeDown(false));

  // ─── Derived state ───────────────────────────────────────────────────
  const activeTableId = tables[activeIndex]?.id || '';

  // 2026-08-15 multi-table fix: the tab countdown ticks off the server
  // deadline. One 1s clock runs only while some table has a live turn.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyTurnLive = tables.some((t) => t.isMyTurn && t.turnDeadlineMs !== undefined);
  useEffect(() => {
    if (!anyTurnLive) return;
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [anyTurnLive]);
  const secondsLeft = useCallback(
    (t: TableInstance): number | undefined =>
      t.isMyTurn && t.turnDeadlineMs !== undefined
        ? Math.max(0, Math.ceil((t.turnDeadlineMs - nowMs) / 1000))
        : undefined,
    [nowMs]
  );

  const tabInfos: TabInfo[] = useMemo(
    () =>
      tables.map((t) => {
        /**
         * PokerBros parity (Dan 2026-08-20): fraction of the turn clock left,
         * 0..1, driving the depleting bar under the tab. nowMs ticks at 1s
         * while any turn is live; a CSS linear width transition smooths the
         * steps. undefined when it is not the hero's turn at that table.
         */
        let turnProgress: number | undefined;
        if (t.isMyTurn && t.turnDeadlineMs !== undefined && t.turnStartMs !== undefined) {
          const total = t.turnDeadlineMs - t.turnStartMs;
          if (total > 0) {
            turnProgress = Math.max(0, Math.min(1, (t.turnDeadlineMs - nowMs) / total));
          }
        }
        return {
          id: t.id,
          name: t.name,
          stakes: t.stakes,
          isMyTurn: t.isMyTurn,
          timeRemaining: secondsLeft(t),
          turnProgress,
          pot: t.pot,
          holeCards: t.holeCards,
          lastAction: t.lastAction,
        };
      }),
    [tables, secondsLeft, nowMs]
  );

  // ─── Table Management ────────────────────────────────────────────────
  const handleTabSelect = useCallback(
    (tabId: string) => {
      const idx = tables.findIndex((t) => t.id === tabId);
      if (idx !== -1 && idx !== activeIndex) {
        setIsTransitioning(true);
        setActiveIndex(idx);
        setTimeout(() => setIsTransitioning(false), 320);
      }
    },
    [tables, activeIndex]
  );

  const handleAddTable = useCallback(() => {
    if (tables.length >= MAX_TABLES) {
      notifyCapReached('add');
      return;
    }
    // Dan 2026-08-15: was `navigate('/?returnToMulti=true')`. Nothing in the
    // app ever read `returnToMulti`, so this unmounted MultiTablePage and tore
    // down every open game just to browse the lobby. Route it through the same
    // bus event the in-table "+" uses so both entry points behave identically.
    masterBus.emit('OPEN_LOBBY_TAB', {});
  }, [tables.length, notifyCapReached]);

  // ─── Update table info (called by child TablePage instances) ─────────
  // P1-2 FIX: bail out when nothing actually changed so setTables returns the
  // SAME array reference — React then skips the re-render, which breaks the
  // parent-render → new-callback-prop → child-effect → setTables feedback loop
  // that was pegging a CPU core for as long as any table was open.
  const updateTableInfo = useCallback((tableId: string, updates: Partial<TableInstance>) => {
    setTables((prev) => {
      const idx = prev.findIndex((t) => t.id === tableId);
      if (idx === -1) return prev;
      const current = prev[idx];
      let changed = false;
      for (const key of Object.keys(updates) as (keyof TableInstance)[]) {
        if (current[key] !== updates[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev; // no-op → same reference → no re-render
      const next = prev.slice();
      next[idx] = { ...current, ...updates };
      return next;
    });
  }, []);

  // P1-2 FIX: hand each child a STABLE callback (cached per table id) rather than
  // a fresh arrow on every render. A new prop identity was re-triggering the
  // child's reporting effect on every parent render — the other half of the loop.
  const tableInfoCbRef = useRef<Map<string, (info: Partial<TableInstance>) => void>>(new Map());
  /**
   * Resolve which club the open tables belong to, so leaving lands the player
   * in that club's lobby. Cached per table id; the value is sticky so closing
   * the last tab still knows where "home" was.
   */
  useEffect(() => {
    const unresolved = tables
      .filter((t) => !isLobbyTab(t))
      .map((t) => t.id)
      .filter((id) => !clubLookupCacheRef.current.has(id));
    if (unresolved.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.from('tables').select('id, club_id').in('id', unresolved);
        if (cancelled || !data) return;
        for (const row of data as { id: string; club_id: string | null }[]) {
          if (row.club_id) clubLookupCacheRef.current.set(row.id, row.club_id);
        }
        const firstKnown = tables
          .filter((t) => !isLobbyTab(t))
          .map((t) => clubLookupCacheRef.current.get(t.id))
          .find(Boolean);
        if (firstKnown && homeClubIdRef.current !== firstKnown) {
          homeClubIdRef.current = firstKnown;
          setHomeClubId(firstKnown);
        }
      } catch {
        /* lobby routing falls back to the pre-lobby */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tables]);

  /** Where to send a player who has no tables left open. */
  const goToLobby = useCallback(() => {
    const club = homeClubIdRef.current;
    navigate(club ? `/clubs/${club}` : '/');
  }, [navigate]);

  const getTableInfoCb = useCallback(
    (tableId: string) => {
      let cb = tableInfoCbRef.current.get(tableId);
      if (!cb) {
        cb = (info: Partial<TableInstance>) => updateTableInfo(tableId, info);
        tableInfoCbRef.current.set(tableId, cb);
      }
      return cb;
    },
    [updateTableInfo]
  );

  // ─── In-tab lobby rendering (Dan 2026-08-19) ─────────────────────────
  // The lobby tab shows the club's real lobby. Its cash-game cards are
  // <Link to="/table/:id"> — safe, the route effect above converts this tab
  // in place. Its TOURNAMENT cards are <Link to="/tournaments/:id">, a route
  // outside table/:tableId that would unmount this container and kill every
  // live game. Capture those clicks and drill into the tournament INSIDE the
  // tab instead. Everything else (bottom nav, cashier, ...) passes through:
  // leaving is then an explicit user choice, and the server-truth rebuild
  // restores every seat as a tab on the way back.
  const handleLobbyLinkCapture = useCallback((e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/^\/tournaments\/([^/?#]+)/);
    if (!match) return;
    e.preventDefault();
    e.stopPropagation();
    const tournamentId = match[1];
    setTables((prev) =>
      prev.map((t) => (isLobbyTab(t) ? { ...t, lobbyTournamentId: tournamentId } : t))
    );
  }, []);

  const clearLobbyTournament = useCallback((tabId: string) => {
    setTables((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, lobbyTournamentId: undefined } : t))
    );
  }, []);

  /**
   * ─── TAKE SEAT (Dan 2026-08-20) ─────────────────────────────────────────
   * "when you are already sitting at a table but hit the + button to add
   *  another game and you are inside the lobby, there needs to be a 'take
   *  seat' button at the top of the page."
   *
   * The global LiveTablesBar dock covers the case where the player NAVIGATES
   * AWAY from the table container — but dockStateFor returns 'none' whenever
   * the container is visible (`if (!hidden) return { kind: 'none' }`), and the
   * in-tab lobby IS the container, visible, on /table/*. So the one route into
   * the lobby that a seated player takes most often — the in-table "+" — was
   * exactly the route with no way back to their seat except finding the right
   * tab in the tab bar. Their hand can be running while they look.
   *
   * Rendered only when a live table tab actually exists; on a lobby tab that
   * is the player's only tab there is no seat to take and no bar.
   */
  const takeSeatTarget = (() => {
    const live = tables.filter((t) => !isLobbyTab(t));
    if (live.length === 0) return null;
    // Same preference order as the global dock, for one reason: a player who
    // has learnt what "return" does at the dock must not find it means
    // something different here. Turn first (a fold-out clock is running),
    // then the tab they were last on, then the oldest.
    const urgent = live
      .filter((t) => t.isMyTurn)
      .sort((a, b) => (a.turnDeadlineMs ?? Infinity) - (b.turnDeadlineMs ?? Infinity))[0];
    const target = urgent ?? live.find((t) => t.id === lastActiveTableIdRef.current) ?? live[0];
    return {
      target,
      isUrgent: Boolean(urgent),
      seconds: urgent ? secondsLeft(urgent) : undefined,
      liveCount: live.length,
    };
  })();

  const renderTakeSeatBar = () => {
    if (!takeSeatTarget) return null;
    const { target, isUrgent, seconds, liveCount } = takeSeatTarget;
    return (
      <div
        className={`multi-table-page__take-seat${isUrgent ? ' multi-table-page__take-seat--urgent' : ''}`}
      >
        <div className="multi-table-page__take-seat-info">
          <span className="multi-table-page__take-seat-label">
            {isUrgent ? 'Your turn' : liveCount > 1 ? `${liveCount} games running` : 'Game running'}
          </span>
          <span className="multi-table-page__take-seat-name">{target.name}</span>
        </div>
        <button
          type="button"
          className="multi-table-page__take-seat-btn"
          onClick={() => {
            const idx = tables.findIndex((t) => t.id === target.id);
            if (idx !== -1) setActiveIndex(idx);
          }}
        >
          Take Seat
          {isUrgent && seconds !== undefined && (
            <span className="multi-table-page__take-seat-clock">{seconds}s</span>
          )}
        </button>
      </div>
    );
  };

  const renderLobbyTab = (table: TableInstance) =>
    table.lobbyTournamentId ? (
      // Drilling into a tournament from the in-tab lobby strands the player
      // exactly as the lobby itself did, so the bar rides along. It renders in
      // normal flow above the details page; the back-pill is absolute at
      // top:10px and would otherwise sit on top of it, so that branch offsets
      // the pill (see .multi-table-page__lobby-tab--tournament in the CSS).
      <div className="multi-table-page__lobby-tab multi-table-page__lobby-tab--tournament">
        {renderTakeSeatBar()}
        <button
          className="multi-table-page__lobby-back"
          onClick={() => clearLobbyTournament(table.id)}
        >
          ← Lobby
        </button>
        <TournamentDetails tournamentIdOverride={table.lobbyTournamentId} />
      </div>
    ) : (
      <div className="multi-table-page__lobby-tab" onClickCapture={handleLobbyLinkCapture}>
        {renderTakeSeatBar()}
        {homeClubId ? <ClubHomePage clubIdOverride={homeClubId} /> : <HomePage />}
      </div>
    );

  // ─── Auto-switch on urgent timer ─────────────────────────────────────
  // 2026-08-15 fix: this compared against a hardcoded timeRemaining of 15,
  // so it could never fire. Now derived from the real server deadline.
  useEffect(() => {
    // Dan 2026-08-19: only auto-switch the active TAB while the player is
    // actually on /table/*. When they browse elsewhere the global dock
    // surfaces the alert instead — yanking the route out from under them
    // mid-cashier would be hostile.
    if (hidden) return;
    const urgentTable = tables.find((t, idx) => {
      if (idx === activeIndex) return false;
      const left = secondsLeft(t);
      return left !== undefined && left < 5;
    });
    if (urgentTable) {
      const idx = tables.findIndex((t) => t.id === urgentTable.id);
      if (idx !== -1) {
        setIsTransitioning(true);
        setActiveIndex(idx);
        setTimeout(() => setIsTransitioning(false), 320);
      }
    }
  }, [tables, activeIndex, secondsLeft, hidden]);

  // ─── Keyboard shortcuts for table switching ───────────────────────────
  useEffect(() => {
    // Dan 2026-08-19: the container is now ALWAYS mounted; while hidden on
    // another route these shortcuts must not hijack Tab/1-4 from that page.
    if (hidden) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // P1-5 FIX: never hijack keystrokes while the user is typing in an input,
      // textarea, select, or contenteditable (table chat, raise amount, modals),
      // and ignore shortcuts pressed with Ctrl/Meta/Alt. Shift stays allowed for
      // Shift+Tab table cycling.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Number keys 1..MAX_TABLES to switch tables. Derived from the constant
      // rather than a hardcoded '4' so the cap has exactly one definition.
      if (e.key >= '1' && e.key <= String(MAX_TABLES)) {
        const idx = parseInt(e.key) - 1;
        if (idx < tables.length) {
          setActiveIndex(idx);
        }
        return;
      }
      // Tab / Shift+Tab to cycle
      if (e.key === 'Tab') {
        e.preventDefault();
        setActiveIndex((prev) => {
          if (e.shiftKey) {
            return prev <= 0 ? tables.length - 1 : prev - 1;
          }
          return prev >= tables.length - 1 ? 0 : prev + 1;
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tables.length, hidden]);

  // ─── Swipe Gesture Handling ──────────────────────────────────────────
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (tables.length <= 1) return;
      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    },
    [tables.length]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current || tables.length <= 1) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;

      // Only swipe horizontally if horizontal movement > vertical
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
        // Clamp the offset — don't allow overscroll past first/last table
        const maxLeft = activeIndex > 0 ? window.innerWidth * 0.4 : 60;
        const maxRight = activeIndex < tables.length - 1 ? window.innerWidth * 0.4 : 60;
        const clamped = Math.max(-maxRight, Math.min(maxLeft, dx));
        setSwipeOffset(clamped);
      }
    },
    [tables.length, activeIndex]
  );

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current || tables.length <= 1) {
      touchStartRef.current = null;
      return;
    }

    const SWIPE_THRESHOLD = 50;
    const VELOCITY_THRESHOLD = 0.3; // px/ms
    const elapsed = Math.max(Date.now() - touchStartRef.current.time, 1);
    const velocity = Math.abs(swipeOffset) / elapsed;

    let newIndex = activeIndex;

    if (swipeOffset > SWIPE_THRESHOLD || (velocity > VELOCITY_THRESHOLD && swipeOffset > 20)) {
      // Swiped right → go to previous table
      if (activeIndex > 0) {
        newIndex = activeIndex - 1;
      }
    } else if (
      swipeOffset < -SWIPE_THRESHOLD ||
      (velocity > VELOCITY_THRESHOLD && swipeOffset < -20)
    ) {
      // Swiped left → go to next table
      if (activeIndex < tables.length - 1) {
        newIndex = activeIndex + 1;
      }
    }

    if (newIndex !== activeIndex) {
      setIsTransitioning(true);
      setActiveIndex(newIndex);
      setTimeout(() => setIsTransitioning(false), 320);
    }

    setSwipeOffset(0);
    touchStartRef.current = null;
  }, [swipeOffset, activeIndex, tables.length]);

  // ─── Handle route-based table ID changes ─────────────────────────────
  // Dan 2026-08-19: the cash-game cards in the in-tab lobby are plain
  // <Link to="/table/:id"> elements, so "sit at a second table" arrives HERE
  // as a route change — not (yet) as TABLE_SEATED. This effect used to blindly
  // append, which stranded the lobby tab the player had just used: it sat
  // there as a dead "Lobby" tab burning one of the four slots. Convert the
  // lobby tab in place, exactly like the TABLE_SEATED handler does.
  useEffect(() => {
    if (!routeTableId) return;
    const prev = tablesRef.current;
    const existingIdx = prev.findIndex((t) => t.id === routeTableId);
    if (existingIdx !== -1) {
      // Dan 2026-08-19: navigating to a table that is ALREADY mounted (dock
      // click, lobby resume link, browser back) must focus its tab — the
      // container persists now, so "arriving" is a tab switch, not a mount.
      setActiveIndex(existingIdx);
      return;
    }
    const fromUrl: TableInstance = {
      id: routeTableId,
      name: searchParams.get('name') || `Table ${prev.length + 1}`,
      stakes: searchParams.get('stakes') || '',
      isMyTurn: false,
      pot: 0,
      kind: 'table',
    };
    const lobbyIdx = prev.findIndex(isLobbyTab);
    if (lobbyIdx !== -1) {
      const next = [...prev];
      next[lobbyIdx] = fromUrl;
      setTables(next);
      setActiveIndex(lobbyIdx); // focus the table they just picked
    } else if (prev.length < MAX_TABLES) {
      setTables([...prev, fromUrl]);
      setActiveIndex(prev.length); // Switch to new table
    } else {
      /**
       * Dan 2026-08-20 (E2E audit) — THE worst silent failure in this file.
       * At four open tables this branch did not exist: the effect just ended.
       * The URL had already changed to /table/<new>, `hidden` was therefore
       * false, and the container kept rendering whatever tab was active. The
       * player saw a different table than the address bar claimed, with no
       * error and no explanation.
       *
       * It bit tournaments hardest: TournamentDetails sends a player to their
       * seat with navigate(`/table/${myEntry.table_id}`), and the engine seats
       * tournament players without any cap (correct — registrations are
       * uncapped by design). A player at four cash tables therefore could not
       * reach the tournament they had paid to enter, and blinded out.
       *
       * Now: say exactly what is wrong, and put the URL back on the table the
       * player is actually looking at so the two can never disagree.
       */
      notifyCapReached('route');
      const current = prev[activeIndexRef.current] ?? prev[0];
      if (current && !isLobbyTab(current)) navigate(`/table/${current.id}`, { replace: true });
    }
  }, [routeTableId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the last REAL table the player had on screen, so the dock can
  // send them back to it rather than to whichever tab happens to be oldest.
  useEffect(() => {
    if (hidden) return;
    const cur = tables[activeIndex];
    if (cur && !isLobbyTab(cur)) lastActiveTableIdRef.current = cur.id;
  }, [hidden, tables, activeIndex]);

  // ─── Global dock (Dan 2026-08-19) ────────────────────────────────────
  // While hidden on another route, the LiveTablesBar dock is the ONE global
  // affordance: "Return to game" when tables are quietly running, "Action
  // needed" (with the live countdown — nowMs already ticks whenever any
  // turn clock runs) when a hidden table waits on the hero.
  const dock = dockStateFor(tables, hidden, nowMs, lastActiveTableIdRef.current);
  const handleDockReturn = useCallback(
    (tableId: string) => {
      const idx = tablesRef.current.findIndex((t) => t.id === tableId);
      if (idx !== -1) setActiveIndex(idx);
      navigate(`/table/${tableId}`);
    },
    [navigate]
  );

  // ─── Render ──────────────────────────────────────────────────────────
  if (tables.length === 0) {
    // Hidden with nothing mounted: render nothing at all.
    if (hidden) return null;
    return (
      <div className="multi-table-page multi-table-page--empty">
        <p>No tables open</p>
        <button onClick={goToLobby}>Go to Lobby</button>
      </div>
    );
  }

  // FIX-214: CSS transforms create a new containing block for position:fixed
  // descendants, which breaks TablePage's fixed positioning (HUD, menus, overlays).
  // Only use translateX during active swipe gestures (brief/transient).
  // At rest, hide inactive slots with display:none instead.
  const isActivelySwiping = swipeOffset !== 0;
  const containerTransform = isActivelySwiping
    ? `translateX(calc(${-activeIndex * 100}% + ${swipeOffset}px))`
    : 'none';

  return (
    <>
      {hidden && dock.kind !== 'none' && (
        <LiveTablesBar
          tables={tables.filter((t) => !isLobbyTab(t)).map((t) => ({ id: t.id, name: t.name }))}
          urgent={
            dock.kind === 'urgent'
              ? { tableId: dock.targetId, name: dock.name, secondsLeft: dock.secondsLeft }
              : null
          }
          onReturn={handleDockReturn}
        />
      )}
      <div className="multi-table-page" style={hidden ? { display: 'none' } : undefined}>
        {/* Tab Bar */}
        {tables.length > 1 && (
          <div className="multi-table-page__tab-bar-wrapper">
            <TableTabBar
              tabs={tabInfos}
              activeTabId={activeTableId}
              onTabSelect={handleTabSelect}
              onAddTable={handleAddTable}
              maxTables={MAX_TABLES}
              realtimeDown={realtimeDown}
            />
            {tables.length > 1 && (
              <button
                className="tile-toggle-btn"
                onClick={() => setIsTileView((prev) => !prev)}
                title={isTileView ? 'Single view' : 'Tile view'}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  {isTileView ? (
                    <rect
                      x="2"
                      y="2"
                      width="12"
                      height="12"
                      rx="2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  ) : (
                    <>
                      <rect
                        x="2"
                        y="2"
                        width="5"
                        height="5"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                      <rect
                        x="9"
                        y="2"
                        width="5"
                        height="5"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                      <rect
                        x="2"
                        y="9"
                        width="5"
                        height="5"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                      <rect
                        x="9"
                        y="9"
                        width="5"
                        height="5"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                    </>
                  )}
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Tile View Grid or Swipe Container */}
        {isTileView && tables.length > 1 ? (
          <div
            className="multi-table-grid"
            style={{
              opacity: tabEntranceComplete ? 1 : 0,
              transform: tabEntranceComplete ? 'translateY(0)' : 'translateY(12px)',
              transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            {tables.map((table, idx) => (
              <div
                key={table.id}
                className={`multi-table-grid__cell ${idx === activeIndex ? 'multi-table-grid__cell--active' : ''}`}
                onClick={() => {
                  setActiveIndex(idx);
                  setIsTileView(false);
                }}
                style={{
                  boxShadow: idx === activeIndex ? '0 0 20px rgba(0, 212, 255, 0.3)' : 'none',
                  transition: 'box-shadow 0.3s ease',
                }}
              >
                <Suspense fallback={<div className="multi-table-loading">Loading...</div>}>
                  {isLobbyTab(table) ? (
                    renderLobbyTab(table)
                  ) : (
                    <TablePage
                      key={table.id}
                      embeddedTableId={table.id}
                      onTableInfoUpdate={getTableInfoCb(table.id)}
                      isMultiTable={true}
                      isActive={idx === activeIndex && !hidden}
                    />
                  )}
                </Suspense>
              </div>
            ))}
          </div>
        ) : (
          <div
            ref={containerRef}
            className={`multi-table-page__container ${isTransitioning ? 'multi-table-page__container--transitioning' : ''}`}
            style={{
              transform: containerTransform,
              // Single-table: always visible. Multi-table: fade in after tab bar renders.
              opacity: tables.length <= 1 ? 1 : tabEntranceComplete ? 1 : 0,
              transition:
                tabEntranceComplete && !isTransitioning && tables.length > 1
                  ? 'opacity 0.4s ease'
                  : 'none',
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {tables.map((table, idx) => {
              // FIX-214: When not swiping, only render the active slot.
              // During swipe, render adjacent slots for the swipe animation.
              const isActive = idx === activeIndex;
              const isAdjacent = Math.abs(idx - activeIndex) <= 1;
              const shouldRender = isActivelySwiping ? isAdjacent : isActive;

              return (
                <div
                  key={table.id}
                  className={`multi-table-page__table-slot ${isActive ? 'multi-table-page__table-slot--active' : ''}`}
                  style={shouldRender ? undefined : { display: 'none' }}
                >
                  <Suspense
                    fallback={
                      <div className="multi-table-page__loading">
                        <div className="multi-table-page__spinner" />
                        <span
                          style={{
                            color: 'rgba(255,255,255,0.5)',
                            fontSize: '0.85rem',
                            marginTop: 12,
                          }}
                        >
                          Loading table…
                        </span>
                      </div>
                    }
                  >
                    {isLobbyTab(table) ? (
                      renderLobbyTab(table)
                    ) : (
                      <TablePage
                        key={table.id}
                        embeddedTableId={table.id}
                        onTableInfoUpdate={getTableInfoCb(table.id)}
                        // Dan 2026-08-19: while hidden on another route no tab is
                        // "active" — ambient table sounds must not follow the
                        // player into the cashier (isMultiTable true when hidden
                        // so single-table mode is muted too).
                        isMultiTable={tables.length > 1 || hidden}
                        isActive={idx === activeIndex && !hidden}
                      />
                    )}
                  </Suspense>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
