/**
 * ♠ CLUB ARENA — Quick Actions Panel
 * Floating action shortcut panel for power users
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { STORAGE_KEYS } from '../../lib/storage';
import './QuickActionsPanel.css';

interface QuickAction {
  id: string;
  icon: string;
  label: string;
  shortcut: string;
  action: () => void;
}

export const QuickActionsPanel: React.FC = () => {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [isOpen, setIsOpen] = useState(false);
  const [recentlyUsed, setRecentlyUsed] = useState<string[]>([]);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  const actions: QuickAction[] = useMemo(
    () => [
      {
        id: 'lobby',
        icon: '🎰',
        label: 'Lobby',
        shortcut: 'L',
        action: () => navigateRef.current('/lobby'),
      },
      {
        id: 'create',
        icon: '+',
        label: 'Create Table',
        shortcut: 'N',
        action: () => navigateRef.current('/create-table'),
      },
      {
        id: 'wallet',
        icon: '💰',
        label: 'Wallet',
        shortcut: 'W',
        action: () => navigateRef.current('/wallet'),
      },
      {
        id: 'messages',
        icon: '✉',
        label: 'Messages',
        shortcut: 'M',
        action: () => navigateRef.current('/messages'),
      },
      {
        id: 'friends',
        icon: '●',
        label: 'Friends',
        shortcut: 'F',
        action: () => navigateRef.current('/friends'),
      },
      {
        id: 'stats',
        icon: '📊',
        label: 'Stats',
        shortcut: 'S',
        action: () => navigateRef.current('/stats'),
      },
      {
        id: 'history',
        icon: '📝',
        label: 'Hand History',
        shortcut: 'H',
        action: () => navigateRef.current('/hand-history'),
      },
      {
        id: 'settings',
        icon: '⚙',
        label: 'Settings',
        shortcut: ',',
        action: () => navigateRef.current('/settings'),
      },
    ],
    []
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only activate with Alt/Option key
      if (!e.altKey) return;

      const action = actions.find((a) => a.shortcut.toUpperCase() === e.key.toUpperCase());
      if (action) {
        e.preventDefault();
        executeAction(action);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actions]);

  const executeAction = (action: QuickAction) => {
    action.action();
    setIsOpen(false);

    // Track recently used
    const updated = [action.id, ...recentlyUsed.filter((id) => id !== action.id)].slice(0, 4);
    setRecentlyUsed(updated);
    localStorage.setItem(STORAGE_KEYS.QUICK_ACTIONS_RECENT, JSON.stringify(updated));
  };

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.QUICK_ACTIONS_RECENT);
    if (saved) {
      try {
        setRecentlyUsed(JSON.parse(saved));
      } catch (err) {
        console.error('[QuickActionsPanel] Error:', err);
        localStorage.removeItem(STORAGE_KEYS.QUICK_ACTIONS_RECENT);
      }
    }
  }, []);

  useEffect(() => {
    const sortedActions = [
      ...recentlyUsed.map((id) => actions.find((a) => a.id === id)!).filter(Boolean),
      ...actions.filter((a) => !recentlyUsed.includes(a.id)),
    ];
    sortedActions.forEach((_, i) => {
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
    });
  }, [isOpen, actions, recentlyUsed]);

  const sortedActions = [
    ...recentlyUsed.map((id) => actions.find((a) => a.id === id)!).filter(Boolean),
    ...actions.filter((a) => !recentlyUsed.includes(a.id)),
  ];

  return (
    <>
      {/* Floating Toggle Button */}
      <button
        className={`quick-toggle ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Quick Actions"
      >
        <span className="toggle-icon">{isOpen ? '✕' : '⚡'}</span>
      </button>

      {/* Panel */}
      {isOpen && (
        <>
          <div className="quick-backdrop" onClick={() => setIsOpen(false)} />
          <div className="quick-panel">
            <div className="quick-header">
              <h3>Quick Actions</h3>
              <span className="shortcut-hint">Alt + key</span>
            </div>
            <div className="quick-grid">
              {sortedActions.map((action, i) => (
                <button
                  key={action.id}
                  className="quick-action"
                  onClick={() => executeAction(action)}
                  style={{
                    opacity: visibleItems.has(i) ? 1 : 0,
                    transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <span className="action-icon">{action.icon}</span>
                  <span className="action-label">{action.label}</span>
                  <span className="action-shortcut">⌥{action.shortcut}</span>
                </button>
              ))}
            </div>
            <div className="quick-footer">
              <span>Recently used appear first</span>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default QuickActionsPanel;
