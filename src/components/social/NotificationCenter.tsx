/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔔 NOTIFICATION CENTER — Global Alerts
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Popup notification list.
 * - Game invites
 * - Friend requests
 * - System announcements (Maintenance, Bonuses)
 * - Clear all / Dismiss specific
 */

import React from 'react';
import './NotificationCenter.css';

export type NotificationType = 'invite' | 'request' | 'system' | 'bonus';

export interface NotificationItem {
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    timestamp: string;
    isRead: boolean;
    actionPayload?: any; // e.g. tableId for invites
}

export interface NotificationCenterProps {
    isOpen: boolean;
    onClose: () => void;
    notifications: NotificationItem[];
    onMarkAsRead: (id: string) => void;
    onClearAll: () => void;
    onAction: (notification: NotificationItem) => void;
}

export function NotificationCenter({
    isOpen,
    onClose,
    notifications,
    onMarkAsRead,
    onClearAll,
    onAction,
}: NotificationCenterProps) {
    if (!isOpen) return null;

    return (
        <>
            <div className="notification-backdrop" onClick={onClose} />
            <div className="notification-panel">
                {/* Header */}
                <div className="notification-header">
                    <h3 className="notification-title">Notifications</h3>
                    <div className="header-actions">
                        {notifications.length > 0 && (
                            <button className="clear-btn" onClick={onClearAll}>Clear All</button>
                        )}
                        <button className="close-btn" onClick={onClose}>×</button>
                    </div>
                </div>

                {/* Content */}
                <div className="notification-list">
                    {notifications.length > 0 ? (
                        notifications.map((notif) => (
                            <div
                                key={notif.id}
                                className={`notification-item ${notif.isRead ? 'read' : 'unread'} type-${notif.type}`}
                                onClick={() => {
                                    onMarkAsRead(notif.id);
                                    if (notif.actionPayload) onAction(notif);
                                }}
                            >
                                <div className="notif-icon-col">
                                    <span className={`notif-icon icon-${notif.type}`}>
                                        {getIcon(notif.type)}
                                    </span>
                                </div>
                                <div className="notif-content-col">
                                    <span className="notif-title">{notif.title}</span>
                                    <p className="notif-message">{notif.message}</p>
                                    <span className="notif-time">{notif.timestamp}</span>
                                </div>
                                {!notif.isRead && <span className="unread-dot" />}
                            </div>
                        ))
                    ) : (
                        <div className="notification-empty">
                            <span className="empty-icon">🔕</span>
                            <p>No new notifications</p>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}

function getIcon(type: NotificationType): string {
    switch (type) {
        case 'invite': return '💌';
        case 'request': return '👥';
        case 'system': return '⚙️';
        case 'bonus': return '🎁';
        default: return '📢';
    }
}

export default NotificationCenter;
