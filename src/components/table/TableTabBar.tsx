/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE TAB BAR — Premium-Style Multi-Table Navigation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Top tab strip for switching between up to 4 concurrent tables.
 * Features:
 * - Pill-shaped tabs with table name
 * - Active tab highlighted
 * - Pulsing indicator when action is on you at another table
 * - Timer countdown on tabs where it's your turn
 * - "+" button to add new tables (up to 4)
 * - Jackpot badge inline
 */

import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import TableMenu, { createDefaultMenuSections, type MenuSection } from './TableMenu';
import { TileViewIcon } from './TableMenuIcons';
import { masterBus } from '../../core/MasterBus';
import { formatGameTitle } from '../../utils/formatGameTitle';
import { useButtonImage } from '../../hooks/useButtonImage';
import './TableTabBar.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TabInfo {
  id: string;
  name: string; // e.g., "NLH 1/2" or "PLO4 Hi"
  stakes: string; // e.g., "1/2" or "0.05/0.10"
  isMyTurn: boolean;
  timeRemaining?: number; // Seconds remaining when it's your turn
  /** Fraction of the turn clock remaining (0..1) — drives the depleting
   *  timer bar under the tab. undefined when it is not your turn there. */
  turnProgress?: number;
  pot?: number;
  isAutoRebuyEnabled?: boolean;
  standUpNextBB?: boolean;
  soundEnabled?: boolean;
  vibrationsEnabled?: boolean;
  /**
   * PokerBros parity: the hero's hole cards at this table, comma-joined
   * ("Ah,Qc" / "Td,9h"; "" or undefined when not in a hand or folded).
   * When present the tab renders mini cards instead of the table name.
   */
  holeCards?: string;
  /** Hero's last action this street ('fold', 'call', ...) for the
   *  transient badge under the tab. */
  lastAction?: string;
  /** Hero folded this hand — the tab dims (roadmap batch 1). */
  folded?: boolean;
  /** Showdown outcome edge: "win:<hand>" / "loss:<hand>" / "". The tab
   *  pulses green/red for a moment so a background table's result is
   *  visible without switching. */
  handResult?: string;
  /** Hero is sitting out at this table (long-press menu label). */
  sittingOut?: boolean;
  /**
   * Seconds until this table's SIT-OUT clock runs out, cash tables only.
   *
   * PRECOMPUTED by the parent, exactly like `decisionSecondsLeft` and
   * `timeBankSecondsLeft` — this bar has no clock of its own and should not
   * grow one, and MultiTablePage is already ticking for the dock.
   *
   * The tab is the only thing a multi-tabling player can see of a table they
   * are not looking at, and until 2026-08-29 it said nothing at all about a
   * seat being reclaimed: a player could tap Sit Out At All Tables, start six
   * five-minute clocks, and watch none of them. TIME BANK and a pending
   * decision both already get a countdown here; losing a seat is worth more
   * than either.
   */
  sitOutSecondsLeft?: number;
  /**
   * Dan 2026-08-21: the short game code - NLH / PLO / PLO5 / PLO6 / SPIN /
   * MTT / SNG / HU. This is the tab's PRIMARY label whenever no hand is
   * live: a 100px pill cannot carry a table name, and the name is the least
   * reliable thing about a table anyway (club owners type them).
   */
  gameCode?: string;
  /**
   * Dan 2026-08-21: a timed NON-TURN decision open at this table. These used
   * to be completely invisible on a background tab - the modal is mounted in a
   * display:none subtree, so the clock ran out and the engine decided for you.
   */
  decisionKind?: 'discard' | 'insurance' | 'rit';
  /** Seconds left on that decision. */
  decisionSecondsLeft?: number;
  /** Seconds left on a BURNING time bank at this table (auto time bank on). */
  timeBankSecondsLeft?: number;
  /**
   * Does the hero hold an ACTIVE SEAT at this table?
   *
   * Dan 2026-08-26: "the action bar on top of the playing page should not ever
   * flash or change anything when you're on a table observing. It should just
   * say the game and the stakes."
   *
   * Mirrors TableInstance.seated: true only from TABLE_SEATED or the
   * server-truth rebuild reading table_seats WHERE left_at IS NULL. Undefined
   * reads as "not seated", which is the safe default for a flag whose job is
   * to decide whether the tab is allowed to move.
   */
  seated?: boolean;
}

/** What a pending decision is called on the pill. Short: it shares ~100px. */
const DECISION_LABEL: Record<string, string> = {
  discard: 'DISCARD',
  insurance: 'INSURE',
  rit: 'RUN IT',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MINI HOLE-CARD PREVIEW (PokerBros parity — Dan 2026-08-20, from live footage)
// ═══════════════════════════════════════════════════════════════════════════════

/** 4-color deck, matching the reference footage: spades black, hearts red,
 *  diamonds blue, clubs green. Unicode suit symbols, NOT emoji (SWC-safe;
 *  same glyphs SeatSlot/CardImage already use). */
const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_CLASS: Record<string, string> = {
  s: 'table-tab-bar__mini-card--s',
  h: 'table-tab-bar__mini-card--h',
  d: 'table-tab-bar__mini-card--d',
  c: 'table-tab-bar__mini-card--c',
};

/** Memoized (roadmap batch 1): the container's 1s turn clock rebuilds
 *  tabInfos every tick, and without the memo every tick re-rendered the
 *  card DOM of every tab for no visual change. */
const MiniCards = React.memo(function MiniCards({ cards }: { cards: string }) {
  const parsed = cards
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length >= 2);
  if (parsed.length === 0) return null;
  // Dan 2026-08-25: two size steps, not one. On a 375px phone a pill is ~55px
  // wide, and PLO6's SIX cards have to live in that; sizing PLO4 and PLO6 the
  // same meant either PLO6 clipped or PLO4 was needlessly tiny. `--wide` is
  // the 3-4 card step, `--xwide` the 5-6 card one. Both classes are applied at
  // 5+, so `--xwide` only has to override the two dimensions that differ.
  const sizeClasses = [
    parsed.length > 2 && 'table-tab-bar__mini-cards--wide',
    parsed.length > 4 && 'table-tab-bar__mini-cards--xwide',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={`table-tab-bar__mini-cards${sizeClasses ? ` ${sizeClasses}` : ''}`}
      aria-hidden="true"
    >
      {parsed.map((c, i) => {
        const rank = c.slice(0, -1);
        const suit = c.slice(-1).toLowerCase();
        return (
          <span key={i} className={`table-tab-bar__mini-card ${SUIT_CLASS[suit] ?? ''}`}>
            <span className="table-tab-bar__mini-card-rank">{rank === 'T' ? '10' : rank}</span>
            <span className="table-tab-bar__mini-card-suit">{SUIT_GLYPH[suit] ?? ''}</span>
          </span>
        );
      })}
    </span>
  );
});

