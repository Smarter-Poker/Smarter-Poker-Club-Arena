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
import { supabase } from '../../lib/supabase';

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

    const unsubHand = masterBus.subscribe('HAND_COMPLETED', () => {
      if (isMounted.current && user?.id) loadChallengesRef.current?.();
    });
    // Debounced — BALANCE_UPDATED fires twice per claim (RPC + WalletService)
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', debouncedRefresh);
    const unsubReset = masterBus.subscribe('DAILY_RESET_AVAILABLE', () => {
      if (isMounted.current && user?.id) loadChallengesRef.current?.();
    });

    // Supabase Realtime — cross-tab sync
    const channelKey = `widget-challenges-${user.id}`;
    if (user?.id) {
      const realtimeChannel = masterBus
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
        .subscribe();
    }

    return () => {
      unsubHand();
      unsubBalance();
      unsubReset();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (initTimerRef.current) clearTimeout(initTimerRef.current);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id, debouncedRefresh]);

  const loadChallengesRef = useRef<(() => Promise<void>) | null>(null);

  const loadChallenges = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const [dailyData, weeklyData] = await Promise.all([
        dailyChallengeService.getTodaysChallenges(user.id),
        dailyChallengeService.getWeeklyChallenges(user.id),
      ]);

      if (!isMounted.current) return;

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
        title: `📆 ${c.challenge.name}`,
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

      if (isMounted.current) setChallenges([...mappedDaily, ...mappedWeekly]);
    } catch (error) {
      console.error('Failed to load challenges:', error);
    }
    if (isMounted.current) setLoading(false);
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
      setChallenges((prev) =>
        prev.map((c) => (c.id === challengeId ? { ...c, claimed: true } : c))
      );
      toast.success(`+${challenge.reward.amount} Chips claimed!`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to claim reward');
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
        <span className="empty-icon">★</span>
        <p>All challenges completed for today!</p>
      </div>
    );
  }

  return <DailyChallenges challenges={challenges} onClaimReward={handleClaimReward} />;
};

export default DailyChallengesWidget;
