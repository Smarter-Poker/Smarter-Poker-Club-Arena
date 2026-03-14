/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STREAK COUNTER — Self-Contained Streak Display with Supabase Data
 * ═══════════════════════════════════════════════════════════════════════════════
 * Auto-fetches streak data from DailyChallengeService.
 * Can also accept props for parent-controlled mode.
 * Refreshes on DAILY_RESET_AVAILABLE and BALANCE_UPDATED bus events.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import dailyChallengeService from '../../services/DailyChallengeService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import './StreakCounter.css';

interface StreakCounterProps {
  /** If provided, StreakCounter is parent-controlled (no self-fetch) */
  currentStreak?: number;
  longestStreak?: number;
  lastLoginDate?: Date;
  streakBonus?: number;
}

export const StreakCounter: React.FC<StreakCounterProps> = ({
  currentStreak: propStreak,
  longestStreak: propLongest,
  lastLoginDate,
  streakBonus: propBonus,
}) => {
  const { user } = useAuthUser();
  const isMounted = useRef(true);

  // Self-contained mode — fetch data if no props provided
  const selfContained = propStreak === undefined;
  const [currentStreak, setCurrentStreak] = useState(propStreak ?? 0);
  const [longestStreak, setLongestStreak] = useState(propLongest ?? 0);
  const [streakBonus, setStreakBonus] = useState(propBonus ?? 0);
  const [loading, setLoading] = useState(selfContained);

  const loadStreak = useCallback(async () => {
    if (!user?.id || !selfContained) return;
    try {
      const stats = await dailyChallengeService.getStats(user.id);
      if (isMounted.current) {
        setCurrentStreak(stats.currentStreak);
        // longestStreak not tracked in getStats — use currentStreak as fallback
        setLongestStreak((prev) => Math.max(prev, stats.currentStreak));
        // Streak bonus: 5% per 7-day milestone
        const milestoneCount = Math.floor(stats.currentStreak / 7);
        setStreakBonus(milestoneCount * 5);
        setLoading(false);
      }
    } catch (err) {
      console.error('[StreakCounter] load error:', err);
      if (isMounted.current) setLoading(false);
    }
  }, [user?.id, selfContained]);

  // Update from props when in parent-controlled mode
  useEffect(() => {
    if (!selfContained) {
      if (propStreak !== undefined) setCurrentStreak(propStreak);
      if (propLongest !== undefined) setLongestStreak(propLongest);
      if (propBonus !== undefined) setStreakBonus(propBonus);
    }
  }, [selfContained, propStreak, propLongest, propBonus]);

  useEffect(() => {
    isMounted.current = true;
    if (selfContained) loadStreak();

    const unsubReset = masterBus.subscribe('DAILY_RESET_AVAILABLE', () => {
      if (isMounted.current && selfContained) loadStreak();
    });
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', () => {
      if (isMounted.current && selfContained) loadStreak();
    });

    return () => {
      isMounted.current = false;
      unsubReset();
      unsubBalance();
    };
  }, [selfContained, loadStreak]);

  const getMilestone = (streak: number): number => {
    if (streak >= 30) return 30;
    if (streak >= 14) return 14;
    if (streak >= 7) return 7;
    if (streak >= 3) return 3;
    return 0;
  };

  const getNextMilestone = (streak: number): number => {
    if (streak >= 30) return 0;
    if (streak >= 14) return 30;
    if (streak >= 7) return 14;
    if (streak >= 3) return 7;
    return 3;
  };

  if (loading) {
    return (
      <div className="streak-counter" style={{ opacity: 0.5 }}>
        <div className="streak-main">
          <div className="streak-flame"></div>
          <div className="streak-number">—</div>
          <div className="streak-label">Day Streak</div>
        </div>
      </div>
    );
  }

  const milestone = getMilestone(currentStreak);
  const nextMilestone = getNextMilestone(currentStreak);
  const denominator = nextMilestone - milestone;
  const progress = denominator > 0 ? ((currentStreak - milestone) / denominator) * 100 : 100;

  return (
    <div className="streak-counter">
      <div className="streak-main">
        <div className="streak-flame"></div>
        <div className="streak-number">{currentStreak}</div>
        <div className="streak-label">Day Streak</div>
      </div>

      {nextMilestone > 0 && (
        <div className="streak-progress">
          <div className="milestone-bar">
            <div className="milestone-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="milestone-text">
            {nextMilestone - currentStreak} days to {nextMilestone}-day bonus!
          </span>
        </div>
      )}

      <div className="streak-stats">
        <div className="stat">
          <span className="stat-value">{longestStreak}</span>
          <span className="stat-label">Best Streak</span>
        </div>
        {streakBonus > 0 && (
          <div className="stat bonus">
            <span className="stat-value">+{streakBonus}%</span>
            <span className="stat-label">Bonus</span>
          </div>
        )}
      </div>

      {currentStreak >= 7 && (
        <div className="streak-badge">
          {currentStreak >= 30 ? ' Legend' : currentStreak >= 14 ? ' On Fire' : ' Dedicated'}
        </div>
      )}
    </div>
  );
};

export default StreakCounter;
