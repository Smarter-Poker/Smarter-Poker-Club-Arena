/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION GROUPER — Categorized notification tabs with count badges
 * ═══════════════════════════════════════════════════════════════════════════════
 * Categorizes notifications: 🎰 Games, 👥 Social, 🏆 Achievements, ⚙️ System
 */

import { useState, useMemo } from 'react';
import { masterBus } from '../../core/MasterBus';
import './NotificationGrouper.css';

type NotificationCategory = 'games' | 'social' | 'achievements' | 'system';

interface Notification {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  timestamp: string;
  read: boolean;
  icon?: string;
}

interface NotificationGrouperProps {
  notifications: Notification[];
  onDismiss?: (id: string) => void;
  onRead?: (id: string) => void;
}

const CATEGORIES: Array<{ id: NotificationCategory; icon: string; label: string }> = [
  { id: 'games', icon: '▦', label: 'Games' },
  { id: 'social', icon: '◉', label: 'Social' },
  { id: 'achievements', icon: '★', label: 'Achievements' },
  { id: 'system', icon: '⚙', label: 'System' },
];

export default function NotificationGrouper({
  notifications,
  onDismiss,
  onRead,
}: NotificationGrouperProps) {
  const [activeCategory, setActiveCategory] = useState<NotificationCategory | 'all'>('all');

  const grouped = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    CATEGORIES.forEach((c) => (counts[c.id] = 0));
    notifications.forEach((n) => {
      if (!n.read) {
        counts[n.category] = (counts[n.category] || 0) + 1;
        counts.all++;
      }
    });
    return counts;
  }, [notifications]);

  const filtered = useMemo(() => {
    if (activeCategory === 'all') return notifications;
    return notifications.filter((n) => n.category === activeCategory);
  }, [notifications, activeCategory]);

  return (
    <div className="notification-grouper">
      {/* Category Tabs */}
      <div className="ng-tabs">
        <button
          className={`ng-tab ${activeCategory === 'all' ? 'active' : ''}`}
          onClick={() => setActiveCategory('all')}
        >
          All
          {grouped.all > 0 && <span className="ng-badge ng-badge-bounce">{grouped.all}</span>}
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`ng-tab ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            <span className="ng-tab-icon">{cat.icon}</span>
            {cat.label}
            {grouped[cat.id] > 0 && (
              <span className="ng-badge ng-badge-bounce">{grouped[cat.id]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Notification List */}
      <div className="ng-list">
        {filtered.length === 0 ? (
          <div className="ng-empty">
            <span className="ng-empty-icon">◉</span>
            <span className="ng-empty-text">No Notifications Here</span>
          </div>
        ) : (
          filtered.map((notif) => (
            <div
              key={notif.id}
              className={`ng-item ${notif.read ? 'read' : 'unread'}`}
              onClick={() => onRead?.(notif.id)}
            >
              <span className="ng-item-icon">
                {notif.icon || CATEGORIES.find((c) => c.id === notif.category)?.icon || '▸'}
              </span>
              <div className="ng-item-content">
                <span className="ng-item-title">{notif.title}</span>
                <span className="ng-item-body">{notif.body}</span>
                <span className="ng-item-time">{new Date(notif.timestamp).toLocaleString()}</span>
              </div>
              {onDismiss && (
                <button
                  className="ng-dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    masterBus.emit('NOTIFICATION_DISMISSED', { notificationId: notif.id });
                    onDismiss(notif.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export type { Notification, NotificationCategory };
