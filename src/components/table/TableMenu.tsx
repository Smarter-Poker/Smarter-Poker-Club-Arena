/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ☰ TABLE MENU — Hamburger Menu for Table Actions
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Comprehensive table menu with:
 * - Quick actions (leave, sit out, rebuy)
 * - Settings access
 * - Hand history
 * - Help & feedback
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  SitOutIcon,
  RebuyIcon,
  HandHistoryIcon,
  LeaderboardIcon,
  SettingsIcon,
  HelpIcon,
  LeaveTableIcon,
} from './TableMenuIcons';
import './TableMenu.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MenuAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  badge?: string | number;
}

export interface MenuSection {
  title?: string;
  actions: MenuAction[];
}

export interface TableMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
  sections: MenuSection[];
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  tableName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT MENU SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function createDefaultMenuSections(handlers: {
  onSitOut?: () => void;
  onRebuy?: () => void;
  onSettings?: () => void;
  onHandHistory?: () => void;
  onLeaderboard?: () => void;
  onHelp?: () => void;
  onLeaveTable?: () => void;
}): MenuSection[] {
  return [
    {
      title: 'Quick Actions',
      actions: [
        {
          id: 'sitout',
          label: 'Sit Out Next Hand',
          icon: <SitOutIcon />,
          onClick: handlers.onSitOut || (() => {}),
        },
        {
          id: 'rebuy',
          label: 'Add Chips',
          icon: <RebuyIcon />,
          onClick: handlers.onRebuy || (() => {}),
        },
      ],
    },
    {
      title: 'Table Info',
      actions: [
        {
          id: 'history',
          label: 'Hand History',
          icon: <HandHistoryIcon />,
          onClick: handlers.onHandHistory || (() => {}),
        },
        {
          id: 'leaderboard',
          label: 'Leaderboard',
          icon: <LeaderboardIcon />,
          onClick: handlers.onLeaderboard || (() => {}),
        },
        {
          id: 'settings',
          label: 'Settings',
          icon: <SettingsIcon />,
          onClick: handlers.onSettings || (() => {}),
        },
      ],
    },
    {
      title: 'Support',
      actions: [
        {
          id: 'help',
          label: 'Help & Rules',
          icon: <HelpIcon />,
          onClick: handlers.onHelp || (() => {}),
        },
      ],
    },
    {
      actions: [
        {
          id: 'leave',
          label: 'Leave Table',
          icon: <LeaveTableIcon />,
          onClick: handlers.onLeaveTable || (() => {}),
          danger: true,
        },
      ],
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableMenu({
  isOpen,
  onClose,
  onToggle,
  sections,
  position = 'top-right',
  tableName,
}: TableMenuProps) {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!isOpen) {
      // Reset animation state when menu closes so items animate in on next open
      setVisibleItems(new Set());
      return;
    }
    const allActions = sections.flatMap((s) => s.actions);
    const timeouts = allActions.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 40)
    );
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [isOpen, sections.length]);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  const handleActionClick = useCallback(
    (action: MenuAction) => {
      if (action.disabled) return;
      action.onClick();
      onClose();
    },
    [onClose]
  );

  return (
    <div className={`table-menu table-menu--${position}`} ref={menuRef}>
      {/* Hamburger Button */}
      <button
        className={`table-menu__trigger ${isOpen ? 'table-menu__trigger--active' : ''}`}
        onClick={onToggle}
        aria-label="Table menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="table-menu__hamburger">
          <span />
          <span />
          <span />
        </span>
      </button>

      {/* Backdrop overlay for mobile focus */}
      {isOpen && <div className="table-menu__backdrop" onClick={onClose} aria-hidden="true" />}

      {/* Dropdown */}
      {isOpen && (
        <div className="table-menu__dropdown" role="menu" aria-label={tableName || 'Table menu'}>
          {/* Header */}
          {tableName && (
            <div className="table-menu__header">
              <span className="table-menu__table-name">{tableName}</span>
            </div>
          )}

          {/* Sections */}
          <div className="table-menu__body">
            {sections.map((section, sIdx) => (
              <div
                key={sIdx}
                className="table-menu__section"
                role="group"
                aria-label={section.title}
              >
                {section.title && (
                  <span className="table-menu__section-title">{section.title}</span>
                )}
                {section.actions.map((action, i) => {
                  const actionIndex =
                    sections.slice(0, sections.indexOf(section)).flatMap((s) => s.actions).length +
                    i;
                  return (
                    <button
                      key={action.id}
                      role="menuitem"
                      className={`table-menu__action ${action.danger ? 'table-menu__action--danger' : ''} ${action.disabled ? 'table-menu__action--disabled' : ''}`}
                      onClick={() => handleActionClick(action)}
                      disabled={action.disabled}
                      style={{
                        opacity: visibleItems.has(actionIndex) ? 1 : 0,
                        transform: visibleItems.has(actionIndex)
                          ? 'translateY(0)'
                          : 'translateY(8px)',
                        transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      }}
                    >
                      <span className="table-menu__action-icon">{action.icon}</span>
                      <span className="table-menu__action-label">{action.label}</span>
                      {action.badge && (
                        <span className="table-menu__action-badge">{action.badge}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TableMenu;
