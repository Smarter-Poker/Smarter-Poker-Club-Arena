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
import { useAuthUser } from '../hooks/useAuthUser';
import './MultiTablePage.css';

// Lazy-load TablePage for code splitting
const TablePage = lazy(() => import('./TablePage'));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableInstance {
  id: string;
  name: string;
  stakes: string;
  isMyTurn: boolean;
  timeRemaining?: number;
  pot: number;
}

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

  useMasterBusSubscription('TABLE_SEATED', (payload: SeatedPayload) => {
    const e = payload;
    if (!e.tableId) return;

    // FIX: Only open a new tab if THIS user is the one being seated.
    // Without this guard, any other player joining any table on the platform
    // would spawn a rogue tab on the current user's screen.
    if (e.userId && user?.id && e.userId !== user.id) return;

    // Functional updater handles dedup check via prev.find — no closure dep needed
    setTables((prev) => {
      if (prev.length >= MAX_TABLES || prev.find((t) => t.id === e.tableId)) return prev;
      return [
        ...prev,
        {
          id: e.tableId,
          name: e.tableName || `Table ${prev.length + 1}`,
          stakes: '',
          isMyTurn: false,
          pot: 0,
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

  const tabInfos: TabInfo[] = useMemo(
    () =>
      tables.map((t) => ({
        id: t.id,
        name: t.name,
        stakes: t.stakes,
        isMyTurn: t.isMyTurn,
        timeRemaining: t.timeRemaining,
        pot: t.pot,
      })),
    [tables]
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
    // Navigate to lobby to pick a table
    // The lobby will redirect back here with the new table ID
    navigate('/?returnToMulti=true');
  }, [tables.length, navigate]);

  // ─── Update table info (called by child TablePage instances) ─────────
  const updateTableInfo = useCallback((tableId: string, updates: Partial<TableInstance>) => {
    setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, ...updates } : t)));
  }, []);

  // ─── Auto-switch on urgent timer ─────────────────────────────────────
  useEffect(() => {
    const urgentTable = tables.find(
      (t, idx) =>
        idx !== activeIndex && t.isMyTurn && t.timeRemaining !== undefined && t.timeRemaining < 5
    );
    if (urgentTable) {
      const idx = tables.findIndex((t) => t.id === urgentTable.id);
      if (idx !== -1) {
        setIsTransitioning(true);
        setActiveIndex(idx);
        setTimeout(() => setIsTransitioning(false), 320);
      }
    }
  }, [tables, activeIndex]);

  // ─── Keyboard shortcuts for table switching ───────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
                <TablePage
                  key={table.id}
                  embeddedTableId={table.id}
                  onTableInfoUpdate={(info: Partial<TableInstance>) =>
                    updateTableInfo(table.id, info)
                  }
                  isMultiTable={true}
                />
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
                      style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', marginTop: 12 }}
                    >
                      Loading table…
                    </span>
                  </div>
                }
              >
                <TablePage
                  key={table.id}
                  embeddedTableId={table.id}
                  onTableInfoUpdate={(info: Partial<TableInstance>) =>
                    updateTableInfo(table.id, info)
                  }
                  isMultiTable={tables.length > 1}
                />
              </Suspense>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
