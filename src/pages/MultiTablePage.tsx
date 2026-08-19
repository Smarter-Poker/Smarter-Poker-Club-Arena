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
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { TableTabBar, type TabInfo } from '../components/table/TableTabBar';
import { useMasterBusSubscription } from '../hooks/useMasterBusSubscription';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import './MultiTablePage.css';

// Lazy-load TablePage for code splitting
const TablePage = lazy(() => import('./TablePage'));
// Dan 2026-08-15: the lobby rendered INSIDE a tab, so the in-table "+" can
// show it without navigating away and unmounting the running games.
const HomePage = lazy(() => import('./HomePage'));

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
  pot: number;
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
}

/** Lobby tabs carry a synthetic id so they can share the tabs array. */
const LOBBY_TAB_PREFIX = 'lobby:';
const isLobbyTab = (t: TableInstance) => t.kind === 'lobby' || t.id.startsWith(LOBBY_TAB_PREFIX);

const MAX_TABLES = 4;

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function MultiTablePage() {
  const { user } = useAuthUser();
  const { tableId: routeTableId } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

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

  // Swipe tracking refs
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
        .select('id, name, game_variant, small_blind, big_blind')
        .in('id', ids);
      if (cancelled) return;
      setTables((prev) => {
        const known = new Set(prev.map((t) => t.id));
        const room = Math.max(0, MAX_TABLES - prev.length);
        const additions = ids
          .filter((id) => !known.has(id))
          .slice(0, room)
          .map((id, i) => {
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
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

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

      if (prev.length >= MAX_TABLES) return prev;
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
      setTables((prev) => {
        const idx = prev.findIndex((t) => t.id === payload.tableId);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== payload.tableId);
        setActiveIndex((cur) => (cur >= idx && cur > 0 ? cur - 1 : 0));
        // Nothing left to play — surface the lobby so there is always
        // somewhere to go next.
        if (next.length === 0) {
          return [
            {
              id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
              kind: 'lobby',
              name: 'Lobby',
            } as TableInstance,
          ];
        }
        return next;
      });
    }
  );

  useMasterBusSubscription(
    'TABLE_MENU_ACTION',
    (payload: { tableId?: string; action?: string }) => {
      if (!payload?.tableId || !payload.tableId.startsWith(LOBBY_TAB_PREFIX)) return;
      if (payload.action !== 'FORCE_LEAVE_TABLE' && payload.action !== 'LEAVE_TABLE') return;
      setTables((prev) => {
        const idx = prev.findIndex((t) => t.id === payload.tableId);
        if (idx === -1) return prev;
        setActiveIndex((cur) => (cur >= idx && cur > 0 ? cur - 1 : cur));
        return prev.filter((t) => t.id !== payload.tableId);
      });
    }
  );

  useMasterBusSubscription('OPEN_LOBBY_TAB', () => {
    setTables((prev) => {
      const existingLobby = prev.findIndex(isLobbyTab);
      if (existingLobby !== -1) {
        // Already have one — just focus it rather than stacking duplicates.
        setActiveIndex(existingLobby);
        return prev;
      }
      if (prev.length >= MAX_TABLES) return prev;
      setActiveIndex(prev.length);
      return [
        ...prev,
        {
          id: `${LOBBY_TAB_PREFIX}${Date.now()}`,
          name: 'Lobby',
          stakes: '',
          isMyTurn: false,
          pot: 0,
          kind: 'lobby',
        },
      ];
    });
  });

  useMasterBusSubscription('TABLE_LEFT', (payload: LeftPayload) => {
    const e = payload;
    if (e.tableId) {
      setTables((prev) => {
        const newTables = prev.filter((t) => t.id !== e.tableId);
        // If all tables closed, navigate to lobby
        if (newTables.length === 0) {
          navigate('/');
        }
        return newTables;
      });
      // Adjust activeIndex to prevent out-of-bounds or pointing at wrong tab
      setActiveIndex((prevIdx) => {
        const currentTables = tablesRef.current;
        const closedIdx = currentTables.findIndex((t) => t.id === e.tableId);
        if (closedIdx === -1) return prevIdx;
        if (closedIdx < prevIdx) return prevIdx - 1;
        if (closedIdx === prevIdx && prevIdx > 0) return prevIdx - 1;
        return prevIdx;
      });
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

  useMasterBusSubscription('WS_DISCONNECTED', () => {
    // Force re-render to show disconnection indicator
    setTables((prev) => [...prev]);
  });

  useMasterBusSubscription('WS_RECONNECTING', () => {
    setTables((prev) => [...prev]);
  });

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
      tables.map((t) => ({
        id: t.id,
        name: t.name,
        stakes: t.stakes,
        isMyTurn: t.isMyTurn,
        timeRemaining: secondsLeft(t),
        pot: t.pot,
      })),
    [tables, secondsLeft]
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
    if (tables.length >= MAX_TABLES) return;
    // Dan 2026-08-15: was `navigate('/?returnToMulti=true')`. Nothing in the
    // app ever read `returnToMulti`, so this unmounted MultiTablePage and tore
    // down every open game just to browse the lobby. Route it through the same
    // bus event the in-table "+" uses so both entry points behave identically.
    masterBus.emit('OPEN_LOBBY_TAB', {});
  }, [tables.length]);

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

  // ─── Auto-switch on urgent timer ─────────────────────────────────────
  // 2026-08-15 fix: this compared against a hardcoded timeRemaining of 15,
  // so it could never fire. Now derived from the real server deadline.
  useEffect(() => {
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
  }, [tables, activeIndex, secondsLeft]);

  // ─── Keyboard shortcuts for table switching ───────────────────────────
  useEffect(() => {
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
      // Number keys 1-4 to switch tables
      if (e.key >= '1' && e.key <= '4') {
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
  }, [tables.length]);

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
  useEffect(() => {
    if (routeTableId && !tables.find((t) => t.id === routeTableId)) {
      // New table from URL — add it if room
      if (tables.length < MAX_TABLES) {
        setTables((prev) => [
          ...prev,
          {
            id: routeTableId,
            name: searchParams.get('name') || `Table ${prev.length + 1}`,
            stakes: searchParams.get('stakes') || '',
            isMyTurn: false,
            pot: 0,
          },
        ]);
        setActiveIndex(tables.length); // Switch to new table
      }
    }
  }, [routeTableId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ──────────────────────────────────────────────────────────
  if (tables.length === 0) {
    return (
      <div className="multi-table-page multi-table-page--empty">
        <p>No tables open</p>
        <button onClick={() => navigate('/')}>Go to Lobby</button>
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
    <div className="multi-table-page">
      {/* Tab Bar */}
      {tables.length > 1 && (
        <div className="multi-table-page__tab-bar-wrapper">
          <TableTabBar
            tabs={tabInfos}
            activeTabId={activeTableId}
            onTabSelect={handleTabSelect}
            onAddTable={handleAddTable}
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
                  <div className="multi-table-page__lobby-tab">
                    <HomePage />
                  </div>
                ) : (
                  <TablePage
                    key={table.id}
                    embeddedTableId={table.id}
                    onTableInfoUpdate={getTableInfoCb(table.id)}
                    isMultiTable={true}
                    isActive={idx === activeIndex}
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
                    <div className="multi-table-page__lobby-tab">
                      <HomePage />
                    </div>
                  ) : (
                    <TablePage
                      key={table.id}
                      embeddedTableId={table.id}
                      onTableInfoUpdate={getTableInfoCb(table.id)}
                      isMultiTable={tables.length > 1}
                      isActive={idx === activeIndex}
                    />
                  )}
                </Suspense>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
