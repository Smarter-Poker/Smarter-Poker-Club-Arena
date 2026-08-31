/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  QuickActionsBar — Floating Quick-Access Toolbar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact glassmorphism pill bar above the action panel with commonly-used
 * table toggles. Eliminates deep menu diving for frequent operations.
 *
 * Buttons: Auto-Rebuy | Chat | Stats | Sound | Settings
 * FIX 199: Hand Strength toggle REMOVED — not allowed for live online gameplay
 */

import React, { useState, useCallback } from 'react';
import { haptic } from '../../services/SoundService';
import './QuickActionsBar.css';

export interface QuickActionsBarProps {
  isSoundEnabled: boolean;
  isChatVisible: boolean;
  // FIX 199: isHandStrengthVisible REMOVED — not allowed for live online gameplay
  isStatsVisible: boolean;
  isAutoRebuyEnabled: boolean;
  onToggleSound: () => void;
  onToggleChat: () => void;
  // FIX 199: onToggleHandStrength REMOVED — not allowed for live online gameplay
  onToggleStats: () => void;
  onToggleAutoRebuy: () => void;
  onOpenSettings: () => void;
}

interface QuickAction {
  id: string;
  icon: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

export function QuickActionsBar({
  isSoundEnabled,
  isChatVisible,
  isStatsVisible,
  isAutoRebuyEnabled,
  onToggleSound,
  onToggleChat,
  onToggleStats,
  onToggleAutoRebuy,
  onOpenSettings,
}: QuickActionsBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleAction = useCallback((action: () => void) => {
    haptic.light();
    action();
  }, []);

  const actions: QuickAction[] = [
    {
      id: 'auto-rebuy',
      icon: 'R',
      label: 'Auto-Rebuy',
      isActive: isAutoRebuyEnabled,
      onClick: () => handleAction(onToggleAutoRebuy),
    },
    {
      id: 'chat',
      icon: 'C',
      label: 'Chat',
      isActive: isChatVisible,
      onClick: () => handleAction(onToggleChat),
    },
    // FIX 199: Hand strength toggle REMOVED — not allowed for live online gameplay
    {
      id: 'stats',
      icon: 'S',
      label: 'Stats',
      isActive: isStatsVisible,
      onClick: () => handleAction(onToggleStats),
    },
    {
      id: 'sound',
      icon: isSoundEnabled ? 'V' : 'M',
      label: 'Sound',
      isActive: isSoundEnabled,
      onClick: () => handleAction(onToggleSound),
    },
    {
      id: 'settings',
      icon: 'G',
      label: 'Settings',
      isActive: false,
      onClick: () => handleAction(onOpenSettings),
    },
  ];

  // On mobile, show 3 visible + overflow button
  const visibleActions = isExpanded ? actions : actions.slice(0, 3);
  const hasOverflow = !isExpanded && actions.length > 3;

  return (
    <div className="quick-actions-bar" role="toolbar" aria-label="Quick Actions">
      <div className="qab-pill">
        {visibleActions.map((action) => (
          <button
            key={action.id}
            className={`qab-btn ${action.isActive ? 'qab-btn--active' : ''}`}
            onClick={action.onClick}
            title={action.label}
            aria-pressed={action.isActive}
          >
            <span className="qab-btn__icon">{action.icon}</span>
            <span className="qab-btn__label">{action.label}</span>
          </button>
        ))}

        {hasOverflow && (
          <button
            className="qab-btn qab-btn--more"
            onClick={() => {
              haptic.light();
              setIsExpanded(true);
            }}
            title="More Actions"
          >
            <span className="qab-btn__icon">•••</span>
          </button>
        )}

        {isExpanded && (
          <button
            className="qab-btn qab-btn--collapse"
            onClick={() => {
              haptic.light();
              setIsExpanded(false);
            }}
            title="Collapse"
          >
            <span className="qab-btn__icon">‹</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default QuickActionsBar;
