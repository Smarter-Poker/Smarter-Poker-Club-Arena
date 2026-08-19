/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY CHALLENGES WIDGET — Self-Contained Challenge Display
 * ═══════════════════════════════════════════════════════════════════════════════
 * Displays today's challenges with progress and claim functionality
 * Wired to DailyChallengeService for Supabase data
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import {
  dailyChallengeService,
  type UserDailyChallenge,
} from '../../services/DailyChallengeService';
import { DailyChallenges } from './DailyChallenges';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { reportError } from '../../utils/errorReporter';

interface Challenge {
  id: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  reward: { type: 'chips' | 'diamonds'; amount: number };
  expiresAt?: Date;
  completed: boolean;
  claimed: boolean;
}

export const DailyChallengesWidget: React.FC = () => {
  const { user } = useAuthUser();
  const toast = useToast();
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoadDoneRef = useRef(false);
  const loadErrorRef = useRef(false);
  const previousChallengesRef = useRef<Challenge[]>([]);

  const isMounted = useIsMounted();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (isMounted.current && user?.id) loadChallengesRef.current?.();
    }, 150);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    // Use ref for initial load to avoid stale closure (loadChallenges not in deps)
    initTimerRef.current = setTimeout(() => loadChallengesRef.current?.(), 0);

    // Supabase Realtime — cross-tab sync
    const channelKey = `widget-challenges-${user.id}`;
    if (user?.id) {
      masterBus
        .getOrCreateChannel(channelKey)
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
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err)
              reportError(err?.message || err, 'DailyChallengesWidget._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[DailyChallengesWidget] Realtime channel timed out');
          }
        });
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (initTimerRef.current) clearTimeout(initTimerRef.current);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id, debouncedRefresh]);

  // Bus listeners for challenge progress
  // Debounced — updateProgress() in AchievementTriggerService needs time to write to DB
  useMasterBusSubscription('HAND_COMPLETED', debouncedRefresh);

  // Debounced — BALANCE_UPDATED fires on claim via DailyChallengeService
  useMasterBusSubscription('BALANCE_UPDATED', debouncedRefresh);

  // Refresh when challenge progress is updated (from AchievementTriggerService)
  // NOTE: Do NOT show a completion toast here — CHALLENGE_PROGRESS_UPDATED fires
  // on EVERY progress increment, not just completions. Showing "completed!" on
  // every hand played is misleading. The completion celebration is handled by
  // the AchievementTriggerService when it detects a challenge is actually complete.
  useMasterBusSubscription('CHALLENGE_PROGRESS_UPDATED', debouncedRefresh);

  const loadChallengesRef = useRef<(() => Promise<void>) | null>(null);

  const loadChallenges = useCallback(async () => {
    if (!user?.id) return;
    // Only show loading spinner on initial load — bus-triggered refreshes
    // happen silently to avoid distracting UI flashes on every hand played
    if (!initialLoadDoneRef.current) setLoading(true);
    try {
      const {
        daily: dailyData,
        weekly: weeklyData,
        monthly: monthlyData,
      } = await dailyChallengeService.getAllChallenges(user.id);

      if (!isMounted.current) return;
      loadErrorRef.current = false;

      const mappedDaily: Challenge[] = dailyData.map((c: UserDailyChallenge) => ({
        id: c.id,
        title: c.challenge.name,
        description: c.challenge.description,
        progress: c.progress,
        target: c.challenge.requirement,
        reward: {
          type: 'chips',
          amount: c.challenge.chipReward,
        },
        expiresAt: new Date(Date.now() + 86400000),
        completed: c.completed,
        claimed: !!c.claimed,
      }));

      const mappedWeekly: Challenge[] = weeklyData.map((c: any) => ({
        id: c.id,
        title: `${c.challenge.name}`,
        description: c.challenge.description,
        progress: c.progress,
        target: c.challenge.requirement,
        reward: {
          type: 'chips',
          amount: c.challenge.chipReward,
        },
        completed: c.completed,
        claimed: !!c.claimed,
      }));

      const mappedMonthly: Challenge[] = monthlyData.map((c: any) => ({
        id: c.id,
        title: `${c.challenge.name}`,
        description: c.challenge.description,
        progress: c.progress,
        target: c.challenge.requirement,
        reward: {
          type: 'chips',
          amount: c.challenge.chipReward,
        },
        completed: c.completed,
        claimed: !!c.claimed,
      }));

      const newChallenges = [...mappedDaily, ...mappedWeekly, ...mappedMonthly];

      // Completion celebration — detect newly completed challenges
      if (initialLoadDoneRef.current && isMounted.current) {
        for (const nc of newChallenges) {
          if (nc.completed && !nc.claimed) {
            const prev = previousChallengesRef.current.find((p) => p.id === nc.id);
            if (prev && !prev.completed) {
              toast.success(
                `Challenge complete: ${nc.title}! Claim your +${nc.reward.amount} Chips`
              );
            }
          }
        }
      }
      previousChallengesRef.current = newChallenges;

      if (isMounted.current) setChallenges(newChallenges);
    } catch (error) {
      reportError(error, 'DailyChallengesWidget.Failed_to_load_challenges');
      loadErrorRef.current = true;
    }
    if (isMounted.current) {
      setLoading(false);
      initialLoadDoneRef.current = true;
    }
  }, [user?.id]);

  // Keep ref in sync for debouncedRefresh
  useEffect(() => {
    loadChallengesRef.current = loadChallenges;
  }, [loadChallenges]);

  // Double-claim guard
  const claimingRef = useRef<Set<string>>(new Set());

  const handleClaimReward = async (challengeId: string) => {
    if (!user?.id) return;
    if (claimingRef.current.has(challengeId)) return;
    claimingRef.current.add(challengeId);

    const challenge = challenges.find((c) => c.id === challengeId);
    if (!challenge || challenge.claimed) {
      claimingRef.current.delete(challengeId);
      return;
    }

    try {
      await dailyChallengeService.claimChallenge(user.id, challengeId, challenge.reward.amount);
      if (!isMounted.current) return;
      setChallenges((prev) =>
        prev.map((c) => (c.id === challengeId ? { ...c, claimed: true } : c))
      );
      if (isMounted.current) toast.success(`+${challenge.reward.amount} Chips claimed!`);
      // NOTE: BALANCE_UPDATED is already emitted by DailyChallengeService.claimChallenge — no duplicate emission needed
    } catch (err: any) {
      if (isMounted.current) toast.error(err?.message || 'Failed to claim reward');
    } finally {
      claimingRef.current.delete(challengeId);
    }
  };

  if (loading) {
    return (
      <div className="daily-challenges-widget loading">
        <div className="loading-spinner" />
        <p>Loading challenges...</p>
      </div>
    );
  }

  if (challenges.length === 0) {
    return (
      <div className="daily-challenges-widget empty">
        <span className="empty-icon">{loadErrorRef.current ? '⚠' : '★'}</span>
        <p>
          {loadErrorRef.current
            ? 'Could not load challenges. Pull to refresh.'
            : 'All challenges completed for today!'}
        </p>
      </div>
    );
  }

  return <DailyChallenges challenges={challenges} onClaimReward={handleClaimReward} />;
};

export default DailyChallengesWidget;
