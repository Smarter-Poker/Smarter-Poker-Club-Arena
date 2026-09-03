/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT NOTIFICATION — Toast-Style Achievement Popup
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { soundService } from '../../services/SoundService';
import './AchievementNotification.css';

interface AchievementNotificationProps {
  achievement: {
    id: string;
    name: string;
    description: string;
    icon: string;
    rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

    diamondReward?: number;
  } | null;
  onDismiss: () => void;
}

const RARITY_COLORS = {
  common: '#9ca3af',
  uncommon: '#22c55e',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#fbbf24',
};

export function AchievementNotification({ achievement, onDismiss }: AchievementNotificationProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (achievement) {
      setIsVisible(true);
      setIsExiting(false);

      // Premium celebratory sparkle on achievement unlock
      soundService.playAchievement();

      // Auto-dismiss after 5 seconds
      const timer = setTimeout(() => {
        handleDismiss();
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [achievement]);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => {
      setIsVisible(false);
      setIsExiting(false);
      onDismiss();
    }, 300);
  };

  if (!achievement || !isVisible) return null;

  return (
    <div
      className={`achievement-notification ${isExiting ? 'exiting' : ''}`}
      style={{ '--rarity-color': RARITY_COLORS[achievement.rarity] } as React.CSSProperties}
      onClick={handleDismiss}
    >
      <div className="achievement-notification__glow" />

      <div className="achievement-notification__content">
        <span className="achievement-notification__icon">{achievement.icon}</span>

        <div className="achievement-notification__info">
          <span className="achievement-notification__title">Achievement Unlocked!</span>
          <span className="achievement-notification__name">{achievement.name}</span>
          <span className="achievement-notification__desc">{achievement.description}</span>
        </div>

        <div className="achievement-notification__rewards">
          {achievement.diamondReward && (
            <span className="reward diamond">+{achievement.diamondReward} </span>
          )}
        </div>
      </div>

      <div className="achievement-notification__rarity">{achievement.rarity.toUpperCase()}</div>
    </div>
  );
}

export default AchievementNotification;
