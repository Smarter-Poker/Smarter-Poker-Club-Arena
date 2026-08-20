/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DAILY CHALLENGE SERVICE — Rotating Challenge Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides rotating daily challenges that refresh each day.
 * Players can complete challenges for chips and other rewards.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every challenge type the app can actually COUNT.
 *
 * This is the single list; ChallengeType is derived from it, so a type cannot
 * exist in the union without appearing here, and the test that checks pool
 * validity iterates this rather than a hand-copied array. That copy had already
 * gone stale once: big_pots and strong_hands shipped to production while the
 * test still asserted against a list that predated them, so the suite was red
 * and asserting the wrong thing at the same time.
 *
 * The bar for adding an entry: something in the app must already increment it.
 * 'login_streak' and 'rakeback_earned' were removed on 2026-08-20 for failing
 * exactly that test -- nothing ever incremented either, so a challenge using
 * one would have been handed out, displayed, and then sat at 0/N forever with
 * nothing to tell the player it was impossible rather than merely hard.
 */
export const CHALLENGE_TYPES = [
  'hands_played',
  'hands_won',
  'showdowns',
  'tournaments_played',
  // Skill/excitement types. Driven by potSize and handRank, which
  // onHandComplete already receives -- see BIG_POT_MIN and isStrongHand below.
  'big_pots',
  'strong_hands',
] as const;

export type ChallengeType = (typeof CHALLENGE_TYPES)[number];

/**
 * A pot at or above this counts as a "big pot" for the big_pots challenges.
 * The threshold lives in the TYPE rather than the requirement because progress
 * is counted per type: "win 3 pots of 500+" is expressible, a separate 5000+
 * tier would need its own type.
 */
export const BIG_POT_MIN = 500;

/**
 * Straight or better, at showdown.
 *
 * handRank arrives as a free-form string from the engine ('Full House',
 * 'full_house', 'FULL HOUSE' have all appeared), so match on a normalised form
 * rather than exact equality -- a challenge that silently never completes is
 * worse than not shipping it.
 */
export function isStrongHand(handRank?: string): boolean {
  if (!handRank) return false;
  const n = handRank
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return (
    n.includes('straight') || // covers 'straight' and 'straight flush'
    n.includes('flush') ||
    n.includes('full house') ||
    n.includes('four of a kind') ||
    n.includes('quads') ||
    n.includes('royal')
  );
}

export interface DailyChallenge {
  id: string;
  name: string;
  description: string;
  type: ChallengeType;
  requirement: number;
  chipReward: number;
  /**
   * Premium currency payout. Authoritative value lives in
   * daily_challenge_catalog.diamond_reward -- this copy is for rendering the
   * card before the claim happens. The server never trusts it.
   */
  diamondReward: number;
  icon: string;
}

/** What a successful claim actually paid out. */
export interface ClaimResult {
  claimed: boolean;
  alreadyClaimed: boolean;
  chips: number;
  diamonds: number;
  diamondBalance: number;
}

export interface UserDailyChallenge {
  id: string;
  challengeId: string;
  userId: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  completedAt?: string;
  challenge: DailyChallenge;
}

/** Which reset period a challenge belongs to. */
export type Tier = 'daily' | 'weekly' | 'monthly';

