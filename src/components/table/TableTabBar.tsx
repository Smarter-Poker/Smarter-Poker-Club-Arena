/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE TAB BAR — PokerBros-Style Multi-Table Navigation
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

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import TableMenu, { createDefaultMenuSections } from './TableMenu';
import { masterBus } from '../../core/MasterBus';
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
  pot?: number;
}

export interface TableTabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onAddTable: () => void;
  jackpotAmount?: number;
  maxTables?: number;
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
}: TableTabBarProps) {
  const emptySlots = maxTables - tabs.length;
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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
        onHelp: () =>
          masterBus.emit('TABLE_MENU_ACTION', { tableId: activeTabId, action: 'HELP' }),
        onLeaveTable: () =>
          masterBus.emit('TABLE_MENU_ACTION', {
            tableId: activeTabId,
            action: 'LEAVE_TABLE',
          }),
      }),
    [activeTabId]
  );

  return (
    <div className="table-tab-bar">
      {/* Table Tabs */}
      <div className="table-tab-bar__tabs">
        {tabs.map((tab, i) => {
          const isActive = tab.id === activeTabId;
          const isUrgent =
            !isActive && tab.isMyTurn && tab.timeRemaining !== undefined && tab.timeRemaining < 10;

          return (
            <button
              key={tab.id}
              className={[
                'table-tab-bar__tab',
                isActive && 'table-tab-bar__tab--active',
                !isActive && tab.isMyTurn && 'table-tab-bar__tab--turn',
                isUrgent && 'table-tab-bar__tab--urgent',
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
              <span className="table-tab-bar__tab-name">{tab.name}</span>

              {/* Turn indicator — show timer or pulsing dot */}
              {!isActive && tab.isMyTurn && (
                <span className="table-tab-bar__turn-dot">
                  {tab.timeRemaining !== undefined && tab.timeRemaining < 15
                    ? `${tab.timeRemaining}s`
                    : ''}
                </span>
              )}

              {/* Close button — only on hover for non-sole tabs */}
              {tabs.length > 1 && (
                <button
                  className="table-tab-bar__close"
                  onClick={(e) => handleClose(e, tab.id)}
                  title="Close table"
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
