/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT BADGE — Gamification Badge Display
 * Shows player achievements with unlock animations
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import styles from './AchievementBadge.module.css';

interface AchievementBadgeProps {
  icon: string;
  name: string;
  description: string;
  progress?: number; // 0-100
  unlocked?: boolean;
  rarity?: 'common' | 'rare' | 'epic' | 'legendary';
  unlockedAt?: string;
  onClick?: () => void;
}

const RARITY_COLORS = {
  common: '#9ca3af',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#fbbf24',
};

export default function AchievementBadge({
  icon,
  name,
  description,
  progress = 0,
  unlocked = false,
  rarity = 'common',
  unlockedAt,
  onClick,
}: AchievementBadgeProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const rarityColor = RARITY_COLORS[rarity];

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div
      className={`${styles.badge} ${unlocked ? styles.unlocked : styles.locked} ${styles[rarity] || ''}`}
      style={
        {
          '--rarity-color': rarityColor,
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        } as React.CSSProperties
      }
      onClick={onClick}
    >
      <div className={styles.iconWrapper}>
        <span className={styles.icon}>{icon}</span>
        {!unlocked && progress > 0 && (
          <>
            <svg className={styles.progressRing} viewBox="0 0 100 100">
              <circle className={styles.progressBg} cx="50" cy="50" r="45" />
              <circle
                className={styles.progressFill}
                cx="50"
                cy="50"
                r="45"
                strokeDasharray={`${progress * 2.83} 283`}
              />
            </svg>
            <div className={styles.progressOverlay}>{Math.round(progress)}%</div>
          </>
        )}
        {unlocked && <div className={styles.checkmark}></div>}
      </div>

      <div className={styles.content}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{name}</span>
          <span className={styles.rarityBadge}>{rarity}</span>
        </div>
        <p className={styles.description}>{description}</p>
        {unlocked && unlockedAt && (
          <span className={styles.unlockedDate}>Unlocked {formatDate(unlockedAt)}</span>
        )}
        {!unlocked && progress > 0 && (
          <div className={styles.progressBar}>
            <div className={styles.progressFillBar} style={{ width: `${progress}%` }} />
            <span className={styles.progressText}>{Math.round(progress)}%</span>
          </div>
        )}
        {!unlocked && progress === 0 && <span className={styles.lockedHint}>Locked</span>}
      </div>
    </div>
  );
}

// Achievement Grid Component
export function AchievementGrid({ children }: { children: React.ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
