import React from 'react';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './NotificationItem.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

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
  return (
    <div
      className={`notification-item__notification-item ${isRead ? 'read' : 'unread'} type-${type}`}
      onClick={onClick}
    >
      <div className="notif-icon">
        {avatarUrl ? (
          <img
            loading="lazy"
            decoding="async"
            src={avatarUrl}
            alt=""
            onError={(e) => {
              (e.target as HTMLImageElement).src = generateDefaultAvatar();
            }}
          />
        ) : (
          <span>{TYPE_ICONS[type] || ''}</span>
        )}
      </div>

      <div className="notif-content">
        <div className="notif-title">{title}</div>
        <div className="notification-item__notif-message">{message}</div>
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
