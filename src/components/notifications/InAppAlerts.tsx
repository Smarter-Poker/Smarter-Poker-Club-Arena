/**
 * ♠ CLUB ARENA — In-App Alerts
 * Toast-style alerts with actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import './InAppAlerts.css';

export interface Alert {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info' | 'game';
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface InAppAlertsProps {
  alerts: Alert[];
  onDismiss: (id: string) => void;
  position?: 'top' | 'bottom' | 'top-right' | 'bottom-right';
}

export const InAppAlerts: React.FC<InAppAlertsProps> = ({
  alerts,
  onDismiss,
  position = 'top-right',
}) => {
  const [visibleItems, setVisibleItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    alerts.forEach((alert, i) => {
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(alert.id)), i * 60);
    });
  }, [alerts]);

  return (
    <div className={`in-app-alerts position-${position}`}>
      {alerts.map((alert, i) => (
        <div
          key={alert.id}
          style={{
            opacity: visibleItems.has(alert.id) ? 1 : 0,
            transform: visibleItems.has(alert.id) ? 'translateY(0)' : 'translateY(8px)',
            transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          }}
        >
          <AlertItem alert={alert} onDismiss={() => onDismiss(alert.id)} />
        </div>
      ))}
    </div>
  );
};

const AlertItem: React.FC<{ alert: Alert; onDismiss: () => void }> = ({ alert, onDismiss }) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (alert.duration !== 0) {
      const timer = setTimeout(() => {
        handleDismiss();
      }, alert.duration || 5000);
      return () => clearTimeout(timer);
    }
  }, [alert.duration]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(onDismiss, 300);
  }, [onDismiss]);

  const getTypeIcon = () => {
    switch (alert.type) {
      case 'success':
        return '✓';
      case 'error':
        return '✕';
      case 'warning':
        return '⚠';
      case 'info':
        return 'ℹ';
      case 'game':
        return '▦';
    }
  };

  return (
    <div className={`alert-item type-${alert.type} ${isExiting ? 'exiting' : ''}`}>
      <div className="alert-icon">{getTypeIcon()}</div>
      <div className="alert-content">
        <span className="alert-title">{alert.title}</span>
        {alert.message && <span className="alert-message">{alert.message}</span>}
      </div>
      {alert.action && (
        <button className="alert-action" onClick={alert.action.onClick}>
          {alert.action.label}
        </button>
      )}
      <button className="dismiss-btn" onClick={handleDismiss} aria-label="Dismiss Alert">
        ✕
      </button>
    </div>
  );
};

// Alert hook for easy usage
export const useAlerts = () => {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const addAlert = useCallback((alert: Omit<Alert, 'id'>) => {
    const id = Date.now().toString();
    setAlerts((prev) => [...prev, { ...alert, id }]);
    return id;
  }, []);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const success = useCallback(
    (title: string, message?: string) => {
      return addAlert({ type: 'success', title, message });
    },
    [addAlert]
  );

  const error = useCallback(
    (title: string, message?: string) => {
      // This is a SECOND popup surface, separate from the Toast provider, so it
      // needs its own lock on Dan's rule (2026-08-20): no server error text in
      // front of a player. Titles are always hand-written literals at the call
      // site; the detail body is where a caught `e.message` would land, so that
      // is what gets sanitised. See utils/safeErrorMessage.ts.
      return addAlert({
        type: 'error',
        title,
        message: message === undefined ? undefined : safeErrorMessage(message),
        duration: 0,
      });
    },
    [addAlert]
  );

  const warning = useCallback(
    (title: string, message?: string) => {
      return addAlert({ type: 'warning', title, message });
    },
    [addAlert]
  );

  const info = useCallback(
    (title: string, message?: string) => {
      return addAlert({ type: 'info', title, message });
    },
    [addAlert]
  );

  const game = useCallback(
    (title: string, message?: string, action?: Alert['action']) => {
      return addAlert({ type: 'game', title, message, action });
    },
    [addAlert]
  );

  return {
    alerts,
    addAlert,
    dismissAlert,
    success,
    error,
    warning,
    info,
    game,
  };
};

export default InAppAlerts;
