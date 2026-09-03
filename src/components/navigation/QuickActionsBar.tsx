/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  QUICK ACTIONS BAR — Fast Access Actions
 * Floating action buttons for common tasks
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

  const actions: QuickAction[] = [];

  if (showMessages) {
    actions.push({
      id: 'messages',
      icon: '',
      label: 'Messages',
      action: onMessageClick || (() => navigate('/messages')),
      badge: unreadMessages,
      color: '#3b82f6',
    });
  }

  if (showWallet) {
    actions.push({
      id: 'wallet',
      icon: '',
      label: 'Wallet',
      action: () => navigate('/wallet'),
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
    action: () => navigate('/leaderboard'),
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