export interface TieredUserChallenge extends UserDailyChallenge {
  tier: Tier;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE POOL
// ═══════════════════════════════════════════════════════════════════════════════

export const CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'hands_played_5_10',
    name: 'Grinder 5',
    description: 'Play 5 hands today',
    type: 'hands_played',
    requirement: 5,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_played_8_10',
    name: 'Grinder 8',
    description: 'Play 8 hands today',
    type: 'hands_played',
    requirement: 8,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_played_10_10',
    name: 'Grinder 10',
    description: 'Play 10 hands today',
    type: 'hands_played',
    requirement: 10,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_played_12_10',
    name: 'Grinder 12',
    description: 'Play 12 hands today',
    type: 'hands_played',
    requirement: 12,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_played_15_10',
    name: 'Grinder 15',
    description: 'Play 15 hands today',
    type: 'hands_played',
    requirement: 15,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_won_2_10',
    name: 'Winner 2',
    description: 'Win 2 hands today',
    type: 'hands_won',
    requirement: 2,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_won_3_10',
    name: 'Winner 3',
    description: 'Win 3 hands today',
    type: 'hands_won',
    requirement: 3,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_won_4_10',
    name: 'Winner 4',
    description: 'Win 4 hands today',
    type: 'hands_won',
    requirement: 4,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'showdowns_2_10',
    name: 'Showdown 2',
    description: 'Reach 2 showdowns today',
    type: 'showdowns',
    requirement: 2,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'showdowns_3_10',
    name: 'Showdown 3',
    description: 'Reach 3 showdowns today',
    type: 'showdowns',
    requirement: 3,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'showdowns_4_10',
    name: 'Showdown 4',
    description: 'Reach 4 showdowns today',
    type: 'showdowns',
    requirement: 4,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'tournaments_played_1_10',
    name: 'Tourney 1',
    description: 'Play 1 tournaments today',
    type: 'tournaments_played',
    requirement: 1,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'big_pots_1_10',
    name: 'Big Pot 1',
    description: 'Win 1 big pots today',
    type: 'big_pots',
    requirement: 1,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'strong_hands_1_10',
    name: 'Strong Hand 1',
    description: 'Show down 1 strong hands',
    type: 'strong_hands',
    requirement: 1,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'showdowns_1_10',
    name: 'Showdown Artist',
    description: 'Reach showdown in 1 hand today',
    type: 'showdowns',
    requirement: 1,
    chipReward: 0,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hands_played_18_12',
    name: 'Grinder 18',
    description: 'Play 18 hands today',
    type: 'hands_played',
    requirement: 18,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_played_20_12',
    name: 'Grinder 20',
    description: 'Play 20 hands today',
    type: 'hands_played',
    requirement: 20,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_played_25_12',
    name: 'Grinder 25',
    description: 'Play 25 hands today',
    type: 'hands_played',
    requirement: 25,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_won_5_12',
    name: 'Winner 5',
    description: 'Win 5 hands today',
    type: 'hands_won',
    requirement: 5,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_won_6_12',
    name: 'Winner 6',
    description: 'Win 6 hands today',
    type: 'hands_won',
    requirement: 6,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_won_7_12',
    name: 'Winner 7',
    description: 'Win 7 hands today',
    type: 'hands_won',
    requirement: 7,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'showdowns_5_12',
    name: 'Showdown 5',
    description: 'Reach 5 showdowns today',
    type: 'showdowns',
    requirement: 5,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'showdowns_6_12',
    name: 'Showdown 6',
    description: 'Reach 6 showdowns today',
    type: 'showdowns',
    requirement: 6,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'showdowns_7_12',
    name: 'Showdown 7',
    description: 'Reach 7 showdowns today',
    type: 'showdowns',
    requirement: 7,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'tournaments_played_2_12',
    name: 'Tourney 2',
    description: 'Play 2 tournaments today',
    type: 'tournaments_played',
    requirement: 2,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'big_pots_2_12',
    name: 'Big Pot 2',
    description: 'Win 2 big pots today',
    type: 'big_pots',
    requirement: 2,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'strong_hands_2_12',
    name: 'Strong Hand 2',
    description: 'Show down 2 strong hands',
    type: 'strong_hands',
    requirement: 2,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'big_pots_2b_12',
    name: 'Double Stacker',
    description: 'Win 2 pots of 500 or more today',
    type: 'big_pots',
    requirement: 2,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_played_22_12',
    name: 'Grinder 22',
    description: 'Play 22 hands today',
    type: 'hands_played',
    requirement: 22,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_played_24_12',
    name: 'Grinder 24',
    description: 'Play 24 hands today',
    type: 'hands_played',
    requirement: 24,
    chipReward: 0,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hands_played_30_15',
    name: 'Grinder 30',
    description: 'Play 30 hands today',
    type: 'hands_played',
    requirement: 30,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_played_35_15',
    name: 'Grinder 35',
    description: 'Play 35 hands today',
    type: 'hands_played',
    requirement: 35,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_played_40_15',
    name: 'Grinder 40',
    description: 'Play 40 hands today',
    type: 'hands_played',
    requirement: 40,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_played_45_15',
    name: 'Grinder 45',
    description: 'Play 45 hands today',
    type: 'hands_played',
    requirement: 45,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_played_50_15',
    name: 'Grinder 50',
    description: 'Play 50 hands today',
    type: 'hands_played',
    requirement: 50,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_won_8_15',
    name: 'Winner 8',
    description: 'Win 8 hands today',
    type: 'hands_won',
    requirement: 8,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_won_9_15',
    name: 'Winner 9',
    description: 'Win 9 hands today',
    type: 'hands_won',
    requirement: 9,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'showdowns_8_15',
    name: 'Showdown 8',
    description: 'Reach 8 showdowns today',
    type: 'showdowns',
    requirement: 8,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'showdowns_9_15',
    name: 'Showdown 9',
    description: 'Reach 9 showdowns today',
    type: 'showdowns',
    requirement: 9,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'tournaments_played_3_15',
    name: 'Tourney 3',
    description: 'Play 3 tournaments today',
    type: 'tournaments_played',
    requirement: 3,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'big_pots_3_15',
    name: 'Big Pot 3',
    description: 'Win 3 big pots today',
    type: 'big_pots',
    requirement: 3,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'big_pots_4_15',
    name: 'Big Pot 4',
    description: 'Win 4 big pots today',
    type: 'big_pots',
    requirement: 4,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'strong_hands_3_15',
    name: 'Strong Hand 3',
    description: 'Show down 3 strong hands',
    type: 'strong_hands',
    requirement: 3,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'showdowns_7b_15',
    name: 'Showdown Streak',
    description: 'Reach showdown in 7 hands today',
    type: 'showdowns',
    requirement: 7,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_won_10_15',
    name: 'Winner 10',
    description: 'Win 10 hands today',
    type: 'hands_won',
    requirement: 10,
    chipReward: 0,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'hands_played_60_20',
    name: 'Grinder 60',
    description: 'Play 60 hands today',
    type: 'hands_played',
    requirement: 60,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_played_70_20',
    name: 'Grinder 70',
    description: 'Play 70 hands today',
    type: 'hands_played',
    requirement: 70,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_played_75_20',
    name: 'Grinder 75',
    description: 'Play 75 hands today',
    type: 'hands_played',
    requirement: 75,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_played_80_20',
    name: 'Grinder 80',
    description: 'Play 80 hands today',
    type: 'hands_played',
    requirement: 80,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_played_90_20',
    name: 'Grinder 90',
    description: 'Play 90 hands today',
    type: 'hands_played',
    requirement: 90,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_won_11_20',
    name: 'Winner 11',
    description: 'Win 11 hands today',
    type: 'hands_won',
    requirement: 11,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_won_12_20',
    name: 'Winner 12',
    description: 'Win 12 hands today',
    type: 'hands_won',
    requirement: 12,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_won_13_20',
    name: 'Winner 13',
    description: 'Win 13 hands today',
    type: 'hands_won',
    requirement: 13,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_won_14_20',
    name: 'Winner 14',
    description: 'Win 14 hands today',
    type: 'hands_won',
    requirement: 14,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'showdowns_10_20',
    name: 'Showdown 10',
    description: 'Reach 10 showdowns today',
    type: 'showdowns',
    requirement: 10,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'showdowns_11_20',
    name: 'Showdown 11',
    description: 'Reach 11 showdowns today',
    type: 'showdowns',
    requirement: 11,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'showdowns_12_20',
    name: 'Showdown 12',
    description: 'Reach 12 showdowns today',
    type: 'showdowns',
    requirement: 12,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'tournaments_played_4_20',
    name: 'Tourney 4',
    description: 'Play 4 tournaments today',
    type: 'tournaments_played',
    requirement: 4,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'tournaments_played_5_20',
    name: 'Tourney 5',
    description: 'Play 5 tournaments today',
    type: 'tournaments_played',
    requirement: 5,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'big_pots_5_20',
    name: 'Big Pot 5',
    description: 'Win 5 big pots today',
    type: 'big_pots',
    requirement: 5,
    chipReward: 0,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'hands_played_100_25',
    name: 'Grinder 100',
    description: 'Play 100 hands today',
    type: 'hands_played',
    requirement: 100,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'hands_played_120_25',
    name: 'Grinder 120',
    description: 'Play 120 hands today',
    type: 'hands_played',
    requirement: 120,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'hands_played_150_25',
    name: 'Grinder 150',
    description: 'Play 150 hands today',
    type: 'hands_played',
    requirement: 150,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'hands_played_200_25',
    name: 'Grinder 200',
    description: 'Play 200 hands today',
    type: 'hands_played',
    requirement: 200,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'hands_won_15_25',
    name: 'Winner 15',
    description: 'Win 15 hands today',
    type: 'hands_won',
    requirement: 15,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'hands_won_20_25',
    name: 'Winner 20',
    description: 'Win 20 hands today',
    type: 'hands_won',
    requirement: 20,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'hands_won_25_25',
    name: 'Winner 25',
    description: 'Win 25 hands today',
    type: 'hands_won',
    requirement: 25,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'showdowns_15_25',
    name: 'Showdown 15',
    description: 'Reach 15 showdowns today',
    type: 'showdowns',
    requirement: 15,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'showdowns_20_25',
    name: 'Showdown 20',
    description: 'Reach 20 showdowns today',
    type: 'showdowns',
    requirement: 20,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'tournaments_played_6_25',
    name: 'Tourney 6',
    description: 'Play 6 tournaments today',
    type: 'tournaments_played',
    requirement: 6,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'tournaments_played_8_25',
    name: 'Tourney 8',
    description: 'Play 8 tournaments today',
    type: 'tournaments_played',
    requirement: 8,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'tournaments_played_10_25',
    name: 'Tourney 10',
    description: 'Play 10 tournaments today',
    type: 'tournaments_played',
    requirement: 10,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'big_pots_6_25',
    name: 'Big Pot 6',
    description: 'Win 6 big pots today',
    type: 'big_pots',
    requirement: 6,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'big_pots_8_25',
    name: 'Big Pot 8',
    description: 'Win 8 big pots today',
    type: 'big_pots',
    requirement: 8,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'strong_hands_4_25',
    name: 'Strong Hand 4',
    description: 'Show down 4 strong hands',
    type: 'strong_hands',
    requirement: 4,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
];

