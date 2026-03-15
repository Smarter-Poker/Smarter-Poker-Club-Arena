import React from 'react';
import './NotificationItem.css';

interface NotificationItemProps {
  id: string;
  type: 'info' | 'success' | 'warning' | 'message' | 'friend' | 'tournament' | 'win';
  title: string;
  message: string;
  timestamp: Date;
  isRead: boolean;
  avatarUrl?: string;
  onClick?: () => void;
  onDismiss?: () => void;
}

const TYPE_ICONS: Record<string, string> = {
  info: '',
  success: '',
  warning: '',
  message: '',
  friend: '',
  tournament: '',
  win: '',
};

export const NotificationItem: React.FC<NotificationItemProps> = ({
  id,
  type,
  title,
  message,
  timestamp,
  isRead,
  avatarUrl,
  onClick,
  onDismiss,
}) => {
  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div
      className={`notification-item ${isRead ? 'read' : 'unread'} type-${type}`}
      onClick={onClick}
    >
      <div className="notif-icon">
        {avatarUrl ? (
          <img loading="lazy" decoding="async" src={avatarUrl} alt="" />
        ) : (
          <span>{TYPE_ICONS[type] || ''}</span>
        )}
      </div>

      <div className="notif-content">
        <div className="notif-title">{title}</div>
        <div className="notif-message">{message}</div>
        <div className="notif-time">{formatTime(timestamp)}</div>
      </div>

      <button
        className="notif-dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss?.();
        }}
      >
        ×
      </button>
    </div>
  );
};

export default NotificationItem;
