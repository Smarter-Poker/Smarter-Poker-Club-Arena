/**
 * ♠ CLUB ARENA — Daily Challenges System
 * Gamification 2.0 with streak rewards and chip progression
 *
 * Items 2,4,7,9,10 improvements:
 * - Debounced BALANCE_UPDATED listener (prevents double-fetch on claim)
 * - loadChallenges wrapped in useCallback for stable reference
 * - Supabase Realtime subscription for cross-tab sync
 * - setTimeout animation refs cleaned up on unmount
 * - Loading skeleton shown during initial data fetch
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';

import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import dailyChallengeService from '../../services/DailyChallengeService';
import { masterBus } from '../../core/MasterBus';
import { supabase } from '../../lib/supabase';
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
  const [loading, setLoading] = useState(true);
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
  const isMounted = useIsMounted();

  // Item 9: Track animation timeouts for cleanup
  const animTimers = useRef<number[]>([]);

  // Item 2: Debounce ref to coalesce rapid BALANCE_UPDATED events
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Item 4: Stable loadChallenges via useCallback
  const loadChallenges = useCallback(async () => {
    if (!user?.id) return;
    try {
      const [userChallenges, weeklyChallenges, stats] = await Promise.all([
        dailyChallengeService.getTodaysChallenges(user.id),
        dailyChallengeService.getWeeklyChallenges(user.id),
        dailyChallengeService.getStats(user.id),
      ]);

      if (!isMounted.current) return;

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
      setLoading(false);

      // Item 9: Clear old timers before setting new ones
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];

      setVisibleDaily(new Set());
      mappedDaily.forEach((_, i) => {
        const t = window.setTimeout(() => setVisibleDaily((prev) => new Set(prev).add(i)), i * 60);
        animTimers.current.push(t);
      });
      setVisibleWeekly(new Set());
      mappedWeekly.forEach((_, i) => {
        const t = window.setTimeout(() => setVisibleWeekly((prev) => new Set(prev).add(i)), i * 60);
        animTimers.current.push(t);
      });
    } catch (error) {
      console.error('Failed to load daily challenges:', error);
      if (isMounted.current) setLoading(false);
    }
  }, [user?.id]);

  // Item 2: Debounced refresh — coalesces rapid bus events into single fetch
  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (isMounted.current && user?.id) loadChallenges();
    }, 150);
  }, [loadChallenges, user?.id]);

  useEffect(() => {
    if (user?.id) {
      loadChallenges();
    }

    // Bus listeners for real-time progress sync
    const unsubHand = masterBus.subscribe('HAND_COMPLETED', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });
    // Item 2: BALANCE_UPDATED is debounced (fires twice per claim — once from RPC, once from WalletService)
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', debouncedRefresh);
    const unsubReset = masterBus.subscribe('DAILY_RESET_AVAILABLE', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });

    // Item 7: Supabase Realtime subscription for cross-tab sync
    let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
    if (user?.id) {
      realtimeChannel = supabase
        .channel(`daily-challenges-${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'user_daily_challenges',
            filter: `user_id=eq.${user.id}`,
          },
          () => {
            if (isMounted.current) debouncedRefresh();
          }
        )
        .subscribe();
    }

    return () => {
      unsubHand();
      unsubBalance();
      unsubReset();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Item 9: Clear animation timers
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
      // Item 7: Unsubscribe Realtime
      if (realtimeChannel) supabase.removeChannel(realtimeChannel);
    };
  }, [user?.id, loadChallenges, debouncedRefresh]);

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

      if (!isMounted.current) return;

      // Local update AFTER successful Supabase write
      setChallenges((prev) =>
        prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
      );
      setShowAnimation(true);
      toast.success(
        `+${challenge.chipReward} Chips${challenge.diamondReward ? ` +${challenge.diamondReward} 💎` : ''}`
      );
      const animT = window.setTimeout(() => {
        if (isMounted.current) setShowAnimation(false);
      }, 2000);
      animTimers.current.push(animT);
    } catch (err: any) {
      if (isMounted.current) toast.error(err?.message || 'Failed to claim reward');
    } finally {
      claimingRef.current.delete(challenge.id);
    }
  };

  const dailyChallenges = challenges.filter((c) => c.type === 'daily');
  const weeklyChallenges = challenges.filter((c) => c.type === 'weekly');

  // Item 10: Loading skeleton
  if (loading) {
    return (
      <div className="daily-challenges">
        <div className="streak-card" style={{ opacity: 0.5 }}>
          <div className="streak-flame">🔥</div>
          <div className="streak-info">
            <span
              className="streak-count"
              style={{
                background: 'rgba(255,255,255,0.1)',
                borderRadius: 4,
                display: 'inline-block',
                width: 120,
                height: 20,
              }}
            >
              &nbsp;
            </span>
          </div>
        </div>
        <section className="challenges-section">
          <h3>📅 Daily Challenges</h3>
          <div className="challenges-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="challenge-card" style={{ opacity: 0.4 }}>
                <span className="challenge-icon">⏳</span>
                <div className="challenge-content">
                  <span
                    className="challenge-title"
                    style={{
                      background: 'rgba(255,255,255,0.08)',
                      borderRadius: 4,
                      display: 'inline-block',
                      width: '60%',
                      height: 14,
                    }}
                  >
                    &nbsp;
                  </span>
                  <span
                    className="challenge-desc"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: 4,
                      display: 'inline-block',
                      width: '80%',
                      height: 12,
                      marginTop: 4,
                    }}
                  >
                    &nbsp;
                  </span>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: '0%' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="daily-challenges">
      {showAnimation && <div className="claim-animation">✨</div>}

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
