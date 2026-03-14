/**
 * ♠ CLUB ARENA — Daily Challenges System
 * Gamification 2.0 with streak rewards and chip progression
 */

import React, { useState, useEffect, useRef } from 'react';

import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import dailyChallengeService from '../../services/DailyChallengeService';
import { masterBus } from '../../core/MasterBus';
import './DailyChallenges.css';

interface Challenge {
  id: string;
  title: string;
  description: string;
  icon: string;
  chipReward: number;
  diamondReward?: number;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
  type: 'daily' | 'weekly' | 'achievement';
}

interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  lastPlayDate: string;
  nextMilestone: number;
  milestoneReward: number;
}

export const DailyChallenges: React.FC = () => {
  const { user } = useAuthUser();
  const toast = useToast();
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [streak, setStreak] = useState<StreakInfo>({
    currentStreak: 0,
    longestStreak: 0,
    lastPlayDate: new Date().toISOString(),
    nextMilestone: 7,
    milestoneReward: 100,
  });

  const [showAnimation, setShowAnimation] = useState(false);
  const [visibleDaily, setVisibleDaily] = useState<Set<number>>(new Set());
  const [visibleWeekly, setVisibleWeekly] = useState<Set<number>>(new Set());
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    if (user?.id) {
      loadChallenges();
    }

    // Bus listeners for real-time progress sync
    const unsubHand = masterBus.subscribe('HAND_COMPLETED', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });
    const unsubReset = masterBus.subscribe('DAILY_RESET_AVAILABLE', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });

    return () => {
      isMounted.current = false;
      unsubHand();
      unsubBalance();
      unsubReset();
    };
  }, [user?.id]);

  const loadChallenges = async () => {
    if (!user?.id) return;
    try {
      const [userChallenges, weeklyChallenges, stats] = await Promise.all([
        dailyChallengeService.getTodaysChallenges(user.id),
        dailyChallengeService.getWeeklyChallenges(user.id),
        dailyChallengeService.getStats(user.id),
      ]);

      const mappedDaily: Challenge[] = userChallenges.map((uc: any) => ({
        id: uc.id,
        title: uc.challenge.name,
        description: uc.challenge.description,
        icon: uc.challenge.icon || '🎯',
        chipReward: uc.challenge.chipReward,
        progress: uc.progress,
        target: uc.challenge.requirement,
        completed: uc.completed,
        claimed: !!uc.claimed,
        type: 'daily' as const,
      }));

      const mappedWeekly: Challenge[] = weeklyChallenges.map((uc: any) => ({
        id: uc.id,
        title: uc.challenge.name,
        description: uc.challenge.description,
        icon: uc.challenge.icon || '📆',
        chipReward: uc.challenge.chipReward,
        diamondReward: uc.challenge.diamondReward,
        progress: uc.progress,
        target: uc.challenge.requirement,
        completed: uc.completed,
        claimed: !!uc.claimed,
        type: 'weekly' as const,
      }));

      const allChallenges = [...mappedDaily, ...mappedWeekly];
      setChallenges(allChallenges);
      setStreak((prev) => ({
        ...prev,
        currentStreak: stats.currentStreak,
      }));

      setVisibleDaily(new Set());
      mappedDaily.forEach((_, i) => {
        setTimeout(() => setVisibleDaily((prev) => new Set(prev).add(i)), i * 60);
      });
      setVisibleWeekly(new Set());
      mappedWeekly.forEach((_, i) => {
        setTimeout(() => setVisibleWeekly((prev) => new Set(prev).add(i)), i * 60);
      });
    } catch (error) {
      console.error('Failed to load daily challenges:', error);
    }
  };

  // Guard against double-claim — Set tracks in-flight claims before React state updates
  const claimingRef = useRef<Set<string>>(new Set());

  const claimReward = async (challenge: Challenge) => {
    if (!challenge.completed || challenge.claimed || !user?.id) return;
    // Race condition guard: block if already in-flight
    if (claimingRef.current.has(challenge.id)) return;
    claimingRef.current.add(challenge.id);

    try {
      // Claim via service → writes to Supabase + credits chips
      await dailyChallengeService.claimChallenge(user.id, challenge.id, challenge.chipReward);

      // Local update AFTER successful Supabase write
      setChallenges((prev) =>
        prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
      );
      setShowAnimation(true);
      toast.success(
        `+${challenge.chipReward} Chips${challenge.diamondReward ? ` +${challenge.diamondReward} 💎` : ''}`
      );
      setTimeout(() => setShowAnimation(false), 2000);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to claim reward');
    } finally {
      claimingRef.current.delete(challenge.id);
    }
  };

  const dailyChallenges = challenges.filter((c) => c.type === 'daily');
  const weeklyChallenges = challenges.filter((c) => c.type === 'weekly');

  return (
    <div className="daily-challenges">
      {/* Streak Display */}
      <div className="streak-card">
        <div className="streak-flame">🔥</div>
        <div className="streak-info">
          <span className="streak-count">{streak.currentStreak} Day Streak!</span>
          <span className="streak-text">
            {streak.nextMilestone - streak.currentStreak} days to {streak.milestoneReward}💎 bonus
          </span>
        </div>
        <div className="streak-calendar">
          {[...Array(7)].map((_, i) => (
            <div key={i} className={`calendar-day ${i < streak.currentStreak % 7 ? 'filled' : ''}`}>
              {i < streak.currentStreak % 7 ? '✓' : '○'}
            </div>
          ))}
        </div>
      </div>

      {/* Daily Challenges */}
      <section className="challenges-section">
        <h3>📅 Daily Challenges</h3>
        <div className="challenges-list">
          {dailyChallenges.map((challenge, i) => (
            <div
              key={challenge.id}
              className={`challenge-card ${challenge.completed ? 'completed' : ''} ${challenge.claimed ? 'claimed' : ''}`}
              style={{
                opacity: visibleDaily.has(i) ? 1 : 0,
                transform: visibleDaily.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="challenge-icon">{challenge.icon}</span>
              <div className="challenge-content">
                <span className="challenge-title">{challenge.title}</span>
                <span className="challenge-desc">{challenge.description}</span>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${challenge.target > 0 ? Math.min((challenge.progress / challenge.target) * 100, 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="progress-text">
                  {challenge.progress}/{challenge.target}
                </span>
              </div>
              <div className="challenge-reward">
                {challenge.completed && !challenge.claimed ? (
                  <button className="claim-btn" onClick={() => claimReward(challenge)}>
                    Claim
                  </button>
                ) : challenge.claimed ? (
                  <span className="claimed-check">✓</span>
                ) : (
                  <span className="chip-badge">+{challenge.chipReward} Chips</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Weekly Challenges */}
      <section className="challenges-section">
        <h3>📆 Weekly Challenges</h3>
        <div className="challenges-list">
          {weeklyChallenges.map((challenge, i) => (
            <div
              key={challenge.id}
              className={`challenge-card ${challenge.completed ? 'completed' : ''} ${challenge.claimed ? 'claimed' : ''}`}
              style={{
                opacity: visibleWeekly.has(i) ? 1 : 0,
                transform: visibleWeekly.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="challenge-icon">{challenge.icon}</span>
              <div className="challenge-content">
                <span className="challenge-title">{challenge.title}</span>
                <span className="challenge-desc">{challenge.description}</span>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${challenge.target > 0 ? Math.min((challenge.progress / challenge.target) * 100, 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="progress-text">
                  {challenge.progress}/{challenge.target}
                </span>
              </div>
              <div className="challenge-reward">
                {challenge.completed && !challenge.claimed ? (
                  <button className="claim-btn" onClick={() => claimReward(challenge)}>
                    Claim
                  </button>
                ) : challenge.claimed ? (
                  <span className="claimed-check">✓</span>
                ) : (
                  <>
                    <span className="chip-badge">+{challenge.chipReward} Chips</span>
                    {challenge.diamondReward && (
                      <span className="diamond-badge">+{challenge.diamondReward} 💎</span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default DailyChallenges;
