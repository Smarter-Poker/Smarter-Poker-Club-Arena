/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SMARTER.POKER HEADER — Premium App Header
 * ═══════════════════════════════════════════════════════════════════════════════
 * Standard header used across all non-playing pages
 * Shows: Hub button, Club Arena branding, Diamonds, Icons
 */

import { useNavigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useWalletStore } from '../../stores/useWalletStore';
import { notificationService } from '../../services/NotificationService';
import { messagingService } from '../../services/MessagingService';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useState, useEffect } from 'react';
import './SmarterHeader.css';

interface SmarterHeaderProps {
  showBackButton?: boolean;
  backTo?: string;
  title?: string;
}

export default function SmarterHeader({
  showBackButton = true,
  backTo,
  title,
}: SmarterHeaderProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const { diamonds } = useWalletStore();
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);

  useEffect(() => {
    if (user?.id) {
      // Load unread counts
      notificationService
        .getUnreadCount(user.id)
        .then(setUnreadNotifications)
        .catch((err) => {
          console.warn('[SmarterHeader] Failed to get unread notification count:', err);
        });
      messagingService
        .getUnreadCount(user.id)
        .then(setUnreadMessages)
        .catch((err) => {
          console.warn('[SmarterHeader] Failed to get unread message count:', err);
        });
    }
  }, [user?.id]);

  // Q3: Real-time DM badge updates via MasterBus
  useMasterBusSubscription('UNREAD_DM_COUNT_CHANGED', (payload: any) => {
    setUnreadMessages(payload.count ?? 0);
  });

  useMasterBusSubscription('MESSAGE_RECEIVED', () => {
    // Refresh count on any new message
    if (user?.id) {
      messagingService
        .getUnreadCount(user.id)
        .then(setUnreadMessages)
        .catch((e) => console.warn('[SmarterHeader] Unread DM count refresh failed:', e));
    }
  });

  const handleBack = () => {
    if (backTo) {
      navigate(backTo);
    } else {
      navigate(-1);
    }
  };

  return (
    <header className="smarter-header">
      <div className="header-left">
        {showBackButton && (
          <button className="hub-button" onClick={handleBack}>
            <span className="hub-arrow">←</span>
            <span className="hub-text">{backTo ? 'Hub' : 'Back'}</span>
          </button>
        )}
        <div className="header-brand">
          <img
            loading="lazy"
            decoding="async"
            src={`${import.meta.env.BASE_URL}images/smarter-poker-logo.jpg`}
            alt="Smarter.Poker"
            className="brand-logo"
          />
          {title && <span className="header-title">{title}</span>}
        </div>
      </div>

      <div className="header-center">
        {/* Diamonds */}
        <div className="header-stat diamonds">
          <span className="stat-icon">◆</span>
          <span className="stat-value">{diamonds.toLocaleString()}</span>
          <button className="add-button">+</button>
        </div>
      </div>

      <div className="header-right">
        {/* Avatar */}
        <button className="header-avatar" onClick={() => navigate('/profile')}>
          {user?.avatar_url ? (
            <img loading="lazy" decoding="async" src={user.avatar_url} alt="" />
          ) : (
            <span>●</span>
          )}
        </button>

        {/* Messages */}
        <button className="header-icon-btn" onClick={() => navigate('/messages')}>
          ◈{unreadMessages > 0 && <span className="badge">{unreadMessages}</span>}
        </button>

        {/* Notifications */}
        <button className="header-icon-btn" onClick={() => navigate('/notifications')}>
          ✱{unreadNotifications > 0 && <span className="badge">{unreadNotifications}</span>}
        </button>

        {/* Settings */}
        <button className="header-icon-btn" onClick={() => navigate('/settings')}>
          ⚙
        </button>
      </div>
    </header>
  );
}