/** Display labels for the transient last-action chip. */
const ACTION_LABEL: Record<string, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
  all_in: 'All In',
  /* PHASE 3 AUDIT 2026-08-31. The fallback below is `ACTION_LABEL[flash] ?? flash`,
     i.e. the RAW engine token, so a missing entry ships a lowercase word to the
     tab strip - and CLAUDE.md 5.7 is Title Case Every Word. 'discard' was
     unreachable here until Phase 3, because nothing on the client ever put it
     in lastActions; now the engine records it and the hero's own click sets it,
     so this tab would have flashed "discard". */
  discard: 'Discard',
};

export interface TableTabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onAddTable: () => void;
  /**
   * Dan 2026-09-04: the "+" long-press / right-click menu. A tap on "+" is
   * still the Quick Join sheet; holding it offers the lobby and World Hub
   * pages directly, in a NEW tab, so a player on a felt reaches Social or
   * Messages in one gesture. Both optional: without them "+" is only a tap.
   */
  onOpenLobby?: () => void;
  onOpenHub?: (path: string) => void;
  maxTables?: number;
  /** Batch 3: reorder a tab to a new index (drag on desktop, long-press
   *  menu Move Left/Right everywhere). */
  onReorder?: (fromId: string, toIndex: number) => void;
  /** Batch 3: per-table muted ids (audio only). */
  mutedIds?: string[];
  /** Batch 3: long-press quick actions. */
  onQuickAction?: (
    tabId: string,
    action: 'sitout' | 'back' | 'leave' | 'mute' | 'reload' | 'open-browser'
  ) => void;
  /** Batch 3: one-tap sit out / return across every seated table. */
  onSitOutAll?: () => void;
  onBackAll?: () => void;
  /** Dan 2026-08-30: hamburger switch "Multi Table Profit Tracking". */
  profitTrackingEnabled?: boolean;
  onToggleProfitTracking?: () => void;
  /**
   * TILE VIEW, MOVED OFF THE STRIP (Dan 2026-09-07, item 1).
   *
   * "THE 4 SQUARE OPTION NEEDS TO LIVE INSIDE THE HAMBURGER MENU, NOT ON THE
   *  SCREEN IN THE ACTION HEADER, CHANGE THAT GLOBALLY."
   *
   * The control itself is unchanged - it still only toggles MultiTablePage's
   * `isTileView` - but it is a menu item now rather than a 46px button
   * competing with the game pills for the 375px budget documented in
   * TableTabBar.css.
   *
   * `canToggleTileView` is false with one table open: tile view of a single
   * table is the view you are already in. The item is DISABLED rather than
   * hidden, because a control that vanishes teaches nobody where it went -
   * the same reason the old button rendered `--inert` instead of unmounting.
   */
  isTileView?: boolean;
  canToggleTileView?: boolean;
  onToggleTileView?: () => void;
  /**
   * Supabase realtime link is down or reconnecting. Multi-tabling players
   * cannot otherwise tell that their tables have stopped receiving updates —
   * every tab looks identical to a healthy one.
   */
  realtimeDown?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableTabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onAddTable,
  onOpenLobby,
  onOpenHub,
  maxTables = 4,
  realtimeDown = false,
  onReorder,
  mutedIds,
  onQuickAction,
  onSitOutAll,
  onBackAll,
  profitTrackingEnabled,
  onToggleProfitTracking,
  isTileView = false,
  canToggleTileView = false,
  onToggleTileView,
}: TableTabBarProps) {
  const emptySlots = maxTables - tabs.length;
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  /* Dan 2026-08-28 round 2: the add-table + is the EXACT artwork from his
     reference image — assets/buttons/{black|blue}/icon-addscreen.webp, the
     same asset the in-table HUD add-screen button renders, so the two entry
     points are pixel-identical and both follow the blue-buttons setting.
     (The storage copies were re-exported with real alpha on 2026-08-28, so
     no black canvas rides along.) ButtonImagePreloader already warms this
     file. If the image fails to load — offline, storage outage — the inline
     metallic SVG below takes over rather than leaving a dead blank control. */
  const addScreenIcon = useButtonImage('icon-addscreen');
  const [addIconFailed, setAddIconFailed] = useState(false);

  // ─── Transient last-action chips (PokerBros parity, Dan 2026-08-20) ───
  // When a tab's lastAction changes to a new non-empty value, flash it on the
  // tab for 2.5s, then clear. Timers live in a ref keyed by tab id so a
  // re-render (the turn clock ticks tabs every second) never cancels a
  // pending expiry — an effect-cleanup clearTimeout here would leave chips
  // stuck on screen whenever the clock was running.
  const [actionFlash, setActionFlash] = useState<Record<string, string>>({});
  const prevActionsRef = useRef<Record<string, string>>({});
  const flashTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    for (const tab of tabs) {
      const prev = prevActionsRef.current[tab.id] ?? '';
      const cur = tab.lastAction ?? '';
      if (cur && cur !== prev) {
        setActionFlash((p) => ({ ...p, [tab.id]: cur }));
        clearTimeout(flashTimersRef.current[tab.id]);
        flashTimersRef.current[tab.id] = setTimeout(() => {
          setActionFlash((p) => {
            if (!(tab.id in p)) return p;
            const next = { ...p };
            delete next[tab.id];
            return next;
          });
        }, 2500);
      }
      prevActionsRef.current[tab.id] = cur;
    }
    // Audit 2026-08-20: closing a tab left its entries behind in all three
    // stores forever (and a pending timer could later setState for a tab that
    // no longer exists). Prune everything keyed by an id that is gone.
    const liveIds = new Set(tabs.map((t) => t.id));
    for (const id of Object.keys(prevActionsRef.current)) {
      if (!liveIds.has(id)) {
        delete prevActionsRef.current[id];
        clearTimeout(flashTimersRef.current[id]);
        delete flashTimersRef.current[id];
        setActionFlash((p) => {
          if (!(id in p)) return p;
          const next = { ...p };
          delete next[id];
          return next;
        });
      }
    }
  }, [tabs]);
  // Clear all pending flash timers on unmount only.
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  // ─── Showdown result flash (roadmap batch 1) ──────────────────────────
  // Same rising-edge machinery as the action chips: when a tab's handResult
  // becomes a new non-empty value, pulse the tab green (win) or red (loss)
  // for 2.5s. Timers in a ref so the 1s clock cannot cancel a pending expiry.
  const [resultFlash, setResultFlash] = useState<Record<string, 'win' | 'loss'>>({});
  const prevResultsRef = useRef<Record<string, string>>({});
  const resultTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    for (const tab of tabs) {
      const prev = prevResultsRef.current[tab.id] ?? '';
      const cur = tab.handResult ?? '';
      if (cur && cur !== prev) {
        const kind: 'win' | 'loss' = cur.startsWith('win') ? 'win' : 'loss';
        setResultFlash((p) => ({ ...p, [tab.id]: kind }));
        clearTimeout(resultTimersRef.current[tab.id]);
        resultTimersRef.current[tab.id] = setTimeout(() => {
          setResultFlash((p) => {
            if (!(tab.id in p)) return p;
            const next = { ...p };
            delete next[tab.id];
            return next;
          });
        }, 2500);
      }
      prevResultsRef.current[tab.id] = cur;
    }
    const liveIds = new Set(tabs.map((t) => t.id));
    for (const id of Object.keys(prevResultsRef.current)) {
      if (!liveIds.has(id)) {
        delete prevResultsRef.current[id];
        clearTimeout(resultTimersRef.current[id]);
        delete resultTimersRef.current[id];
      }
    }
  }, [tabs]);
  useEffect(() => {
    const timers = resultTimersRef.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const timeouts = tabs.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [tabs.length]);

  // ─── Batch 3: long-press quick menu + mouse drag-to-reorder ───────────
  // Touch drag fights the strip's own horizontal scroll, so touch gets the
  // long-press menu (with Move Left/Right) and the mouse gets live dragging.
  const [quickMenu, setQuickMenu] = useState<{ tabId: string; left: number; top: number } | null>(
    null
  );
  const [dragState, setDragState] = useState<{ id: string; dx: number } | null>(null);
  const gestureRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    suppressClick: boolean;
    isMouse: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const tabsRowRef = useRef<HTMLDivElement>(null);

  const openQuickMenu = useCallback((tabId: string, anchor: DOMRect) => {
    const MENU_W = 200;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_W - 8));
    setQuickMenu({ tabId, left, top: anchor.bottom + 6 });
  }, []);

  /* The "+" button's own menu (Dan 2026-09-04): long-press or right-click.
     Separate from the pill gesture above because "+" is not a pill - it does
     not drag, it does not reorder, and its tap already has a meaning. */
  const [addMenu, setAddMenu] = useState<{ left: number; top: number } | null>(null);
  const addPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({
    timer: null,
    fired: false,
  });
  const hasAddMenu = !!(onOpenLobby || onOpenHub);
  const openAddMenu = useCallback((anchor: DOMRect) => {
    const MENU_W = 200;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_W - 8));
    setAddMenu({ left, top: anchor.bottom + 6 });
  }, []);
  const handleAddPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!hasAddMenu || e.button !== 0) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const a = addPressRef.current;
      if (a.timer) clearTimeout(a.timer);
      a.fired = false;
      a.timer = setTimeout(() => {
        a.timer = null;
        a.fired = true;
        openAddMenu(rect);
      }, 500);
    },
    [hasAddMenu, openAddMenu]
  );
  const cancelAddPress = useCallback(() => {
    const a = addPressRef.current;
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
  }, []);
  const handleAddClick = useCallback(() => {
    const a = addPressRef.current;
    cancelAddPress();
    // The long-press opened the menu; the click that follows the release is
    // the same gesture, not a second request for Quick Join.
    if (a.fired) {
      a.fired = false;
      return;
    }
    onAddTable();
  }, [cancelAddPress, onAddTable]);
  const handleAddContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasAddMenu) return;
      e.preventDefault();
      cancelAddPress();
      openAddMenu((e.currentTarget as HTMLElement).getBoundingClientRect());
    },
    [hasAddMenu, cancelAddPress, openAddMenu]
  );

  const endGesture = useCallback(() => {
    const g = gestureRef.current;
    if (g?.longPressTimer) clearTimeout(g.longPressTimer);
    gestureRef.current = null;
    setDragState(null);
  }, []);

  const handleTabPointerDown = useCallback(
    (e: React.PointerEvent, tabId: string) => {
      if (e.button !== 0) return;
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const g = {
        id: tabId,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        suppressClick: false,
        isMouse: e.pointerType === 'mouse',
        longPressTimer: null as ReturnType<typeof setTimeout> | null,
      };
      g.longPressTimer = setTimeout(() => {
        const live = gestureRef.current;
        if (live && live.id === tabId && !live.dragging) {
          live.suppressClick = true;
          openQuickMenu(tabId, rect);
        }
      }, 500);
      gestureRef.current = g;
    },
    [openQuickMenu]
  );

  const handleTabPointerMove = useCallback((e: React.PointerEvent, tabId: string) => {
    const g = gestureRef.current;
    if (!g || g.id !== tabId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.dragging) {
      // Any real movement means this is not a long-press.
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        if (g.longPressTimer) clearTimeout(g.longPressTimer);
        g.longPressTimer = null;
      }
      if (g.isMouse && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        g.dragging = true;
        g.suppressClick = true;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(g.pointerId);
        } catch {
          /* capture is best-effort */
        }
      }
    }
    if (g.dragging) setDragState({ id: tabId, dx });
  }, []);

  const handleTabPointerUp = useCallback(
    (e: React.PointerEvent, tabId: string) => {
      const g = gestureRef.current;
      if (!g || g.id !== tabId) return;
      if (g.longPressTimer) clearTimeout(g.longPressTimer);
      if (g.dragging && onReorder && tabsRowRef.current) {
        // Insertion index = count of pills whose midpoint sits left of the
        // pointer (excluding the dragged pill itself).
        const pills = Array.from(
          tabsRowRef.current.querySelectorAll<HTMLElement>('[data-tabid]')
        ).filter((el) => el.dataset.tabid !== tabId);
        let toIndex = 0;
        for (const el of pills) {
          const r = el.getBoundingClientRect();
          if (e.clientX > r.left + r.width / 2) toIndex++;
        }
        onReorder(tabId, toIndex);
      }
      const suppress = g.suppressClick;
      endGesture();
      // Keep suppression alive for the click that follows pointerup.
      if (suppress) {
        gestureRef.current = {
          id: tabId,
          pointerId: -1,
          startX: 0,
          startY: 0,
          dragging: false,
          suppressClick: true,
          isMouse: false,
          longPressTimer: null,
        };
        setTimeout(() => {
          if (gestureRef.current?.pointerId === -1) gestureRef.current = null;
        }, 150);
      }
    },
    [onReorder, endGesture]
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (gestureRef.current?.suppressClick && gestureRef.current.id === tabId) {
        gestureRef.current = null;
        return;
      }
      onTabSelect(tabId);
    },
    [onTabSelect]
  );

  /** A LOBBY tab is a placeholder, not a seat — no engine, no chips. A HUB
   *  tab (Dan 2026-09-04: a World Hub page in a slot) is the same for every
   *  purpose this strip has: nothing to sit out, mute or leave. */
  const isLobbyId = (id: string) => id.startsWith('lobby:') || id.startsWith('hub:');
  const isHubId = (id: string) => id.startsWith('hub:');

  /* handleClose removed 2026-08-26 (Dan: no × inside the pills) — the quick
     menu's Leave Table / Close Lobby emits the same FORCE_LEAVE_TABLE. */

  const handleMenuClose = useCallback(() => setIsMenuOpen(false), []);
  const handleMenuToggle = useCallback(() => setIsMenuOpen((prev) => !prev), []);

  /**
   * AUDIT 2026-08-25 — FIFTEEN MENU ITEMS THAT DID NOTHING ON A LOBBY TAB.
   *
   * Every item below emits TABLE_MENU_ACTION addressed to `activeTabId`, and
   * both TablePage subscriptions filter on `event.tableId !== tableId`. When
   * the active tab is a LOBBY tab that id is a synthetic `lobby:<ts>` string
   * that no TablePage owns, so Sit Out, Add Chips, Auto Top Up, Hand History,
   * Leaderboard, Session Stats, Table Settings, Sounds, Vibrations, Help and
   * Stand Up Next Big Blind all resolved to nothing at all — no action, no
   * error, no explanation. (Leave Table was the exception: MultiTablePage
   * catches lobby-prefixed LEAVE/FORCE_LEAVE and closes the tab.)
   *
   * A lobby tab has no seat, so none of those items HAVE an answer. Rather than
   * offer them and swallow the result, the table sections are dropped there.
   * TableMenu still renders its own Identity section — the avatar picker and
   * the display-name switch are account settings and work anywhere — so the
   * hamburger is never an empty menu.
   */
  const activeIsLobby = isLobbyId(activeTabId);

  /**
   * THE VIEW SECTION SITS OUTSIDE THE LOBBY-TAB GATE, DELIBERATELY.
   *
   * Everything in `createDefaultMenuSections` is about a SEAT, which is why a
   * lobby tab drops all of it (see the note on `activeIsLobby` above). Tile
   * view is not about a seat - it is about how many tables you are looking at -
   * and it is exactly as meaningful with a lobby tab in front as with a felt.
   * Dropping it there would have recreated the swallowed-action bug that note
   * describes, one control later.
   */
  const viewSection = useMemo<MenuSection[]>(
    () =>
      onToggleTileView
        ? [
            {
              title: 'View',
              actions: [
                {
                  id: 'tile-view',
                  label: isTileView ? 'Single Table View' : 'Tile View',
                  icon: <TileViewIcon />,
                  disabled: !canToggleTileView,
                  badge: isTileView ? 'ON' : undefined,
                  onClick: onToggleTileView,
                },
              ],
            },
          ]
        : [],
    [isTileView, canToggleTileView, onToggleTileView]
  );

  const tableSections = useMemo(
    () =>
      activeIsLobby
        ? []
        : createDefaultMenuSections(
            {
              onSitOut: () =>
                masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'SIT_OUT' }),
              onStandUpBB: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'STAND_UP_BB',
                }),
              onRebuy: () =>
                masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'REBUY' }),
              onAutoTopUp: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'AUTO_TOP_UP',
                }),
              onAddOn: () =>
                masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'ADD_ON' }),
              onSessionStats: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'SESSION_STATS',
                }),
              onSettings: () =>
                masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'SETTINGS' }),
              onToggleSounds: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'TOGGLE_SOUNDS',
                }),
              onToggleVibrations: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'TOGGLE_VIBRATIONS',
                }),
              onHandHistory: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'HAND_HISTORY',
                }),
              onLeaderboard: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'LEADERBOARD',
                }),
              onHelp: () =>
                masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'HELP' }),
              onLeaveTable: () =>
                masterBus.emit('TABLE_MENU_ACTION', {
                  tableId: activeTabId,
                  action: 'LEAVE_TABLE',
                }),
              onToggleProfitTracking,
              /* `onChangeAvatar` / `onToggleAlias` used to be passed here and were
             never placed on a menu item by createDefaultMenuSections — see the
             note on TableMenuProps.onOpenIdentity. The alias handler now goes
             directly to TableMenu as `onOpenIdentity` (below); the avatar
             picker is TableMenu's own in-app gallery. */
            },
            {
              standUpBBBadge: tabs.find((t) => t.id === activeTabId)?.standUpNextBB
                ? 'ON'
                : undefined,
              autoTopUpBadge: tabs.find((t) => t.id === activeTabId)?.isAutoRebuyEnabled
                ? 'ON'
                : undefined,
              soundsBadge: tabs.find((t) => t.id === activeTabId)?.soundEnabled ? 'ON' : 'OFF',
              vibrationsBadge: tabs.find((t) => t.id === activeTabId)?.vibrationsEnabled
                ? 'ON'
                : 'OFF',
              profitTrackingBadge: onToggleProfitTracking
                ? profitTrackingEnabled
                  ? 'ON'
                  : 'OFF'
                : undefined,
            }
          ),
    [activeTabId, tabs, activeIsLobby, profitTrackingEnabled, onToggleProfitTracking]
  );

  const menuSections = useMemo(
    () => [...viewSection, ...tableSections],
    [viewSection, tableSections]
  );

  /**
   * Opens IdentityModal in the owning TablePage. Withheld on a lobby tab for
   * the same reason as the sections above: nothing would answer it there.
   */
  const handleOpenIdentity = useCallback(() => {
    masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'TOGGLE_ALIAS' });
  }, [activeTabId]);

  return (
    <div className="table-tab-bar">
      {/* Realtime link warning — one honest global chip. WS_* events describe
          the Supabase realtime connection, not any single table, so this is
          deliberately not rendered per-tab.

          2026-09-04 (disconnect audit item 7): NAMED. This chip said
          "Reconnecting..." while the felt's own banner said "Reconnecting To
          The Table" for a different socket - a player could read one green
          and one orange and not know which was lying. The game socket has its
          banner on every felt; this one is about the lobby/chat/notification
          feed and now says so. */}
      {realtimeDown && (
        <div
          className="table-tab-bar__offline"
          role="status"
          title="Reconnecting To The Live Feed (Lobby, Chat And Notifications). Your Table And Chips Are Not Affected."
        >
          <span className="table-tab-bar__offline-dot" aria-hidden="true">
            ●
          </span>
          <span className="table-tab-bar__offline-label">Live Feed Reconnecting</span>
        </div>
      )}

      {/* Table Tabs */}
      <div className="table-tab-bar__tabs" ref={tabsRowRef}>
        {tabs.map((tab, i) => {
          const isActive = tab.id === activeTabId;
          const heroHasCards = !!tab.holeCards && tab.holeCards.length >= 2;

          /* ── OBSERVING: THE TAB HOLDS STILL ────────────────────────────────
             Dan 2026-08-26: "THE ACTION BAR ON TOP OF THE PLAYING PAGE SHOULD
             NOT EVER FLASH OR CHANGE ANYTHING WHEN YOUR ON A TABLE OBSERVING.
             IT SHOULD JUST SAY THE GAME AND THE STAKES."

             Almost everything this pill renders is hero state -- your cards,
             your turn, your clock, your last action -- and a spectator has
             none of it, so those parts were already quiet. ONE thing is not
             hero state: `pot`. It belongs to the TABLE, so while you watch a
             game you are not in, the sub-line flips between "Pot 14" and the
             stakes on every street of every hand, forever. That is the
             flashing, and no amount of "the hero has no cards" reasoning
             suppresses it.

             WHY THIS TEST IS NOT JUST `!tab.seated`. `seated` is the right
             signal but it is not the only evidence, and getting it wrong in
             the WRONG DIRECTION costs a player money: a seated player whose
             `seated` flag has not landed yet would have their turn indicator
             and their five-second flash suppressed, and would sit there
             missing a decision the tab was built to warn them about. So any
             evidence of involvement -- a seat, a turn, cards, an open
             decision, a burning time bank -- disables the observer treatment.
             The quiet path is only taken when every one of them says no. */
          const observing =
            tab.seated !== true &&
            !tab.isMyTurn &&
            !heroHasCards &&
            !tab.decisionKind &&
            tab.timeBankSecondsLeft === undefined;

          // Urgency is a property of the clock, not of which tab is focused —
          // the reference footage dims nothing on the active tab, and a player
          // staring at table 2 still needs table 2's own bar going red.
          const isMyTurn = !observing && tab.isMyTurn;
          const isUrgent = isMyTurn && tab.timeRemaining !== undefined && tab.timeRemaining < 10;
          const hasCards = !observing && heroHasCards;
          const flash = observing ? undefined : actionFlash[tab.id];
          const result = observing ? undefined : resultFlash[tab.id];
          const isMuted = !!mutedIds?.includes(tab.id);
          // Dan 2026-08-21: 5 seconds left on ANY clock at this table - turn,
          // discard, insurance or RIT - and the box flashes. On every tab,
          // focused or not: the clock does not care where you are looking.
          const anySecondsLeft = observing
            ? undefined
            : tab.decisionSecondsLeft !== undefined
              ? tab.decisionSecondsLeft
              : tab.timeRemaining;
          const isFlashing = anySecondsLeft !== undefined && anySecondsLeft <= 5;
          const decisionLabel =
            !observing && tab.decisionKind ? DECISION_LABEL[tab.decisionKind] : '';
          const timeBankLeft = observing ? undefined : tab.timeBankSecondsLeft;
          /* Absent while the hero is not sitting out, on a tournament, and
             while merely observing. `m:ss`, because a five-minute clock read as
             bare seconds ("241s") is not a number anyone converts at a glance. */
          const sitOutSecs = observing ? undefined : tab.sitOutSecondsLeft;
          const sitOutLeft =
            sitOutSecs === undefined
              ? undefined
              : `${Math.floor(sitOutSecs / 60)}:${String(sitOutSecs % 60).padStart(2, '0')}`;
          const sitOutUrgent = sitOutSecs !== undefined && sitOutSecs <= 60;
          /* The pot is the only TABLE-level thing on this pill, so it is the
             only one that has to be silenced explicitly. Stakes take its place,
             which is what tells two NLH tabs apart anyway. */
          const potToShow = !observing && tab.pot !== undefined && tab.pot > 0 ? tab.pot : null;
          const isDragging = dragState?.id === tab.id;

          return (
            <button
              key={tab.id}
              className={[
                'table-tab-bar__tab',
                isActive && 'table-tab-bar__tab--active',
                hasCards && 'table-tab-bar__tab--cards',
                isFlashing && 'table-tab-bar__tab--flash',
                !observing && tab.decisionKind && 'table-tab-bar__tab--decision',
                !observing && tab.folded && 'table-tab-bar__tab--folded',
                result === 'win' && 'table-tab-bar__tab--won',
                result === 'loss' && 'table-tab-bar__tab--lost',
                !isActive && isMyTurn && 'table-tab-bar__tab--turn',
                !isActive && isUrgent && 'table-tab-bar__tab--urgent',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleTabClick(tab.id)}
              onPointerDown={(e) => handleTabPointerDown(e, tab.id)}
              onPointerMove={(e) => handleTabPointerMove(e, tab.id)}
              onPointerUp={(e) => handleTabPointerUp(e, tab.id)}
              onPointerCancel={endGesture}
              onContextMenu={(e) => {
                // Right-click = the same quick menu (desktop parity with
                // long-press), never the browser menu on a game control.
                e.preventDefault();
                openQuickMenu(tab.id, (e.currentTarget as HTMLElement).getBoundingClientRect());
              }}
              data-tabid={tab.id}
              // Audit 2026-08-20: when the tab shows mini cards the name span
              // is gone and MiniCards is aria-hidden, so the button had NO
              // accessible name at all. Announce the table and its state; the
              // cards themselves are visual sugar a screen reader can live
              // without (the table view reads them properly).
              aria-label={`${formatGameTitle(tab.name)}${isMyTurn ? ', Your Turn' : ''}`}
              aria-current={isActive ? 'true' : undefined}
              style={
                isDragging
                  ? {
                      opacity: 0.92,
                      transform: `translateX(${dragState!.dx}px)`,
                      transition: 'none',
                      zIndex: 5,
                    }
                  : {
                      opacity: visibleItems.has(i) ? 1 : 0,
                      transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }
              }
            >
              {/* ── CARDS WIN, ALWAYS (Dan 2026-08-28, mobile pass item 3) ──
                  Verbatim: "THE ACTION PILL SHOULD ONLY EVER SHOW THE CARDS
                  (CENTERED IN THE PILL) AND THE DISAPPEARING TIMER BAR...
                  THATS IT, NO COUNTDOWN CLOCK OR ANYTHING ELSE."

                  `hasCards` is now the FIRST branch. It used to be third, so a
                  decision prompt or an engaged time bank REPLACED the hero's
                  hand with a text countdown — and both of those only ever fire
                  while the hero is holding cards, which made them the common
                  case rather than the exception.

                  Nothing is lost by it: the pill already flashes
                  (`--flash` under 5s) and the timer bar already drains and goes
                  red, so the urgency those labels carried is on the pill twice
                  over without a digit on it. The label branches below still
                  render when there is genuinely no hand to show, so a state can
                  never fall through to a blank pill.

                  PokerBros parity (Dan 2026-08-20): a tab where the hero holds
                  live cards previews THOSE CARDS; the name only shows between
                  hands / after folding. */}
              {hasCards ? (
                <MiniCards cards={tab.holeCards!} />
              ) : decisionLabel ? (
                <span className="table-tab-bar__tab-label">
                  <span className="table-tab-bar__tab-name">{decisionLabel}</span>
                  <span className="table-tab-bar__tab-sub">
                    {tab.decisionSecondsLeft ?? 0}s Left
                  </span>
                </span>
              ) : sitOutLeft !== undefined ? (
                /* A SEAT ABOUT TO BE RECLAIMED outranks the game code, the
                   stakes and the pot — none of those change what the player
                   should do next. Same shape as TIME BANK below, which is the
                   established way this bar says "a clock is running here". */
                <span
                  className={`table-tab-bar__tab-label${
                    sitOutUrgent ? ' table-tab-bar__tab-label--seat-urgent' : ''
                  }`}
                >
                  <span className="table-tab-bar__tab-name">SEAT</span>
                  <span className="table-tab-bar__tab-sub">{sitOutLeft}</span>
                </span>
              ) : timeBankLeft !== undefined ? (
                /* Dan 2026-08-21: "if they have auto time banks on, and it
                   kicks in, it should display TIME BANK with a countdown
                   clock in the box." */
                <span className="table-tab-bar__tab-label">
                  <span className="table-tab-bar__tab-name">TIME BANK</span>
                  <span className="table-tab-bar__tab-sub">{timeBankLeft}s</span>
                </span>
              ) : (
                <span className="table-tab-bar__tab-label">
                  {/* Dan 2026-08-21: no hand here, so say WHAT GAME THIS IS.
                      The code wins; the table name is the fallback for a
                      table whose variant we genuinely do not know yet.
                      Dan 2026-08-20: variants are acronyms - NLH, not nlh. */}
                  <span className="table-tab-bar__tab-name">
                    {tab.gameCode || formatGameTitle(tab.name)}
                  </span>
                  {/* Sub-line: the live pot while a hand runs without the
                      hero, otherwise the stakes - which is what tells two
                      NLH tabs apart. */}
                  {potToShow !== null ? (
                    <span className="table-tab-bar__tab-sub">
                      Pot {potToShow.toLocaleString('en-US')}
                    </span>
                  ) : (
                    tab.stakes && <span className="table-tab-bar__tab-sub">{tab.stakes}</span>
                  )}
                </span>
              )}

              {/* Transient last-action chip ("Fold", "Call", ...). Only ever on
                  a tab where it is NOT the hero's turn, so it never shares the
                  pill with the timer bar and never pushes the cards off centre
                  at the moment Dan is looking at them. */}
              {flash && !isMyTurn && (
                <span className="table-tab-bar__action-chip">{ACTION_LABEL[flash] ?? flash}</span>
              )}

              {/* ── THE COUNTDOWN BADGE IS GONE (Dan 2026-08-28, item 3) ──────
                  There used to be a `.table-tab-bar__turn-dot` here rendering
                  `${tab.timeRemaining}s` — the green "14s" pill in Dan's
                  screenshot. Two things were wrong with it:

                    1. He asked for no countdown clock on this pill at all. The
                       draining bar below IS the clock, and it reads faster than
                       a number does when you are watching four tables.
                    2. It was an in-flow sibling of the mini-cards inside a pill
                       that centres its children, so the cards sat OFF CENTRE
                       exactly while it was the hero's turn — the one moment the
                       pill is being looked at. That is the "(CENTERED IN THE
                       PILL)" half of the same sentence: it is fixed by deleting
                       this, not by adding alignment.

                  `isUrgent` still drives `--urgent` on the pill and on the bar,
                  so nothing about urgency was carried by the badge alone. */}

              {/* Depleting turn-timer bar (PokerBros parity): rides the bottom
                  edge of the pill whenever it is the hero's turn at this
                  table, active tab included, and drains left as time runs out.
                  Width steps once a second; the linear transition smooths it. */}
              {isMyTurn && tab.turnProgress !== undefined && (
                <span
                  className={`table-tab-bar__timer-bar${
                    isUrgent ? ' table-tab-bar__timer-bar--urgent' : ''
                  }`}
                  style={{ width: `${Math.round(tab.turnProgress * 100)}%` }}
                  aria-hidden="true"
                />
              )}

              {/* Batch 3: muted marker (audio only; U+266A is a text symbol,
                  not emoji, and SeatSlot already uses suit glyphs). */}
              {isMuted && (
                <span className="table-tab-bar__muted-dot" title="Table Muted" aria-hidden="true">
                  ♪
                </span>
              )}

              {/* Dan 2026-08-26: the action pills carry NO × off-button.
                  The inline close control is gone entirely — leaving a table
                  or closing the lobby lives in the long-press quick menu
                  ("Leave Table" / "Close Lobby") and in the table's own
                  hamburger menu, both of which route through the same secure
                  FORCE_LEAVE_TABLE cashout path this × used. Do not
                  reintroduce an inline dismiss on the pill. */}
            </button>
          );
        })}

        {/* "+" Add Table — Dan 2026-08-21: "there is always ONE + button.
            When you add a game the previous + area turns into the box with
            the hand preview or the game type, and another + is added after
            it, until the user maxes out at 4 games."

            That is exactly a single trailing "+": it sits after the last
            tab, a new tab takes the spot it occupied, and it vanishes at
            MAX_TABLES. It used to render TWO, which read as a broken strip
            rather than one invitation. */}
        {Array.from({ length: emptySlots > 0 ? 1 : 0 }).map((_, i) => (
          <button
            key={`add-${i}`}
            className="table-tab-bar__add"
            onClick={handleAddClick}
            onPointerDown={handleAddPointerDown}
            onPointerUp={cancelAddPress}
            onPointerLeave={cancelAddPress}
            onPointerCancel={cancelAddPress}
            onContextMenu={handleAddContextMenu}
            title={hasAddMenu ? 'Add Table (Hold For Lobby, Hub And Messages)' : 'Add Table'}
            // Dan 2026-08-20: the only accessible name these had was their
            // text content, "+". Screen readers announced a bare plus sign,
            // and nothing could address them by name. Matches the in-table
            // HUD control, which already carries aria-label="Open another
            // table", so both entry points announce the same thing.
            aria-label="Open Another Table"
          >
            {/* Dan 2026-08-28: the + is the metallic circled-plus from his
                reference image — the real icon-addscreen asset (same one the
                in-table HUD renders), with the inline SVG below as the
                offline/load-failure fallback. */}
            {!addIconFailed && (
              <img
                className="table-tab-bar__add-icon"
                src={addScreenIcon}
                alt=""
                draggable={false}
                onError={() => setAddIconFailed(true)}
              />
            )}
            {addIconFailed && (
              <svg
                className="table-tab-bar__add-icon"
                viewBox="0 0 48 48"
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <linearGradient id="spAddMetal" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#f4f6f8" />
                    <stop offset="35%" stopColor="#b9bfc7" />
                    <stop offset="60%" stopColor="#7e858f" />
                    <stop offset="80%" stopColor="#a7adb6" />
                    <stop offset="100%" stopColor="#5f666f" />
                  </linearGradient>
                  <linearGradient id="spAddMetalDark" x1="1" y1="1" x2="0" y2="0">
                    <stop offset="0%" stopColor="#d7dbe0" />
                    <stop offset="50%" stopColor="#868d97" />
                    <stop offset="100%" stopColor="#4c525a" />
                  </linearGradient>
                </defs>
                <circle
                  cx="24"
                  cy="24"
                  r="20"
                  fill="none"
                  stroke="url(#spAddMetal)"
                  strokeWidth="5"
                />
                <circle
                  cx="24"
                  cy="24"
                  r="17.2"
                  fill="none"
                  stroke="rgba(0, 0, 0, 0.35)"
                  strokeWidth="0.8"
                />
                <rect x="21" y="12" width="6" height="24" rx="2.6" fill="url(#spAddMetalDark)" />
                <rect x="12" y="21" width="24" height="6" rx="2.6" fill="url(#spAddMetalDark)" />
                <rect
                  x="21.8"
                  y="12.8"
                  width="1.6"
                  height="22.4"
                  rx="0.8"
                  fill="rgba(255, 255, 255, 0.35)"
                />
                <rect
                  x="12.8"
                  y="21.8"
                  width="22.4"
                  height="1.6"
                  rx="0.8"
                  fill="rgba(255, 255, 255, 0.35)"
                />
              </svg>
            )}
          </button>
        ))}
      </div>

      {/* Jackpot badge REMOVED — Dan 2026-08-23: "you still have the
          duplicated BBJ in the header that needs to be removed."
          BadBeatJackpot's .bbj-widget banner sits directly below this bar and
          shows the same pool for the same table. Two live copies of one number
          is one too many, and the header is the copy with less room. */}

      {/* Batch 3: long-press / right-click quick menu */}
      {addMenu && (
        <>
          <div className="table-tab-bar__qmenu-backdrop" onClick={() => setAddMenu(null)} />
          <div
            className="table-tab-bar__qmenu"
            style={{ left: addMenu.left, top: addMenu.top }}
            role="menu"
            aria-label="Open A New Tab"
          >
            <div className="table-tab-bar__qmenu-title">Open A New Tab</div>
            {(
              [
                ['Open Lobby', onOpenLobby ? () => onOpenLobby() : null],
                ['Open Hub', onOpenHub ? () => onOpenHub('/hub') : null],
                ['Social', onOpenHub ? () => onOpenHub('/hub/social') : null],
                ['Messages', onOpenHub ? () => onOpenHub('/hub/messenger') : null],
              ] as const
            ).map(([label, fn]) =>
              fn ? (
                <button
                  key={label}
                  type="button"
                  className="table-tab-bar__qmenu-item"
                  onClick={() => {
                    setAddMenu(null);
                    fn();
                  }}
                >
                  {label}
                </button>
              ) : null
            )}
          </div>
        </>
      )}

      {quickMenu &&
        (() => {
          const tab = tabs.find((t) => t.id === quickMenu.tabId);
          if (!tab) return null;
          const idx = tabs.findIndex((t) => t.id === quickMenu.tabId);
          const muted = !!mutedIds?.includes(tab.id);
          // Audit round 3: a LOBBY tab is not a seat. It offered Sit Out /
          // Mute, and Sit Out fired a real engine call with a synthetic
          // 'lobby:' id. Lobby tabs get exactly what makes sense for them:
          // Move Left/Right and Close.
          const isLobby = isLobbyId(tab.id);
          const item = (label: string, fn: () => void, danger = false, disabled = false) => (
            <button
              key={label}
              type="button"
              disabled={disabled}
              className={`table-tab-bar__qmenu-item${danger ? ' table-tab-bar__qmenu-item--danger' : ''}`}
              onClick={() => {
                setQuickMenu(null);
                fn();
              }}
            >
              {label}
            </button>
          );
          return (
            <>
              <div className="table-tab-bar__qmenu-backdrop" onClick={() => setQuickMenu(null)} />
              <div
                className="table-tab-bar__qmenu"
                style={{ left: quickMenu.left, top: quickMenu.top }}
                role="menu"
                aria-label={`${tab.name} Quick Actions`}
              >
                <div className="table-tab-bar__qmenu-title">{formatGameTitle(tab.name)}</div>
                {onQuickAction &&
                  !isLobby &&
                  item(tab.sittingOut ? "I'm Back" : 'Sit Out', () =>
                    onQuickAction(tab.id, tab.sittingOut ? 'back' : 'sitout')
                  )}
                {onQuickAction &&
                  !isLobby &&
                  item(muted ? 'Unmute Table' : 'Mute Table', () => onQuickAction(tab.id, 'mute'))}
                {/* Hub tabs (Dan 2026-09-05): what a browser tab's own menu
                    offers - reload, and open the same page outside the frame. */}
                {onQuickAction &&
                  isHubId(tab.id) &&
                  item('Reload Page', () => onQuickAction(tab.id, 'reload'))}
                {onQuickAction &&
                  isHubId(tab.id) &&
                  item('Open In Browser', () => onQuickAction(tab.id, 'open-browser'))}
                {onReorder &&
                  item(
                    'Move Left',
                    () => onReorder(tab.id, Math.max(0, idx - 1)),
                    false,
                    idx === 0
                  )}
                {onReorder &&
                  item(
                    'Move Right',
                    () => onReorder(tab.id, Math.min(tabs.length - 1, idx + 1)),
                    false,
                    idx === tabs.length - 1
                  )}
                {/* Dan 2026-08-23: "when you right click on an action tab, or
                    hold it down on mobile, you should get an option to Leave
                    Table (an alternate way to leave a table)."

                    It was already here — behind `tabs.length > 1`. So the menu
                    offered Leave Table at two tables and hid it at one, which
                    is the case a player is in most of the time: the reported
                    screenshot is a single MTT tab showing Sit Out, Mute Table
                    and a greyed-out Move Left / Move Right, with no way out.

                    Leaving one table has never needed a second table to exist.
                    `'leave'` emits FORCE_LEAVE_TABLE to the owning TablePage —
                    the secure cashout path — and when the last tab closes,
                    MultiTablePage's TABLE_LEFT handler calls goToLobby(). The
                    count gate stays only for a LOBBY tab, where "Close Lobby"
                    on your only tab would close the thing you are looking at
                    and leave an empty bar behind. */}
                {onQuickAction &&
                  (!isLobby || tabs.length > 1) &&
                  item(
                    isHubId(tab.id) ? 'Close Tab' : isLobby ? 'Close Lobby' : 'Leave Table',
                    () => onQuickAction(tab.id, 'leave'),
                    true
                  )}
                {(onSitOutAll || onBackAll) && tabs.length > 1 && (
                  <div className="table-tab-bar__qmenu-sep" aria-hidden="true" />
                )}
                {onSitOutAll && tabs.length > 1 && item('Sit Out All Tables', onSitOutAll)}
                {onBackAll && tabs.length > 1 && item('Back At All Tables', onBackAll)}
              </div>
            </>
          );
        })()}

      {/* Table Menu */}
      <div className="table-tab-bar__menu-container">
        <TableMenu
          isOpen={isMenuOpen}
          onClose={handleMenuClose}
          onToggle={handleMenuToggle}
          sections={menuSections}
          position="bottom-left"
          tableName={
            isHubId(activeTabId)
              ? tabs.find((t) => t.id === activeTabId)?.name || 'Hub'
              : activeIsLobby
                ? 'Lobby'
                : formatGameTitle(tabs.find((t) => t.id === activeTabId)?.name) || 'Table'
          }
          onOpenIdentity={activeIsLobby ? undefined : handleOpenIdentity}
        />
      </div>
    </div>
  );
}

export default TableTabBar;
