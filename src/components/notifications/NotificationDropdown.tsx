import React from 'react';
import { NotificationItem } from './NotificationItem';
import './NotificationDropdown.css';

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'message' | 'friend' | 'tournament' | 'win';
  title: string;
  message: string;
  timestamp: Date;
  isRead: boolean;
  avatarUrl?: string;
}

interface NotificationDropdownProps {
  isOpen: boolean;
  notifications: Notification[];
  onClose: () => void;
  onNotificationClick?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onMarkAllRead?: () => void;
  onClearAll?: () => void;
}

export const NotificationDropdown: React.FC<NotificationDropdownProps> = ({
  isOpen,
  notifications,
  onClose,
  onNotificationClick,
  onDismiss,
  onMarkAllRead,
  onClearAll,
}) => {
  if (!isOpen) return null;

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <>
      <div className="dropdown-backdrop" onClick={onClose} />
      <div className="notification-dropdown">
        <div className="dropdown-header">
          <h3>Notifications</h3>
          {unreadCount > 0 && (
            <button className="mark-read-btn" onClick={onMarkAllRead}>
              Mark All Read
            </button>
          )}
        </div>

        <div className="dropdown-content">
          {notifications.length === 0 ? (
            <div className="empty-state">
              <span>✱</span>
              <p>No Notifications Yet</p>
            </div>
          ) : (
            notifications.map((notif) => (
              <NotificationItem
                key={notif.id}
                {...notif}
                onClick={() => onNotificationClick?.(notif.id)}
                onDismiss={() => onDismiss?.(notif.id)}
              />
            ))
          )}
        </div>

        {notifications.length > 0 && (
          <div className="dropdown-footer">
            <button onClick={onClearAll}>Clear All</button>
          </div>
        )}
      </div>
    </>
  );
};

export default NotificationDropdown;
