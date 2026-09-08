/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  QUICK ACTIONS BAR — Fast Access Actions
 * Floating action buttons for common tasks
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { withClubContext } from '../../utils/clubScopedPath';
import styles from './QuickActionsBar.module.css';

interface QuickAction {
  id: string;
  icon: string;
  label: string;
  action: () => void;
  badge?: number;
  color?: string;
}

interface QuickActionsBarProps {
  clubId?: string;
  showMessages?: boolean;
  showWallet?: boolean;
  showTournaments?: boolean;
  unreadMessages?: number;
  onMessageClick?: () => void;
}

export default function QuickActionsBar({
  clubId,
  showMessages = true,
  showWallet = true,
  showTournaments = true,
  unreadMessages = 0,
  onMessageClick,
}: QuickActionsBarProps) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  /* Dan 2026-09-02: a shortcut opened from inside a club stays inside that
     club. Messages, Wallet and Leaderboard used to navigate to bare global
     paths while Tournaments and Tables (right beside them, from the same
     `clubId` prop) were club-aware — so the same bar both kept and dropped
     the club depending on which button you pressed. `go` closes that gap for
     every entry at once and is a no-op when there is no club. */
  const go = (path: string) => navigate(withClubContext(path, clubId));

  const actions: QuickAction[] = [];

  if (showMessages) {
    actions.push({
      id: 'messages',
      icon: '',
      label: 'Messages',
      action: onMessageClick || (() => go('/messages')),
      badge: unreadMessages,
      color: '#3b82f6',
    });
  }

  if (showWallet) {
    actions.push({
      id: 'wallet',
      icon: '',
      label: 'Wallet',
      action: () => go('/wallet'),
      color: '#10b981',
    });
  }

  if (showTournaments) {
    actions.push({
      id: 'tournaments',
      icon: '',
      label: 'Tournaments',
      action: () => navigate(clubId ? `/clubs/${clubId}/tournaments` : '/tournaments'),
      color: '#fbbf24',
    });
  }

  if (clubId) {
    actions.push({
      id: 'tables',
      icon: '',
      label: 'Tables',
      action: () => navigate(`/clubs/${clubId}/lobby`),
      color: '#a855f7',
    });
  }

  actions.push({
    id: 'leaderboard',
    icon: '',
    label: 'Leaderboard',
    action: () => go('/leaderboard'),
    color: '#f59e0b',
  });

  return (
    <div className={`${styles.container} ${expanded ? styles.expanded : ''}`}>
      {/* Toggle Button */}
      <button className={styles.toggleBtn} onClick={() => setExpanded(!expanded)}>
        {expanded ? '✕' : ''}
      </button>

      {/* Action Buttons */}
      {expanded && (
        <div className={styles.actions}>
          {actions.map((action, index) => (
            <button
              key={action.id}
              className={styles.actionBtn}
              style={
                {
                  '--action-color': action.color,
                  '--animation-delay': `${index * 50}ms`,
                } as React.CSSProperties
              }
              onClick={() => {
                action.action();
                setExpanded(false);
              }}
            >
              <span className={styles.icon}>{action.icon}</span>
              <span className={styles.label}>{action.label}</span>
              {action.badge && action.badge > 0 && (
                <span className={styles.badge}>{action.badge}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
