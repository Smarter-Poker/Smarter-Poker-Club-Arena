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
  /**
   * PokerBros parity: the hero's hole cards at this table, comma-joined
   * ("Ah,Qc" / "Td,9h"; "" or undefined when not in a hand or folded).
   * When present the tab renders mini cards instead of the table name.
   */
  holeCards?: string;
  /** Hero's last action this street ('fold', 'call', ...) for the
   *  transient badge under the tab. */
  lastAction?: string;
}

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

function MiniCards({ cards }: { cards: string }) {
  const parsed = cards
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length >= 2);
  if (parsed.length === 0) return null;
  return (
    <span
      className={`table-tab-bar__mini-cards${parsed.length > 2 ? ' table-tab-bar__mini-cards--wide' : ''}`}
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
}

/** Display labels for the transient last-action chip. */
const ACTION_LABEL: Record<string, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
  all_in: 'All In',
};

export interface TableTabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onAddTable: () => void;
  jackpotAmount?: number;
  maxTables?: number;
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
  jackpotAmount,
  maxTables = 4,
  realtimeDown = false,
}: TableTabBarProps) {
  const emptySlots = maxTables - tabs.length;
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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

  useEffect(() => {
    const timeouts = tabs.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [tabs.length]);

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      if (tabs.length <= 1) return;

      // Route X-button clicks through the secure cashout layer,
      // bypassing the instant component teardown in MultiTablePage
      masterBus.emit('TABLE_MENU_ACTION', {
        tableId: tabId,
        action: 'FORCE_LEAVE_TABLE',
      });
    },
    [tabs.length]
  );

  const handleMenuClose = useCallback(() => setIsMenuOpen(false), []);
  const handleMenuToggle = useCallback(() => setIsMenuOpen((prev) => !prev), []);

  const menuSections = useMemo(
    () =>
      createDefaultMenuSections({
        onSitOut: () =>
          masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'SIT_OUT' }),
        onRebuy: () =>
          masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'REBUY' }),
        onAddOn: () =>
          masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'ADD_ON' }),
        onSessionStats: () =>
          masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'SESSION_STATS' }),
        onSettings: () =>
          masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'SETTINGS' }),
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
        onHelp: () => masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'HELP' }),
        onLeaveTable: () =>
          masterBus.emit('TABLE_MENU_ACTION', {
            tableId: activeTabId,
            action: 'LEAVE_TABLE',
          }),
        onChangeAvatar: () =>
          masterBus.emit('TABLE_MENU_ACTION', {
            tableId: activeTabId,
            action: 'CHANGE_AVATAR',
          }),
        onToggleAlias: () =>
          masterBus.emit('TABLE_MENU_ACTION', {
            tableId: activeTabId,
            action: 'TOGGLE_ALIAS',
          }),
      }),
    [activeTabId]
  );

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
      <div className="table-tab-bar__tabs">
        {tabs.map((tab, i) => {
          const isActive = tab.id === activeTabId;
          // Urgency is a property of the clock, not of which tab is focused —
          // the reference footage dims nothing on the active tab, and a player
          // staring at table 2 still needs table 2's own bar going red.
          const isUrgent =
            tab.isMyTurn && tab.timeRemaining !== undefined && tab.timeRemaining < 10;
          const hasCards = !!tab.holeCards && tab.holeCards.length >= 2;
          const flash = actionFlash[tab.id];

          return (
            <button
              key={tab.id}
              className={[
                'table-tab-bar__tab',
                isActive && 'table-tab-bar__tab--active',
                !isActive && tab.isMyTurn && 'table-tab-bar__tab--turn',
                !isActive && isUrgent && 'table-tab-bar__tab--urgent',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onTabSelect(tab.id)}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              {/* PokerBros parity (Dan 2026-08-20): a tab where the hero holds
                  live cards previews THOSE CARDS; the name only shows between
                  hands / after folding. */}
              {hasCards ? (
                <MiniCards cards={tab.holeCards!} />
              ) : (
                // Dan 2026-08-20: variants are acronyms — NLH, not nlh.
                <span className="table-tab-bar__tab-name">{formatGameTitle(tab.name)}</span>
              )}

              {/* Transient last-action chip ("Fold", "Call", ...) */}
              {flash && !tab.isMyTurn && (
                <span className="table-tab-bar__action-chip">
                  {ACTION_LABEL[flash] ?? flash}
                </span>
              )}

              {/* Turn indicator — show timer or pulsing dot */}
              {!isActive && tab.isMyTurn && (
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
              {tab.isMyTurn && tab.turnProgress !== undefined && (
                <span
                  className={`table-tab-bar__timer-bar${
                    isUrgent ? ' table-tab-bar__timer-bar--urgent' : ''
                  }`}
                  style={{ width: `${Math.round(tab.turnProgress * 100)}%` }}
                  aria-hidden="true"
                />
              )}

              {/* Close button — only on hover for non-sole tabs */}
              {tabs.length > 1 && (
                <button
                  className="table-tab-bar__close"
                  onClick={(e) => handleClose(e, tab.id)}
                  title="Close table"
                  aria-label={`Close ${tab.name}`}
                >
                  ×
                </button>
              )}
            </button>
          );
        })}

        {/* "+" Add Table Buttons — fill remaining slots */}
        {Array.from({ length: Math.min(emptySlots, 2) }).map((_, i) => (
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

      {/* Jackpot Badge */}
      {jackpotAmount !== undefined && jackpotAmount > 0 && (
        <div className="table-tab-bar__jackpot">
          <span className="table-tab-bar__jackpot-label">JACKPOT</span>
          <span className="table-tab-bar__jackpot-amount">
            {jackpotAmount.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
      )}

      {/* Table Menu */}
      <div className="table-tab-bar__menu-container">
        <TableMenu
          isOpen={isMenuOpen}
          onClose={handleMenuClose}
          onToggle={handleMenuToggle}
          sections={menuSections}
          position="bottom-left"
          tableName={tabs.find((t) => t.id === activeTabId)?.name || 'Table'}
        />
      </div>
    </div>
  );
}

export default TableTabBar;