export const WEEKLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'weekly_hands_250',
    name: 'Weekly Grinder',
    description: 'Play 250 hands this week',
    type: 'hands_played',
    requirement: 250,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'weekly_wins_50',
    name: 'Weekly Winner',
    description: 'Win 50 hands this week',
    type: 'hands_won',
    requirement: 50,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'weekly_tourneys_10',
    name: 'Tournament Specialist',
    description: 'Play 10 tournaments this week',
    type: 'tournaments_played',
    requirement: 10,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'weekly_big_pots_10',
    name: 'Weekly Big Game',
    description: 'Win 10 pots of 500 or more this week',
    type: 'big_pots',
    requirement: 10,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'weekly_strong_hands_8',
    name: 'Weekly Monster Run',
    description: 'Make 8 straights or better this week',
    type: 'strong_hands',
    requirement: 8,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'weekly_showdowns_20',
    name: 'Showdown Machine',
    description: 'Reach 20 showdowns this week',
    type: 'showdowns',
    requirement: 20,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
];

export const MONTHLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'monthly_hands_1000',
    name: 'Monthly Marathon',
    description: 'Play 1,000 hands this month',
    type: 'hands_played',
    requirement: 1000,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'monthly_wins_250',
    name: 'Monthly Dominator',
    description: 'Win 250 hands this month',
    type: 'hands_won',
    requirement: 250,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'monthly_big_pots_50',
    name: 'Monthly Whale',
    description: 'Win 50 pots of 500 or more this month',
    type: 'big_pots',
    requirement: 50,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
  {
    id: 'monthly_tourneys_50',
    name: 'Tournament Master',
    description: 'Play 50 tournaments this month',
    type: 'tournaments_played',
    requirement: 50,
    chipReward: 0,
    diamondReward: 25,
    icon: '',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class DailyChallengeServiceClass {
  /**
   * Fetch (and assign, if needed) the rows for one period.
   *
   * SERVER-AUTHORITATIVE (2026-08-19). The client used to INSERT its own rows
   * and UPDATE its own progress. That required INSERT/UPDATE grants on
   * user_daily_challenges, and the UPDATE policy had no WITH CHECK — so any
   * logged-in user could PATCH {progress: 999999, completed: true} and claim,
   * or INSERT unlimited rows of the highest-paying challenge at made-up period
   * keys. Those grants are now revoked; assignment goes through the
   * assign_user_challenges RPC, which validates every id against
   * daily_challenge_catalog and enforces the period-key shape.
   *
   * The RPC is idempotent: it only inserts when the period is empty, and it
   * always returns the canonical rows, so two tabs racing get the same set.
   */
  private async fetchOrAssign(
    userId: string,
    periodKey: string,
    pool: DailyChallenge[],
    count: number,
    context: string
  ): Promise<any[]> {
    const { data: existing, error: existErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', periodKey);
    if (existErr) reportError(existErr, `DailyChallengeService.${context}_fetch_error`);

    if (existing && existing.length > 0) return existing;

    const chosen =
      pool === CHALLENGE_POOL
        ? this.selectDailyChallenges(count)
        : this.selectChallenges(pool, count, periodKey);

    const { data: assigned, error: rpcErr } = await supabase.rpc('assign_user_challenges', {
      p_assigned_date: periodKey,
      p_challenge_ids: chosen.map((c) => c.id),
    });

    if (rpcErr) {
      reportError(rpcErr, `DailyChallengeService.${context}_assign_error`);
      // Re-read: another tab may have won the assignment race.
      const { data: retry } = await supabase
        .from('user_daily_challenges')
        .select('*')
        .eq('user_id', userId)
        .eq('assigned_date', periodKey);
      return retry || [];
    }

    return assigned || [];
  }

  /**
   * The whole page in ONE round trip, rendered from the SERVER catalog.
   *
   * Two problems this replaces:
   *
   * 1. SIX round trips. Painting /challenges did a SELECT plus a possible
   *    assign RPC for each of daily, weekly and monthly.
   *
   * 2. Worse -- the client rendered every card from its OWN copy of the name,
   *    requirement and rewards while the server paid from
   *    daily_challenge_catalog. Two copies of the same numbers drift, and drift
   *    here is not cosmetic: it is a card promising 7 diamonds beside a balance
   *    that received 3. It has already bitten once, when ids were added to the
   *    client pool that the catalog had never heard of and the claim RPC
   *    rejected every one of them.
   *
   * Now the catalog is the single source of truth for everything displayed, so
   * the shown reward is BY CONSTRUCTION the one claim_daily_challenge will pay.
   * The local pools survive only to CHOOSE which ids to assign.
   *
   * Falls back to the old per-tier path if the RPC is unavailable (an older
   * database, or a deploy where the client is ahead of the migration).
   */
  async getAllChallengesFromServer(userId: string): Promise<{
    daily: TieredUserChallenge[];
    weekly: TieredUserChallenge[];
    monthly: TieredUserChallenge[];
  } | null> {
    const dailyKey = this.getTodayKey();
    const weeklyKey = this.getWeekKey();
    const monthlyKey = this.getMonthKey();

    const { data, error } = await supabase.rpc('get_or_assign_challenges', {
      p_daily_key: dailyKey,
      p_daily_ids: this.selectDailyChallenges(5).map((c) => c.id),
      p_weekly_key: weeklyKey,
      p_weekly_ids: this.selectChallenges(WEEKLY_CHALLENGE_POOL, 3, weeklyKey).map((c) => c.id),
      p_monthly_key: monthlyKey,
      p_monthly_ids: this.selectChallenges(MONTHLY_CHALLENGE_POOL, 2, monthlyKey).map((c) => c.id),
    });

    if (error) {
      reportError(error, 'DailyChallengeService.getAllChallengesFromServer_failed');
      return null; // caller falls back to the per-tier path
    }

    const out = {
      daily: [] as TieredUserChallenge[],
      weekly: [] as TieredUserChallenge[],
      monthly: [] as TieredUserChallenge[],
    };
    for (const row of (data || []) as any[]) {
      const tier: Tier =
        row.assigned_date === dailyKey
          ? 'daily'
          : row.assigned_date === weeklyKey
            ? 'weekly'
            : 'monthly';
      out[tier].push({
        id: row.id,
        challengeId: row.challenge_id,
        userId,
        progress: Number(row.progress) || 0,
        completed: row.completed === true,
        claimed: row.claimed === true,
        completedAt: row.completed_at || undefined,
        tier,
        challenge: {
          id: row.challenge_id,
          name: row.name,
          description: row.description,
          type: row.challenge_type as ChallengeType,
          requirement: Number(row.requirement) || 0,
          chipReward: Number(row.chip_reward) || 0,
          diamondReward: Number(row.diamond_reward) || 0,
          icon: '',
        },
      });
    }
    return out;
  }

  /**
   * Get today's challenges for a user. Assigns a fresh, seeded set if the day
   * has not been assigned yet.
   */
  async getTodaysChallenges(userId: string): Promise<UserDailyChallenge[]> {
    const rows = await this.fetchOrAssign(
      userId,
      this.getTodayKey(),
      CHALLENGE_POOL,
      5,
      'getTodaysChallenges'
    );
    return rows.map((r) => this.mapToUserChallenge(r));
  }

  /**
   * Get this week's challenges for a user
   */
  async getWeeklyChallenges(userId: string): Promise<(UserDailyChallenge & { tier: 'weekly' })[]> {
    const rows = await this.fetchOrAssign(
      userId,
      this.getWeekKey(),
      WEEKLY_CHALLENGE_POOL,
      3,
      'getWeeklyChallenges'
    );
    return rows.map((r) => ({ ...this.mapToUserChallenge(r), tier: 'weekly' as const }));
  }

  /**
   * Get this month's challenges for a user
   */
  async getMonthlyChallenges(
    userId: string
  ): Promise<(UserDailyChallenge & { tier: 'monthly' })[]> {
    const rows = await this.fetchOrAssign(
      userId,
      this.getMonthKey(),
      MONTHLY_CHALLENGE_POOL,
      2,
      'getMonthlyChallenges'
    );
    return rows.map((r) => ({ ...this.mapToUserChallenge(r), tier: 'monthly' as const }));
  }

  /**
   * Streak, with insurance.
   *
   * Server-computed so the freeze can be spent atomically -- freezes are
   * currency, and the client has no write access to challenge_streak_state.
   * A freeze covers exactly one missed day once the streak is worth protecting;
   * the covered day counts, because "your streak was protected" that then shows
   * a smaller number reads as the protection having failed.
   */
  async getStreak(userId: string): Promise<{
    streak: number;
    freezesAvailable: number;
    usedFreeze: boolean;
    frozenDate: string | null;
    nextFreezeIn: number | null;
  }> {
    const fallback = {
      streak: 0,
      freezesAvailable: 0,
      usedFreeze: false,
      frozenDate: null,
      nextFreezeIn: null,
    };
    try {
      const { data, error } = await supabase.rpc('get_challenge_streak', {
        p_user_id: userId,
      });
      if (error) {
        reportError(error, 'DailyChallengeService.getStreak_failed');
        return fallback;
      }
      return {
        streak: Number(data?.streak) || 0,
        freezesAvailable: Number(data?.freezesAvailable) || 0,
        usedFreeze: data?.usedFreeze === true,
        frozenDate: data?.frozenDate || null,
        nextFreezeIn: data?.nextFreezeIn == null ? null : Number(data.nextFreezeIn),
      };
    } catch (e) {
      reportError(e, 'DailyChallengeService.getStreak_threw');
      return fallback;
    }
  }

  /**
   * Advance SEVERAL challenge types in ONE round trip.
   *
   * This is the hot path: it runs for every player on every completed hand.
   * The per-type updateProgress() below costs a SELECT plus one RPC per
   * matching row, so a single hand that played + won + reached showdown could
   * cost ~3 selects and ~8 RPCs per player. bump_challenge_progress does the
   * whole thing in one statement, server-side, reading each requirement from
   * daily_challenge_catalog.
   *
   * @param amounts e.g. { hands_played: 1, hands_won: 1 }
   * @returns `advanced` -- every challenge this call moved, and `completed` --
   *          the subset that crossed the finish line. The RPC used to return
   *          only the second set, which left callers unable to tell "moved but
   *          not done" from "matched nothing", so an open challenges tab had
   *          no signal to refresh on and its progress bars never ticked.
   */
  async bumpProgress(
    userId: string,
    amounts: Partial<Record<ChallengeType, number>>
  ): Promise<{
    advanced: Array<{ id: string; challengeId: string; progress: number; requirement: number }>;
    completed: Array<{
      id: string;
      challengeId: string;
      name: string;
      chipReward: number;
      diamondReward: number;
    }>;
  }> {
    const empty = { advanced: [], completed: [] };
    const cleaned: Record<string, number> = {};
    for (const [k, v] of Object.entries(amounts)) {
      if (typeof v === 'number' && v > 0) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) return empty;

    try {
      const { data, error } = await supabase.rpc('bump_challenge_progress', {
        p_user_id: userId,
        p_amounts: cleaned,
        p_daily_key: this.getTodayKey(),
        p_weekly_key: this.getWeekKey(),
        p_monthly_key: this.getMonthKey(),
      });
      if (error) {
        reportError(error, 'DailyChallengeService.bumpProgress_failed');
        return empty;
      }

      const rows = (data || []) as any[];
      return {
        advanced: rows.map((r) => ({
          id: r.id,
          challengeId: r.challenge_id,
          progress: Number(r.progress) || 0,
          requirement: Number(r.requirement) || 0,
        })),
        completed: rows
          .filter((r) => r.newly_completed === true)
          .map((r) => {
            const meta = this.findInPools(r.challenge_id);
            return {
              id: r.id,
              challengeId: r.challenge_id,
              name: meta?.name || 'Challenge',
              chipReward: Number(r.chip_reward) || 0,
              diamondReward: meta?.diamondReward || 0,
            };
          }),
      };
    } catch (e) {
      reportError(e, 'DailyChallengeService.bumpProgress_threw');
      return empty;
    }
  }

  /** Look a challenge up across all three pools. */
  private findInPools(id: string): DailyChallenge | undefined {
    return (
      CHALLENGE_POOL.find((c) => c.id === id) ||
      WEEKLY_CHALLENGE_POOL.find((c) => c.id === id) ||
      MONTHLY_CHALLENGE_POOL.find((c) => c.id === id)
    );
  }

  /**
   * Update progress on a SINGLE challenge type.
   *
   * Prefer bumpProgress() when advancing more than one type at once -- this
   * form costs a select plus an RPC per matching row. Kept for callers that
   * genuinely only move one counter (a friend added, a tournament entered).
   */
  async updateProgress(
    userId: string,
    type: ChallengeType,
    amount: number = 1
  ): Promise<{ completed: UserDailyChallenge[] }> {
    const today = this.getTodayKey();
    const weekKey = this.getWeekKey();
    const monthKey = this.getMonthKey();
    const completed: UserDailyChallenge[] = [];

    // Get today's/week's/month's active challenges of this type
    const { data: challenges, error: chErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .in('assigned_date', [today, weekKey, monthKey])
      .eq('completed', false);
    if (chErr) reportError(chErr, 'DailyChallengeService.updateProgress_fetch_error');

    if (!challenges) return { completed };

    for (const uc of challenges) {
      // Find challenge from all pools
      const challenge =
        CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        WEEKLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        MONTHLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id);

      if (!challenge || challenge.type !== type) continue;

      // The RPC is the ONLY way progress moves. The client has no UPDATE grant
      // on user_daily_challenges (revoked 2026-08-19 — see fetchOrAssign).
      //
      // The old direct-UPDATE fallback is gone: it could not work post-lockdown,
      // and it was actively harmful before it. PostgREST reports no error for an
      // UPDATE that matches zero rows, so when the RPC declined (row missing, or
      // auth.uid() mismatch) the fallback "succeeded" against nothing and then
      // pushed a fabricated entry onto `completed[]` — firing a
      // "Challenge complete!" toast and a CHALLENGE_PROGRESS_UPDATED bus event
      // for a challenge that had not advanced.
      //
      // p_requirement is still sent for signature compatibility with clients
      // mid-rollout; the server ignores it and reads the catalog instead
      // (passing p_requirement:1 used to complete any challenge instantly).
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        'increment_challenge_progress',
        {
          p_user_id: userId,
          p_challenge_row_id: uc.id,
          p_amount: amount,
          p_requirement: challenge.requirement,
        }
      );

      if (rpcErr) {
        reportError(rpcErr, 'DailyChallengeService.Progress_rpc_failed');
        continue;
      }
      if (!rpcResult?.updated) {
        // Not an error: the row was already complete, or belongs to someone else.
        continue;
      }

      const newProgress: number = rpcResult.progress;
      const isComplete: boolean = rpcResult.completed;

      if (isComplete) {
        completed.push({
          id: uc.id,
          challengeId: uc.challenge_id,
          userId,
          progress: newProgress,
          completed: true,
          claimed: false,
          completedAt: new Date().toISOString(),
          challenge,
        });
      }
    }

    return { completed };
  }

  /**
   * Claim standard chip reward directly from UI
   */
  async claimChallenge(
    userId: string,
    challengeRowId: string,
    rewardAmount: number
  ): Promise<ClaimResult> {
    // Rows that only exist client-side (offline fallback) have a synthetic id,
    // not a uuid. Sending one produces a raw Postgres 22P02 in the user's face.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeRowId)) {
      throw new Error('This challenge is not ready to claim yet. Refresh and try again.');
    }

    // retryAsync retries transient network errors (fetch/timeout/503).
    // The RPC is idempotent: a second claim of an already-claimed row returns
    // false rather than raising, so a commit whose response was lost to a
    // network blip no longer surfaces "Challenge already claimed" as an error
    // for chips the player actually received.
    // Set when the RPC RAISED an "already claimed" error rather than returning
    // the structured alreadyClaimed result. Current server versions return the
    // jsonb, but an older one raises -- and swallowing that error left `data`
    // null, so every field below fell back to 0/false. The page then took the
    // "something was paid" branch and rendered a celebration announcing an
    // empty reward. A duplicate claim has to be reported as a duplicate, not as
    // a prize of nothing.
    let raisedAlreadyClaimed = false;

    const rpcResult = await retryAsync(async () => {
      const result = await supabase.rpc('claim_daily_challenge', {
        p_user_id: userId,
        p_challenge_row_id: challengeRowId,
        p_reward_amount: rewardAmount,
      });
      if (result.error) {
        if (/already claimed/i.test(result.error.message || '')) {
          raisedAlreadyClaimed = true;
          return result; // the reward is already in the account; not a failure
        }
        reportError(result.error, 'DailyChallengeService.RPC_claim_error');
        throw new Error(result.error.message);
      }
      return result;
    }, 3);

    // The RPC returns what it ACTUALLY paid, read from the catalog -- never the
    // client's idea of the reward. Showing a celebration with a number the
    // server did not credit is how a "you won 5 diamonds" toast ends up next to
    // an unchanged balance.
    const paid = (rpcResult as any)?.data || {};

    // NOTE: no client-side ledger write here. claim_daily_challenge credits via
    // atomic_credit_wallet_and_log under the idempotency key
    // 'challenge_claim:<row id>', which already writes the transaction record.
    // The previous WalletService.logTransaction call double-logged with the
    // CLIENT-supplied amount, which the RPC deliberately ignores in favour of
    // the catalog value — so any drift made the audit trail disagree with the
    // wallet, and a retry logged the same reward twice.
    masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_claim', userId });
    // Header/wallet listeners key off this to repaint the diamond count without
    // a page refresh.
    if (Number(paid.diamonds) > 0) {
      masterBus.emit('DIAMOND_BALANCE_CHANGED', {
        newBalance: Number(paid.diamondBalance) || 0,
        delta: Number(paid.diamonds) || 0,
        source: 'daily_challenge_claim',
      });
    }

    return {
      claimed: paid.claimed === true,
      alreadyClaimed: paid.alreadyClaimed === true || raisedAlreadyClaimed,
      chips: Number(paid.chips) || 0,
      diamonds: Number(paid.diamonds) || 0,
      diamondBalance: Number(paid.diamondBalance) || 0,
    };
  }

  /**
   * Get challenge completion stats for a user
   */
  async getStats(userId: string): Promise<{
    totalCompleted: number;
    currentStreak: number;
    totalChipsEarned: number;
    totalDiamondsEarned: number;
    nextMilestone: number;
    milestoneReward: number;
  }> {
    // ORDER BY is load-bearing: an unordered LIMIT returns an arbitrary subset
    // in Postgres, so once a user passed QUERY_LIMITS.MODERATE completions the
    // streak scan below walked a random slice and collapsed to a wrong value.
    const { data, error: statErr } = await supabase
      .from('user_daily_challenges')
      .select('challenge_id, completed, claimed, assigned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .order('assigned_date', { ascending: false })
      .limit(QUERY_LIMITS.MODERATE);
    if (statErr) reportError(statErr, 'DailyChallengeService.getStats_error');

    if (!data) {
      return {
        totalCompleted: 0,
        currentStreak: 0,
        totalChipsEarned: 0,
        totalDiamondsEarned: 0,
        nextMilestone: 7,
        milestoneReward: 500,
      };
    }

    const totalCompleted = data.length;
    let totalChipsEarned = 0;
    let totalDiamondsEarned = 0;

    for (const uc of data) {
      // Only CLAIMED rewards are money the player actually has. Counting
      // completed-but-unclaimed rows made "Chips Earned" overstate the balance.
      if (!uc.claimed) continue;
      const challenge = this.findInPools(uc.challenge_id);
      if (challenge) {
        totalChipsEarned += challenge.chipReward;
        totalDiamondsEarned += challenge.diamondReward;
      }
    }

    // Calculate streak (consecutive days with at least 1 completion)
    // CRITICAL: Filter to DAILY keys only. Weekly keys start with "W" and
    // monthly keys start with "M" — these are NOT valid dates and would
    // produce Invalid Date from subtractDays(), silently breaking the streak.
    const dailyDates = data
      .map((d) => d.assigned_date)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); // Only YYYY-MM-DD
    const dates = [...new Set(dailyDates)].sort().reverse();
    let currentStreak = 0;
    const today = this.getTodayKey();
    const yesterday = this.subtractDays(today, 1);

    // Anchor the walk at today OR yesterday. Anchoring only at today meant a
    // player with a 30-day streak saw "0 day streak" from 00:00 UTC until they
    // completed something — the streak looked broken at the exact moment the
    // UI is trying to persuade them to keep it alive.
    const anchor = dates[0] === today ? today : dates[0] === yesterday ? yesterday : null;
    if (anchor) {
      for (const date of dates) {
        const expectedDate = this.subtractDays(anchor, currentStreak);
        if (date === expectedDate) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    // Dynamic streak milestones — tiered rewards escalate with longer streaks
    const MILESTONES = [
      { days: 7, reward: 500 },
      { days: 14, reward: 1500 },
      { days: 30, reward: 5000 },
      { days: 60, reward: 15000 },
      { days: 100, reward: 50000 },
    ];
    const nextMilestoneEntry =
      MILESTONES.find((m) => m.days > currentStreak) || MILESTONES[MILESTONES.length - 1];
    const nextMilestone = nextMilestoneEntry.days;
    const milestoneReward = nextMilestoneEntry.reward;

    return {
      totalCompleted,
      currentStreak,
      totalChipsEarned,
      totalDiamondsEarned,
      nextMilestone,
      milestoneReward,
    };
  }

  // emitDailyResetReminder removed — was dead code (never called from any file)

  /**
   * Batch fetch all challenge tiers for a user in a single call.
   * Reduces boilerplate for callers that need all three tiers at once.
   */
  async getAllChallenges(userId: string): Promise<{
    daily: TieredUserChallenge[];
    weekly: TieredUserChallenge[];
    monthly: TieredUserChallenge[];
  }> {
    // Preferred path: one round trip, catalog-authoritative.
    const fromServer = await this.getAllChallengesFromServer(userId);
    if (fromServer) return fromServer;

    // Fallback for a database without get_or_assign_challenges. Renders from
    // the local pools, so it carries the drift risk the server path removes --
    // acceptable as a degraded mode, not as the normal one.
    const [daily, weekly, monthly] = await Promise.all([
      this.getTodaysChallenges(userId),
      this.getWeeklyChallenges(userId),
      this.getMonthlyChallenges(userId),
    ]);
    return {
      daily: daily.map((c) => ({ ...c, tier: 'daily' as const })),
      weekly,
      monthly,
    };
  }

  /**
   * Select random challenges for today
   */
  private selectDailyChallenges(count: number): DailyChallenge[] {
    const periodKey = this.getTodayKey();
    const date = new Date(periodKey + 'T00:00:00Z');
    // Number of days since an arbitrary epoch
    const dayIndex = Math.floor(date.getTime() / 86400000);

    // Cycle length is exactly 15 days
    const cycleDay = Math.abs(dayIndex) % 15;

    const buckets = [10, 12, 15, 20, 25];
    const picked: DailyChallenge[] = [];

    for (let i = 0; i < count; i++) {
      const targetReward = buckets[Math.min(i, buckets.length - 1)];
      const bucketPool = CHALLENGE_POOL.filter((c) => c.diamondReward === targetReward);

      // Deterministically sort the bucket so it's always the exact same sequence globally
      const sorted = [...bucketPool].sort((a, b) => a.id.localeCompare(b.id));

      // Pick exactly the challenge corresponding to this cycle day
      const choice = sorted[cycleDay % sorted.length];
      if (choice) picked.push(choice);
    }

    return picked;
  }

  private selectChallenges(
    pool: DailyChallenge[],
    count: number,
    periodKey: string
  ): DailyChallenge[] {
    // Use period-specific seed for DETERMINISTIC selection — prevents race conditions
    // when multiple tabs/instances call this simultaneously before DB insert.
    // Each pool (weekly/monthly) gets a unique seed prefix to avoid collisions.
    const seed = periodKey.replace(/[^a-zA-Z0-9]/g, '');
    return this.seededDiverseSelect(pool, count, seed);
  }

  /**
   * Deterministic seeded selection with type diversity.
   *
   * Shuffles the pool with a well-mixed hash (the old simpleHash barely
   * avalanched: changing the last seed digit shifted every hash by nearly the
   * same amount, so consecutive days produced near-identical sets, and ids
   * with common prefixes clustered — e.g. three tournament challenges the
   * same day). Then greedily picks one challenge per type before allowing a
   * second of any type, so each day's set spans different activities.
   * Fully deterministic per seed — identical across all users/tabs.
   */
  private seededDiverseSelect(
    pool: DailyChallenge[],
    count: number,
    seed: string
  ): DailyChallenge[] {
    const shuffled = [...pool].sort(
      (a, b) => this.mixedHash(`${seed}|${a.id}`) - this.mixedHash(`${seed}|${b.id}`)
    );

    const picked: DailyChallenge[] = [];
    const usedTypes = new Set<ChallengeType>();

    // Pass 1: one per type, in shuffle order
    for (const c of shuffled) {
      if (picked.length >= count) break;
      if (!usedTypes.has(c.type)) {
        usedTypes.add(c.type);
        picked.push(c);
      }
    }
    // Pass 2: fill remaining slots in shuffle order
    for (const c of shuffled) {
      if (picked.length >= count) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return picked;
  }

  /**
   * FNV-1a 32-bit with murmur3 finalizer — strong avalanche so a one-character
   * seed change reorders the whole pool.
   */
  private mixedHash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * Get today's date key (YYYY-MM-DD)
   */
  private getTodayKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Monday of the current UTC week.
   *
   * The old form was `date - getUTCDay() + 1`, which is correct Mon-Sat but
   * wrong on Sunday: getUTCDay() returns 0 there, so it produced
   * `date + 1` = tomorrow, i.e. the Monday that STARTS THE NEXT WEEK. A player
   * grinding on Sunday saw their weekly bar stuck at 0 all day while the
   * progress silently accrued to next week's row, and Sunday could hand out a
   * fresh weekly set that "expired" 24h later.
   */
  private getWeekKey(): string {
    const d = new Date();
    const day = d.getUTCDay(); // 0 = Sunday
    d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
    return `W${d.toISOString().split('T')[0]}`;
  }

  /**
   * Month key, zero-padded. Unpadded ('M2026-8') sorted lexically as
   * 'M2026-10' < 'M2026-3' < 'M2026-9', which silently corrupts any ordering,
   * MIN/MAX or range filter over assigned_date. Existing unpadded rows were
   * backfilled by migration daily_challenges_lockdown_and_catalog_parity, and
   * assign_user_challenges now rejects the unpadded shape outright.
   */
  private getMonthKey(): string {
    const d = new Date();
    return `M${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Subtract days from a date
   */
  private subtractDays(dateStr: string, days: number): string {
    // MUST use UTC operations — getTodayKey() returns UTC date (via toISOString()),
    // so streak calculation must also use UTC to avoid timezone boundary mismatches.
    const date = new Date(dateStr + 'T00:00:00Z'); // Force UTC parse
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().split('T')[0];
  }

  /**
   * Map database row to typed object
   */
  private mapToUserChallenge(row: any): UserDailyChallenge {
    const challenge = this.findInPools(row.challenge_id) || {
      id: row.challenge_id,
      name: 'Unknown',
      description: '',
      type: 'hands_played' as ChallengeType,
      requirement: 0,
      chipReward: 0,
      diamondReward: 0,
      icon: '?',
    };

    return {
      id: row.id,
      challengeId: row.challenge_id,
      userId: row.user_id,
      progress: row.progress,
      completed: row.completed,
      claimed: row.claimed || false,
      completedAt: row.completed_at,
      challenge,
    };
  }
}

export const dailyChallengeService = new DailyChallengeServiceClass();
export default dailyChallengeService;
