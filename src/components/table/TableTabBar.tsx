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
import TableMenu, { createDefaultMenuSections } from './TableMenu';
import { masterBus } from '../../core/MasterBus';
import { formatGameTitle } from '../../utils/formatGameTitle';
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
  /* `lastAction` REMOVED 2026-08-27 (round 3, item 5) with the transient
     action chip it fed — see the note in the component body. */
  /** Hero folded this hand — the tab dims (roadmap batch 1). */
  folded?: boolean;
  /** Showdown outcome edge: "win:<hand>" / "loss:<hand>" / "". The tab
   *  pulses green/red for a moment so a background table's result is
   *  visible without switching. */
  handResult?: string;
  /** Hero is sitting out at this table (long-press menu label). */
  sittingOut?: boolean;
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

/* `ACTION_LABEL` DELETED 2026-08-27 — see the note on the transient action
   chip's removal further down (round 3, item 5). */

export interface TableTabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onAddTable: () => void;
  maxTables?: number;
  /** Batch 3: reorder a tab to a new index (drag on desktop, long-press
   *  menu Move Left/Right everywhere). */
  onReorder?: (fromId: string, toIndex: number) => void;
  /** Batch 3: per-table muted ids (audio only). */
  mutedIds?: string[];
  /** Batch 3: long-press quick actions. */
  onQuickAction?: (tabId: string, action: 'sitout' | 'back' | 'leave' | 'mute') => void;
  /** Batch 3: one-tap sit out / return across every seated table. */
  onSitOutAll?: () => void;
  onBackAll?: () => void;
  /**
   * Open the across-all-tables session breakdown.
   *
   * Dan 2026-08-27 round 3, item 3: the header's session P&L chip was removed
   * (it was the "negative number in the header"). Its popover is still wanted,
   * so its trigger moved here, next to the other all-tables actions. Absent
   * when there is no tracked session to show.
   */
  onShowSession?: () => void;
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
  maxTables = 4,
  realtimeDown = false,
  onReorder,
  mutedIds,
  onQuickAction,
  onSitOutAll,
  onBackAll,
  onShowSession,
}: TableTabBarProps) {
  const emptySlots = maxTables - tabs.length;
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  /* ─── THE TRANSIENT LAST-ACTION CHIP IS GONE (Dan 2026-08-27, round 3) ───
     "There should never be an action, like BET, inside the action pill — only
     the hand you have and the timer bar."

     What went: `actionFlash` state, `prevActionsRef`, `flashTimersRef`, the
     rising-edge effect that armed a 2.5s flash, the unmount sweep, the
     `ACTION_LABEL` map, the `<span className="table-tab-bar__action-chip">`
     and the `lastAction` field on this file's TabInfo, on MultiTablePage's
     TableInfo and on TablePage's `onTableInfoUpdate` payload — the whole chain
     that computed the value, because a chip nothing renders is not a feature
     that is merely hidden.

     WHAT REMAINS ON THE PILL IS EXACTLY WHAT DAN ASKED FOR: the mini cards
     (`<MiniCards>`), and `.table-tab-bar__timer-bar` riding the pill's bottom
     edge. The result flash below is a WIN/LOSS pulse on the pill's own
     background, not an action word, and the decision / TIME BANK branches are
     states of the clock rather than actions taken — none of those puts an
     action inside the pill, so none of them is in scope here.

     Do not reintroduce it. If a "what did I just do" cue is ever wanted again,
     it belongs on the seat (`.seat__action`), where the same information is
     already drawn for every player at the table. */

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

  /** A LOBBY tab is a placeholder, not a seat — no engine, no chips. */
  const isLobbyId = (id: string) => id.startsWith('lobby:');

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

  const menuSections = useMemo(
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
            }
          ),
    [activeTabId, tabs, activeIsLobby]
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
          deliberately not rendered per-tab. */}
      {realtimeDown && (
        <div
          className="table-tab-bar__offline"
          role="status"
          title="Reconnecting to the live feed - your seats and chips are safe on the server."
        >
          <span className="table-tab-bar__offline-dot" aria-hidden="true">
            ●
          </span>
          <span className="table-tab-bar__offline-label">Reconnecting…</span>
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
              aria-label={`${formatGameTitle(tab.name)}${isMyTurn ? ', your turn' : ''}`}
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
              {/* PokerBros parity (Dan 2026-08-20): a tab where the hero holds
                  live cards previews THOSE CARDS; the name only shows between
                  hands / after folding. */}
              {decisionLabel ? (
                <span className="table-tab-bar__tab-label">
                  <span className="table-tab-bar__tab-name">{decisionLabel}</span>
                  <span className="table-tab-bar__tab-sub">
                    {tab.decisionSecondsLeft ?? 0}s Left
                  </span>
                </span>
              ) : timeBankLeft !== undefined ? (
                /* Dan 2026-08-21: "if they have auto time banks on, and it
                   kicks in, it should display TIME BANK with a countdown
                   clock in the box." */
                <span className="table-tab-bar__tab-label">
                  <span className="table-tab-bar__tab-name">TIME BANK</span>
                  <span className="table-tab-bar__tab-sub">{timeBankLeft}s</span>
                </span>
              ) : hasCards ? (
                <MiniCards cards={tab.holeCards!} />
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

              {/* The transient last-action chip that stood here was removed on
                  2026-08-27 (round 3, item 5). See the note in the component
                  body for what went with it and why. */}

              {/* Turn indicator — show timer or pulsing dot */}
              {!isActive && isMyTurn && (
                <span className="table-tab-bar__turn-dot">
                  {tab.timeRemaining !== undefined && tab.timeRemaining < 15
                    ? `${tab.timeRemaining}s`
                    : ''}
                </span>
              )}

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
                <span className="table-tab-bar__muted-dot" title="Table muted" aria-hidden="true">
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
            onClick={onAddTable}
            title="Add table"
            // Dan 2026-08-20: the only accessible name these had was their
            // text content, "+". Screen readers announced a bare plus sign,
            // and nothing could address them by name. Matches the in-table
            // HUD control, which already carries aria-label="Open another
            // table", so both entry points announce the same thing.
            aria-label="Open another table"
          >
            +
          </button>
        ))}
      </div>

      {/* Jackpot badge REMOVED — Dan 2026-08-23: "you still have the
          duplicated BBJ in the header that needs to be removed."
          BadBeatJackpot's .bbj-widget banner sits directly below this bar and
          shows the same pool for the same table. Two live copies of one number
          is one too many, and the header is the copy with less room. */}

      {/* Batch 3: long-press / right-click quick menu */}
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
                aria-label={`${tab.name} quick actions`}
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
                    isLobby ? 'Close Lobby' : 'Leave Table',
                    () => onQuickAction(tab.id, 'leave'),
                    true
                  )}
                {((onSitOutAll || onBackAll) && tabs.length > 1) || onShowSession ? (
                  <div className="table-tab-bar__qmenu-sep" aria-hidden="true" />
                ) : null}
                {onSitOutAll && tabs.length > 1 && item('Sit Out All Tables', onSitOutAll)}
                {onBackAll && tabs.length > 1 && item('Back At All Tables', onBackAll)}
                {/* Rehomed from the header chip — see onShowSession's doc. */}
                {onShowSession && item('Session Totals', onShowSession)}
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
            activeIsLobby
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
