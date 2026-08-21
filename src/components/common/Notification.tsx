/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION — Notification Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './Notification.css';

export interface NotificationItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
  timestamp?: Date;
  read?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface NotificationProps {
  notification: NotificationItem;
  onDismiss?: (id: string) => void;
  onAction?: () => void;
}

/**
 * Single notification item
 */
export function Notification({ notification, onDismiss, onAction }: NotificationProps) {
  const { id, type, title, message, action } = notification;

  const icons = {
    info: 'ℹ',
    success: '✓',
    warning: '⚠',
    error: '✗',
  };

  return (
    <motion.div
      className={`notification notification-${type} ${notification.read ? 'read' : ''}`}
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 100, scale: 0.95 }}
      layout
    >
      <div className="notification-icon">{icons[type]}</div>
      <div className="notification-content">
        {title && <div className="notification-title">{title}</div>}
        <div className="notification-message">{message}</div>
        {action && (
          <button
            className="notification-action"
            onClick={() => {
              action.onClick();
              onAction?.();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      {onDismiss && (
        <button className="notification-dismiss" onClick={() => onDismiss(id)} aria-label="Dismiss">
          ✕
        </button>
      )}
    </motion.div>
  );
}

/**
 * Notification list container
 */
export function NotificationList({
  notifications,
  onDismiss,
  onClearAll,
  maxVisible = 5,
  emptyMessage = 'No notifications',
}: {
  notifications: NotificationItem[];
  onDismiss?: (id: string) => void;
  onClearAll?: () => void;
  maxVisible?: number;
  emptyMessage?: string;
}) {
  const visible = notifications.slice(0, maxVisible);
  const hasMore = notifications.length > maxVisible;

  return (
    <div className="notification-list" role="region" aria-live="polite" aria-label="Notifications">
      {notifications.length > 0 && onClearAll && (
        <div className="notification-list-header">
          <span className="notification-count">
            {notifications.length} Notification{notifications.length !== 1 ? 's' : ''}
          </span>
          <button className="notification-clear-all" onClick={onClearAll}>
            Clear All
          </button>
        </div>
      )}
      <AnimatePresence mode="popLayout">
        {visible.length > 0 ? (
          visible.map((notification) => (
            <Notification key={notification.id} notification={notification} onDismiss={onDismiss} />
          ))
        ) : (
          <motion.div
            className="notification-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            {emptyMessage}
          </motion.div>
        )}
      </AnimatePresence>
      {hasMore && (
        <div className="notification-more">+{notifications.length - maxVisible} More</div>
      )}
    </div>
  );
}

/**
 * Notification badge for showing unread count
 */
export function NotificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;

  return (
    <motion.span
      className="notification-badge"
      initial={{ scale: 0 }}
      animate={{ scale: 1 }}
      exit={{ scale: 0 }}
    >
      {count > 99 ? '99+' : count}
    </motion.span>
  );
}

/**
 * Notification bell icon with badge
 */
export function NotificationBell({ count, onClick }: { count: number; onClick?: () => void }) {
  return (
    <button className="notification-bell" onClick={onClick}>
      <span className="notification-bell-icon">◉</span>
      <AnimatePresence>{count > 0 && <NotificationBadge count={count} />}</AnimatePresence>
    </button>
  );
}

export default Notification;
