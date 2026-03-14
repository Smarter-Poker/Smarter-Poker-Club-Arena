/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY CHALLENGES WIDGET — Self-Contained Challenge Display
 * ═══════════════════════════════════════════════════════════════════════════════
 * Displays today's challenges with progress and claim functionality
 * Wired to DailyChallengeService for Supabase data
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  dailyChallengeService,
  type UserDailyChallenge,
} from '../../services/DailyChallengeService';
import { DailyChallenges } from './DailyChallenges';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';

interface Challenge {
  id: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  reward: { type: 'chips' | 'diamonds'; amount: number };
  expiresAt?: Date;
  completed: boolean;
}

export const DailyChallengesWidget: React.FC = () => {
  const { user } = useAuthUser();
  const toast = useToast();
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);

  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    if (!user?.id) return;
    loadChallenges();

    const unsubHand = masterBus.subscribe('HAND_COMPLETED', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });
    const unsubReset = masterBus.subscribe('DAILY_RESET_AVAILABLE', () => {
      if (isMounted.current && user?.id) loadChallenges();
    });

    return () => {
      isMounted.current = false;
      unsubHand();
      unsubReset();
    };
  }, [user?.id]);

  const loadChallenges = async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const data = await dailyChallengeService.getTodaysChallenges(user.id);
      const mapped: Challenge[] = data.map((c: UserDailyChallenge) => ({
        id: c.id,
        title: c.challenge.name,
        description: c.challenge.description,
        progress: c.progress,
        target: c.challenge.requirement,
        reward: {
          type: 'chips',
          amount: c.challenge.chipReward,
        },
        expiresAt: new Date(Date.now() + 86400000), // Expires at end of day
        completed: c.completed,
      }));
      setChallenges(mapped);
    } catch (error) {
      console.error('Failed to load challenges:', error);
    }
    setLoading(false);
  };

  const handleClaimReward = async (challengeId: string) => {
    // Rewards are automatically claimed on completion by the service
    toast.success(' Reward already claimed!');
    // Remove from list
    setChallenges((prev) => prev.filter((c) => c.id !== challengeId));
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
