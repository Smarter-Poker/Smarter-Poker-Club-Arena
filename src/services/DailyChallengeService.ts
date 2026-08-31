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
import { retryFetch } from '../utils/retryFetch';
import { reportError } from '../utils/errorReporter';
import { titleCase } from '../utils/titleCase';
import { uuid } from '../utils/uuid';

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
  // Volume and outcome. Counted once per hand from the payload
  // onHandComplete already receives: { won, potSize, handRank, showdown }.
  'hands_played',
  'hands_won',
  'showdowns',
  'showdowns_won',
  'hands_won_no_showdown',
  // Magnitude types. These carry a per-row `threshold` the counter must meet
  // before the hand counts, which is what lets one type express "500 or more"
  // and "5,000 or more" as separate, self-describing challenges instead of one
  // vague "big pot". See MAGNITUDE_TYPES and handRankScore.
  'big_pots',
  'strong_hands',
  // Cumulative: the amount bumped is the chips won, not a count of 1.
  'chips_won',
  // Out-of-hand counters, bumped by their own call sites.
  'tournaments_played',
  'friends_added',
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
 * Challenge types whose rows carry a magnitude `threshold`.
 *
 * The bump call sends a per-type measurement alongside the count, and
 * bump_challenge_progress only advances a row when that measurement meets the
 * row's threshold. A type not listed here ignores magnitude entirely.
 */
export const MAGNITUDE_TYPES = ['big_pots', 'strong_hands'] as const;

/**
 * Poker hand strength as a comparable number, 1 (high card) to 10 (royal
 * flush), or 0 when the hand is unknown.
 *
 * handRank arrives as a free-form string from the engine ('Full House',
 * 'full_house' and 'FULL HOUSE' have all appeared in production), so this
 * normalises before matching. ORDER MATTERS in the checks below: 'straight
 * flush' contains both 'straight' and 'flush', and 'royal flush' contains
 * 'flush', so the strongest patterns are tested first. Testing 'flush' first
 * would score a royal flush as a 6 and quietly fail every quads-or-better
 * challenge a player legitimately earned.
 */
export function handRankScore(handRank?: string): number {
  if (!handRank) return 0;
  const n = handRank
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
  if (n.includes('royal')) return 10;
  if (n.includes('straight flush')) return 9;
  if (n.includes('four of a kind') || n.includes('quads')) return 8;
  if (n.includes('full house') || n.includes('boat')) return 7;
  if (n.includes('flush')) return 6;
  if (n.includes('straight')) return 5;
  if (n.includes('three of a kind') || n.includes('trips') || n.includes('set')) return 4;
  if (n.includes('two pair')) return 3;
  if (n.includes('pair')) return 2;
  if (n.includes('high card')) return 1;
  return 0;
}

/**
 * Straight or better, at showdown.
 *
 * handRank arrives as a free-form string from the engine ('Full House',
 * 'full_house', 'FULL HOUSE' have all appeared), so match on a normalised form
 * rather than exact equality -- a challenge that silently never completes is
 * worse than not shipping it.
 */
export function isStrongHand(handRank?: string): boolean {
  return handRankScore(handRank) >= 5;
}

export interface DailyChallenge {
  id: string;
  name: string;
  description: string;
  type: ChallengeType;
  requirement: number;
  /**
   * Minimum magnitude a single event must reach to count toward this row.
   *
   * For `big_pots` it is a chip amount; for `strong_hands` it is a
   * handRankScore floor (5 straight, 6 flush, 7 full house, 8 quads). Undefined
   * means every qualifying event counts, which is the correct reading for a
   * pure counter like hands_played.
   *
   * Living on the ROW rather than in the type is the whole fix for Dan's
   * "it's not even specified how much a big pot is": the number is now per
   * challenge, so the description can quote it and the server can enforce it.
   */
  threshold?: number;
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

/** One replay-safe receipt for one or many completed mission contracts. */
export interface ClaimBatchResult {
  success: boolean;
  replayed: boolean;
  claimedIds: string[];
  alreadyClaimedIds: string[];
  chips: number;
  diamonds: number;
  diamondBalance: number;
  stats: Pick<DailyChallengeStats, 'totalClaimed' | 'totalChipsEarned' | 'totalDiamondsEarned'>;
  vault: DailyChallengeRewardVault;
}

/** What the atomic reroll RPC actually changed and charged. */
export interface RerollResult {
  success: boolean;
  alreadyRerolled: boolean;
  challengeId?: string;
  challenge?: TieredUserChallenge;
  diamondBalance?: number;
  error?: string;
}

/** Authoritative receipt returned by a streak-freeze purchase. */
export interface FreezePurchaseResult {
  success: boolean;
  alreadyPurchased: boolean;
  freezesAvailable?: number;
  diamondBalance?: number;
  error?: string;
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

export interface DailyChallengeStats {
  totalCompleted: number;
  totalClaimed: number;
  currentStreak: number;
  totalChipsEarned: number;
  totalDiamondsEarned: number;
  milestoneStart: number;
  nextMilestone: number;
  milestoneReward: number;
  milestoneProgressPercent: number;
  daysToMilestone: number;
}

export interface ChallengeStreak {
  streak: number;
  freezesAvailable: number;
  usedFreeze: boolean;
  frozenDate: string | null;
  nextFreezeIn: number | null;
}

export interface DailyChallengeRewardVault {
  count: number;
  chips: number;
  diamonds: number;
  items: TieredUserChallenge[];
  pageSize: number;
  hasMore: boolean;
}

export interface DailyChallengeDashboard {
  missions: TieredUserChallenge[];
  stats: DailyChallengeStats;
  streak: ChallengeStreak;
  diamondBalance: number;
  vault: DailyChallengeRewardVault;
  syncedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE POOL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE DAILY POOL.
 *
 * Dan 2026-08-21: "COME UP WITH SPECIFIC CHALLENGES, DO NOT USE GENERIC
 * 'BIG POT 4' WIN 4 BIG POTS SMH ITS NOT EVEN SPECIFIED HOW MUCH A BIG POT IS."
 *
 * Every description states its own numbers. "Win 3 Pots Worth 1,000 Chips Or
 * More Today" is the whole rule on the face of the card; a player never has to
 * guess what the game considers big, strong or enough.
 *
 * That is what `threshold` is for. The previous build hardcoded a single
 * BIG_POT_MIN = 500 into the challenge TYPE, so the catalog could express
 * exactly one size of big pot and had to describe it vaguely to stay true. The
 * size now lives on the ROW, so 500 / 1,000 / 2,500 / 5,000 tiers coexist and
 * each one says which it is. Same mechanism ranks hands: threshold 5 is a
 * straight, 6 a flush, 7 a full house, 8 quads (see handRankScore).
 *
 * GENERATED, NOT TYPED. This block and the daily_challenge_catalog rows in
 * 20260821_specific_challenge_catalog.sql are emitted from one definition, so
 * the card the player reads and the reward the server pays cannot drift.
 */
export const CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'hp_10',
    name: 'First Ten',
    description: 'Play 10 Hands Today',
    type: 'hands_played',
    requirement: 10,
    chipReward: 500,
    diamondReward: 8,
    icon: '',
  },
  {
    id: 'hp_25',
    name: 'Warmed Up',
    description: 'Play 25 Hands Today',
    type: 'hands_played',
    requirement: 25,
    chipReward: 1200,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hp_50',
    name: 'Half Century',
    description: 'Play 50 Hands Today',
    type: 'hands_played',
    requirement: 50,
    chipReward: 2500,
    diamondReward: 18,
    icon: '',
  },
  {
    id: 'hp_100',
    name: 'Century Grind',
    description: 'Play 100 Hands Today',
    type: 'hands_played',
    requirement: 100,
    chipReward: 5000,
    diamondReward: 30,
    icon: '',
  },
  {
    id: 'hp_200',
    name: 'Iron Seat',
    description: 'Play 200 Hands Today',
    type: 'hands_played',
    requirement: 200,
    chipReward: 10000,
    diamondReward: 50,
    icon: '',
  },
  {
    id: 'hw_3',
    name: 'Three Up',
    description: 'Win 3 Hands Today',
    type: 'hands_won',
    requirement: 3,
    chipReward: 750,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hw_8',
    name: 'Eight And Out',
    description: 'Win 8 Hands Today',
    type: 'hands_won',
    requirement: 8,
    chipReward: 1800,
    diamondReward: 16,
    icon: '',
  },
  {
    id: 'hw_15',
    name: 'Fifteen Pots',
    description: 'Win 15 Hands Today',
    type: 'hands_won',
    requirement: 15,
    chipReward: 3500,
    diamondReward: 26,
    icon: '',
  },
  {
    id: 'hw_30',
    name: 'Thirty Strong',
    description: 'Win 30 Hands Today',
    type: 'hands_won',
    requirement: 30,
    chipReward: 7000,
    diamondReward: 42,
    icon: '',
  },
  {
    id: 'sd_3',
    name: 'Cards Up',
    description: 'Reach Showdown 3 Times Today',
    type: 'showdowns',
    requirement: 3,
    chipReward: 600,
    diamondReward: 9,
    icon: '',
  },
  {
    id: 'sd_10',
    name: 'Showdown Regular',
    description: 'Reach Showdown 10 Times Today',
    type: 'showdowns',
    requirement: 10,
    chipReward: 2000,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'sd_20',
    name: 'Showdown Fixture',
    description: 'Reach Showdown 20 Times Today',
    type: 'showdowns',
    requirement: 20,
    chipReward: 4200,
    diamondReward: 34,
    icon: '',
  },
  {
    id: 'sdw_2',
    name: 'Called And Correct',
    description: 'Win 2 Hands At Showdown Today',
    type: 'showdowns_won',
    requirement: 2,
    chipReward: 900,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'sdw_5',
    name: 'Showdown Sheriff',
    description: 'Win 5 Hands At Showdown Today',
    type: 'showdowns_won',
    requirement: 5,
    chipReward: 2200,
    diamondReward: 22,
    icon: '',
  },
  {
    id: 'sdw_10',
    name: 'Proof Merchant',
    description: 'Win 10 Hands At Showdown Today',
    type: 'showdowns_won',
    requirement: 10,
    chipReward: 4800,
    diamondReward: 38,
    icon: '',
  },
  {
    id: 'nsw_3',
    name: 'No Cards Needed',
    description: 'Win 3 Hands Without Reaching Showdown Today',
    type: 'hands_won_no_showdown',
    requirement: 3,
    chipReward: 900,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'nsw_7',
    name: 'Quiet Thief',
    description: 'Win 7 Hands Without Reaching Showdown Today',
    type: 'hands_won_no_showdown',
    requirement: 7,
    chipReward: 2400,
    diamondReward: 24,
    icon: '',
  },
  {
    id: 'nsw_12',
    name: 'Ghost Stacker',
    description: 'Win 12 Hands Without Reaching Showdown Today',
    type: 'hands_won_no_showdown',
    requirement: 12,
    chipReward: 4500,
    diamondReward: 36,
    icon: '',
  },
  {
    id: 'bp_500_1',
    name: 'Five Hundred Club',
    description: 'Win A Pot Worth 500 Chips Or More Today',
    type: 'big_pots',
    requirement: 1,
    threshold: 500,
    chipReward: 1000,
    diamondReward: 14,
    icon: '',
  },
  {
    id: 'bp_500_3',
    name: 'Pot Collector',
    description: 'Win 3 Pots Worth 500 Chips Or More Today',
    type: 'big_pots',
    requirement: 3,
    threshold: 500,
    chipReward: 2600,
    diamondReward: 26,
    icon: '',
  },
  {
    id: 'bp_1000_1',
    name: 'Four Figures',
    description: 'Win A Pot Worth 1,000 Chips Or More Today',
    type: 'big_pots',
    requirement: 1,
    threshold: 1000,
    chipReward: 1600,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'bp_1000_3',
    name: 'Thousand Club',
    description: 'Win 3 Pots Worth 1,000 Chips Or More Today',
    type: 'big_pots',
    requirement: 3,
    threshold: 1000,
    chipReward: 4200,
    diamondReward: 34,
    icon: '',
  },
  {
    id: 'bp_2500_1',
    name: 'Monster Pot',
    description: 'Win A Pot Worth 2,500 Chips Or More Today',
    type: 'big_pots',
    requirement: 1,
    threshold: 2500,
    chipReward: 3000,
    diamondReward: 30,
    icon: '',
  },
  {
    id: 'bp_5000_1',
    name: 'Table Breaker',
    description: 'Win A Pot Worth 5,000 Chips Or More Today',
    type: 'big_pots',
    requirement: 1,
    threshold: 5000,
    chipReward: 6000,
    diamondReward: 48,
    icon: '',
  },
  {
    id: 'sh_str_1',
    name: 'Straight Away',
    description: 'Win A Hand With A Straight Or Better Today',
    type: 'strong_hands',
    requirement: 1,
    threshold: 5,
    chipReward: 1200,
    diamondReward: 15,
    icon: '',
  },
  {
    id: 'sh_str_3',
    name: 'Rank And File',
    description: 'Win 3 Hands With A Straight Or Better Today',
    type: 'strong_hands',
    requirement: 3,
    threshold: 5,
    chipReward: 3200,
    diamondReward: 30,
    icon: '',
  },
  {
    id: 'sh_fl_1',
    name: 'Flush Money',
    description: 'Win A Hand With A Flush Or Better Today',
    type: 'strong_hands',
    requirement: 1,
    threshold: 6,
    chipReward: 1800,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'sh_fl_2',
    name: 'Double Flush',
    description: 'Win 2 Hands With A Flush Or Better Today',
    type: 'strong_hands',
    requirement: 2,
    threshold: 6,
    chipReward: 3600,
    diamondReward: 34,
    icon: '',
  },
  {
    id: 'sh_fh_1',
    name: 'Full Sail',
    description: 'Win A Hand With A Full House Or Better Today',
    type: 'strong_hands',
    requirement: 1,
    threshold: 7,
    chipReward: 2800,
    diamondReward: 28,
    icon: '',
  },
  {
    id: 'sh_quad_1',
    name: 'Four Of A Kind',
    description: 'Win A Hand With Four Of A Kind Or Better Today',
    type: 'strong_hands',
    requirement: 1,
    threshold: 8,
    chipReward: 7500,
    diamondReward: 60,
    icon: '',
  },
  {
    id: 'cw_2500',
    name: 'Pocket Change',
    description: 'Win 2,500 Chips In Pots Today',
    type: 'chips_won',
    requirement: 2500,
    chipReward: 800,
    diamondReward: 11,
    icon: '',
  },
  {
    id: 'cw_10000',
    name: 'Stack Builder',
    description: 'Win 10,000 Chips In Pots Today',
    type: 'chips_won',
    requirement: 10000,
    chipReward: 2400,
    diamondReward: 24,
    icon: '',
  },
  {
    id: 'cw_25000',
    name: 'Chip Magnet',
    description: 'Win 25,000 Chips In Pots Today',
    type: 'chips_won',
    requirement: 25000,
    chipReward: 5200,
    diamondReward: 40,
    icon: '',
  },
  {
    id: 'cw_100000',
    name: 'Bankroll Day',
    description: 'Win 100,000 Chips In Pots Today',
    type: 'chips_won',
    requirement: 100000,
    chipReward: 12000,
    diamondReward: 70,
    icon: '',
  },
  {
    id: 'tp_1',
    name: 'Sign Me Up',
    description: 'Play 1 Tournament Today',
    type: 'tournaments_played',
    requirement: 1,
    chipReward: 1000,
    diamondReward: 14,
    icon: '',
  },
  {
    id: 'tp_3',
    name: 'Triple Entry',
    description: 'Play 3 Tournaments Today',
    type: 'tournaments_played',
    requirement: 3,
    chipReward: 3000,
    diamondReward: 30,
    icon: '',
  },
  {
    id: 'tp_5',
    name: 'Tournament Tour',
    description: 'Play 5 Tournaments Today',
    type: 'tournaments_played',
    requirement: 5,
    chipReward: 5500,
    diamondReward: 45,
    icon: '',
  },
  {
    id: 'fa_1',
    name: 'New Face',
    description: 'Add 1 Friend Today',
    type: 'friends_added',
    requirement: 1,
    chipReward: 600,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'fa_3',
    name: 'Social Circle',
    description: 'Add 3 Friends Today',
    type: 'friends_added',
    requirement: 3,
    chipReward: 2000,
    diamondReward: 25,
    icon: '',
  },
];

/** Weekly tier. Resets Monday. Same self-describing rule as the daily pool. */
export const WEEKLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'wk_hands_500',
    name: 'Weekly Marathon',
    description: 'Play 500 Hands This Week',
    type: 'hands_played',
    requirement: 500,
    chipReward: 30000,
    diamondReward: 120,
    icon: '',
  },
  {
    id: 'wk_wins_100',
    name: 'Weekly Winner',
    description: 'Win 100 Hands This Week',
    type: 'hands_won',
    requirement: 100,
    chipReward: 32000,
    diamondReward: 130,
    icon: '',
  },
  {
    id: 'wk_sdw_40',
    name: 'Weekly Showdown King',
    description: 'Win 40 Hands At Showdown This Week',
    type: 'showdowns_won',
    requirement: 40,
    chipReward: 28000,
    diamondReward: 115,
    icon: '',
  },
  {
    id: 'wk_nsw_50',
    name: 'Weekly Ghost',
    description: 'Win 50 Hands Without Reaching Showdown This Week',
    type: 'hands_won_no_showdown',
    requirement: 50,
    chipReward: 28000,
    diamondReward: 115,
    icon: '',
  },
  {
    id: 'wk_bp_1000_15',
    name: 'Weekly Pot Hunter',
    description: 'Win 15 Pots Worth 1,000 Chips Or More This Week',
    type: 'big_pots',
    requirement: 15,
    threshold: 1000,
    chipReward: 36000,
    diamondReward: 145,
    icon: '',
  },
  {
    id: 'wk_sh_fl_10',
    name: 'Weekly Flush Hunter',
    description: 'Win 10 Hands With A Flush Or Better This Week',
    type: 'strong_hands',
    requirement: 10,
    threshold: 6,
    chipReward: 38000,
    diamondReward: 150,
    icon: '',
  },
  {
    id: 'wk_chips_250k',
    name: 'Weekly Bankroll',
    description: 'Win 250,000 Chips In Pots This Week',
    type: 'chips_won',
    requirement: 250000,
    chipReward: 40000,
    diamondReward: 160,
    icon: '',
  },
  {
    id: 'wk_tourneys_10',
    name: 'Weekly Circuit',
    description: 'Play 10 Tournaments This Week',
    type: 'tournaments_played',
    requirement: 10,
    chipReward: 34000,
    diamondReward: 140,
    icon: '',
  },
];

/** Monthly tier. The long haul; rewards scale with the commitment. */
export const MONTHLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'mo_hands_2500',
    name: 'Monthly Marathon',
    description: 'Play 2,500 Hands This Month',
    type: 'hands_played',
    requirement: 2500,
    chipReward: 150000,
    diamondReward: 500,
    icon: '',
  },
  {
    id: 'mo_wins_500',
    name: 'Monthly Champion',
    description: 'Win 500 Hands This Month',
    type: 'hands_won',
    requirement: 500,
    chipReward: 165000,
    diamondReward: 550,
    icon: '',
  },
  {
    id: 'mo_bp_2500_25',
    name: 'Monthly Monster Hunt',
    description: 'Win 25 Pots Worth 2,500 Chips Or More This Month',
    type: 'big_pots',
    requirement: 25,
    threshold: 2500,
    chipReward: 200000,
    diamondReward: 650,
    icon: '',
  },
  {
    id: 'mo_sh_fh_25',
    name: 'Monthly Full House',
    description: 'Win 25 Hands With A Full House Or Better This Month',
    type: 'strong_hands',
    requirement: 25,
    threshold: 7,
    chipReward: 210000,
    diamondReward: 680,
    icon: '',
  },
  {
    id: 'mo_chips_1m',
    name: 'Monthly Millionaire',
    description: 'Win 1,000,000 Chips In Pots This Month',
    type: 'chips_won',
    requirement: 1000000,
    chipReward: 250000,
    diamondReward: 800,
    icon: '',
  },
  {
    id: 'mo_tourneys_40',
    name: 'Monthly Grinder',
    description: 'Play 40 Tournaments This Month',
    type: 'tournaments_played',
    requirement: 40,
    chipReward: 180000,
    diamondReward: 600,
    icon: '',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class DailyChallengeServiceClass {
  private mapServerChallenge(row: any, userId: string): TieredUserChallenge {
    const tier: Tier =
      row.tier === 'weekly' || row.tier === 'monthly' || row.tier === 'daily'
        ? row.tier
        : /^W/.test(row.assigned_date || '')
          ? 'weekly'
          : /^M/.test(row.assigned_date || '')
            ? 'monthly'
            : 'daily';

    return {
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
        // Catalog text is data, so static copy gates cannot inspect it. Keep
        // the page rule true even while an older immutable assignment snapshot
        // is still being served from production.
        name: titleCase(row.name),
        description: titleCase(row.description),
        type: row.challenge_type as ChallengeType,
        requirement: Number(row.requirement) || 0,
        chipReward: Number(row.chip_reward) || 0,
        diamondReward: Number(row.diamond_reward) || 0,
        icon: '',
      },
    };
  }

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
   * The complete Daily Missions page in one authenticated receipt.
   *
   * Active contracts, career totals, streak state, spendable diamonds, and
   * every completed-but-unclaimed reward are read from the same database
   * snapshot. Historical rows carry immutable assignment snapshots, so a
   * later catalog edit cannot rewrite what a player earned or make an old
   * reward disappear after its period rolls over.
   */
  async getDashboard(userId: string): Promise<DailyChallengeDashboard> {
    const dailyKey = this.getTodayKey();
    const weeklyKey = this.getWeekKey();
    const monthlyKey = this.getMonthKey();

    const { data, error } = await retryFetch(
      () =>
        supabase.rpc('get_daily_challenge_dashboard', {
          p_daily_key: dailyKey,
          p_daily_ids: this.selectDailyChallenges(5).map((c) => c.id),
          p_weekly_key: weeklyKey,
          p_weekly_ids: this.selectChallenges(WEEKLY_CHALLENGE_POOL, 3, weeklyKey).map((c) => c.id),
          p_monthly_key: monthlyKey,
          p_monthly_ids: this.selectChallenges(MONTHLY_CHALLENGE_POOL, 2, monthlyKey).map(
            (c) => c.id
          ),
        }),
      { maxRetries: 2, baseDelayMs: 250 }
    );

    if (error) {
      reportError(error, 'DailyChallengeService.getDashboard_failed');
      throw new Error(error.message || 'Could not synchronize Daily Missions');
    }

    const payload = data as any;
    if (!payload || !Array.isArray(payload.missions) || !payload.stats || !payload.vault) {
      const contractError = new Error('Daily Missions returned an incomplete dashboard receipt');
      reportError(contractError, 'DailyChallengeService.getDashboard_invalid_receipt');
      throw contractError;
    }

    const mapRows = (rows: any[]): TieredUserChallenge[] =>
      rows.map((row) => this.mapServerChallenge(row, userId));
    const stats = payload.stats || {};
    const streak = payload.streak || {};
    const vault = payload.vault || {};

    return {
      missions: mapRows(payload.missions),
      stats: {
        totalCompleted: Math.max(0, Number(stats.totalCompleted) || 0),
        totalClaimed: Math.max(0, Number(stats.totalClaimed) || 0),
        currentStreak: Math.max(0, Number(stats.currentStreak) || 0),
        totalChipsEarned: Math.max(0, Number(stats.totalChipsEarned) || 0),
        totalDiamondsEarned: Math.max(0, Number(stats.totalDiamondsEarned) || 0),
        milestoneStart: Math.max(0, Number(stats.milestoneStart) || 0),
        nextMilestone: Math.max(1, Number(stats.nextMilestone) || 7),
        milestoneReward: Math.max(0, Number(stats.milestoneReward) || 0),
        milestoneProgressPercent: Math.min(
          100,
          Math.max(0, Number(stats.milestoneProgressPercent) || 0)
        ),
        daysToMilestone: Math.max(0, Number(stats.daysToMilestone) || 0),
      },
      streak: {
        streak: Math.max(0, Number(streak.streak) || 0),
        freezesAvailable: Math.max(0, Number(streak.freezesAvailable) || 0),
        usedFreeze: streak.usedFreeze === true,
        frozenDate: streak.frozenDate || null,
        nextFreezeIn: streak.nextFreezeIn == null ? null : Number(streak.nextFreezeIn),
      },
      diamondBalance: Math.max(0, Number(payload.diamondBalance) || 0),
      vault: {
        count: Math.max(0, Number(vault.count) || 0),
        chips: Math.max(0, Number(vault.chips) || 0),
        diamonds: Math.max(0, Number(vault.diamonds) || 0),
        items: mapRows(Array.isArray(vault.items) ? vault.items : []),
        pageSize: Math.max(1, Number(vault.pageSize) || 100),
        hasMore: vault.hasMore === true,
      },
      syncedAt: typeof payload.syncedAt === 'string' ? payload.syncedAt : new Date().toISOString(),
    };
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
      const challenge = this.mapServerChallenge(row, userId);
      out[challenge.tier].push(challenge);
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

  /**
   * Buy a streak freeze for 5,000 diamonds.
   *
   * ── 2026-08-23: THIS USED TO FAKE THE RECEIPT ──
   *
   * The RPC did not exist in the database, and the catch block RECOGNISED that
   * by name and returned success anyway "for UX testing". So a player pressed
   * Buy, was told it worked, was charged nothing and received nothing — and
   * their streak then broke on the next missed day exactly as if they had never
   * bought protection. No error surfaced and no row was written, so nothing
   * anywhere went red.
   *
   * A purchase may fail. A purchase may never SAY it succeeded when it did not.
   * The RPC now exists (migration 20260823_buy_streak_freeze) and every failure
   * is reported as one.
   */
  async buyStreakFreeze(userId: string): Promise<FreezePurchaseResult> {
    // One request id survives every network retry. The database binds it to the
    // diamond ledger entry, so a committed response that was lost cannot buy a
    // second freeze when the client retries.
    const requestId = uuid();
    try {
      const { data } = await retryAsync(async () => {
        const result = await supabase.rpc('buy_streak_freeze', {
          p_user_id: userId,
          p_cost: 5000,
          p_request_id: requestId,
        });
        if (result.error) throw result.error;
        return result;
      }, 3);
      // The RPC reports refusals in its payload (at the 3-freeze cap, not
      // enough diamonds) rather than as a Postgres error, so an absent or
      // false `success` is still a failed purchase.
      const result = data as {
        success?: boolean;
        alreadyPurchased?: boolean;
        freezesAvailable?: number;
        diamondBalance?: number;
        error?: string;
      } | null;
      if (!result?.success) {
        return {
          success: false,
          alreadyPurchased: false,
          diamondBalance:
            result?.diamondBalance == null ? undefined : Math.max(0, Number(result.diamondBalance)),
          error: result?.error || 'Purchase failed',
        };
      }
      const alreadyPurchased = result.alreadyPurchased === true;
      const diamondBalance = Math.max(0, Number(result.diamondBalance) || 0);
      masterBus.emit('DIAMOND_BALANCE_CHANGED', {
        newBalance: diamondBalance,
        delta: alreadyPurchased ? 0 : -5000,
        source: 'streak_freeze_purchase',
      });
      return {
        success: true,
        alreadyPurchased,
        freezesAvailable: Math.max(0, Number(result.freezesAvailable) || 0),
        diamondBalance,
      };
    } catch (err: any) {
      return {
        success: false,
        alreadyPurchased: false,
        error: err?.message || 'Purchase failed',
      };
    }
  }

  /**
   * Read the spendable diamond balance shown by challenge economy controls.
   *
   * This is deliberately not `getStats().totalDiamondsEarned`: that statistic
   * is lifetime challenge payout, while purchases and rerolls spend the live
   * profiles.diamonds balance. Confusing the two made an account with 5,000
   * historical rewards look able to buy a freeze even after spending them.
   */
  async getDiamondBalance(userId: string): Promise<number> {
    const { data, error } = await supabase
      .from('profiles')
      .select('diamonds')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      reportError(error, 'DailyChallengeService.getDiamondBalance_failed');
      throw new Error('Could not load your diamond balance');
    }
    return Math.max(0, Number(data?.diamonds) || 0);
  }

  /**
   * Atomically replace one unfinished challenge and spend the reroll price.
   *
   * `expectedChallengeId` is the replay key. If a response is lost after the
   * database commits, retrying the request sees that the row has already moved
   * away from this id and returns `alreadyRerolled` without charging again.
   */
  async rerollChallenge(
    userId: string,
    challengeRowId: string,
    expectedChallengeId: string
  ): Promise<RerollResult> {
    try {
      const { data, error } = await supabase.rpc('reroll_daily_challenge', {
        p_user_id: userId,
        p_challenge_row_id: challengeRowId,
        p_expected_challenge_id: expectedChallengeId,
        p_cost: 10,
      });
      if (error) throw error;

      const result = data as {
        success?: boolean;
        alreadyRerolled?: boolean;
        challengeId?: string;
        challenge?: any;
        diamondBalance?: number;
        error?: string;
      } | null;

      if (!result?.success) {
        return {
          success: false,
          alreadyRerolled: result?.alreadyRerolled === true,
          error: result?.error || 'Challenge reroll was not confirmed',
        };
      }

      const diamondBalance = Math.max(0, Number(result.diamondBalance) || 0);
      masterBus.emit('DIAMOND_BALANCE_CHANGED', {
        newBalance: diamondBalance,
        delta: result.alreadyRerolled ? 0 : -10,
        source: 'daily_challenge_reroll',
      });

      return {
        success: true,
        alreadyRerolled: result.alreadyRerolled === true,
        challengeId: result.challengeId,
        challenge: result.challenge ? this.mapServerChallenge(result.challenge, userId) : undefined,
        diamondBalance,
      };
    } catch (err: any) {
      reportError(err, 'DailyChallengeService.rerollChallenge_failed');
      return {
        success: false,
        alreadyRerolled: false,
        error: err?.message || 'Challenge reroll failed',
      };
    }
  }

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
    amounts: Partial<Record<ChallengeType, number>>,
    /**
     * Per-type magnitude for THIS event, for the threshold types.
     *
     * `big_pots` expects the chips won in the pot; `strong_hands` expects a
     * handRankScore. A row only advances when its own threshold is met, which
     * is how "Win A Pot Worth 5,000 Chips Or More" and "Win A Pot Worth 500
     * Chips Or More" can both sit in the catalog and mean different things.
     * Omitting a magnitude for a threshold type means that hand advances no
     * thresholded row -- deliberately, since an unmeasured event cannot be
     * shown to have cleared any bar.
     */
    magnitudes?: Partial<Record<ChallengeType, number>>
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

    const mags: Record<string, number> = {};
    for (const [k, v] of Object.entries(magnitudes || {})) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) mags[k] = Math.floor(v);
    }

    try {
      const { data, error } = await supabase.rpc('bump_challenge_progress', {
        p_user_id: userId,
        p_amounts: cleaned,
        p_magnitudes: mags,
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
  public findInPools(id: string): DailyChallenge | undefined {
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
   * Claim one or many completed contracts in one wallet transaction.
   *
   * The request UUID is stable across network retries and the database stores
   * the complete receipt. If the commit succeeds but its response is lost, the
   * retry gets the original payout and next vault page instead of reporting a
   * zero-value duplicate.
   */
  async claimChallenges(userId: string, challengeRowIds: string[]): Promise<ClaimBatchResult> {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = [...new Set(challengeRowIds)];
    if (ids.length === 0) throw new Error('Choose at least one completed challenge to claim.');
    if (ids.length > 100) throw new Error('Claim up to 100 challenge rewards at a time.');
    if (ids.some((id) => !uuidPattern.test(id))) {
      throw new Error('One or more challenges are not ready to claim. Refresh and try again.');
    }

    const requestId = uuid();
    const rpcResult = await retryAsync(async () => {
      const result = await supabase.rpc('claim_daily_challenges', {
        p_user_id: userId,
        p_challenge_row_ids: ids,
        p_request_id: requestId,
      });
      if (result.error) {
        reportError(result.error, 'DailyChallengeService.RPC_claim_batch_error');
        throw new Error(result.error.message || 'Challenge rewards could not be claimed');
      }
      return result;
    }, 3);

    const paid = (rpcResult as any)?.data as any;
    if (!paid?.success || !paid.vault || !paid.stats) {
      throw new Error('Daily Missions returned an incomplete claim receipt');
    }

    const claimedIds = Array.isArray(paid.claimedIds)
      ? paid.claimedIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const alreadyClaimedIds = Array.isArray(paid.alreadyClaimedIds)
      ? paid.alreadyClaimedIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const chips = Math.max(0, Number(paid.chips) || 0);
    const diamonds = Math.max(0, Number(paid.diamonds) || 0);
    const diamondBalance = Math.max(0, Number(paid.diamondBalance) || 0);

    if (claimedIds.length > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_claim', userId });
      if (diamonds > 0) {
        masterBus.emit('DIAMOND_BALANCE_CHANGED', {
          newBalance: diamondBalance,
          delta: diamonds,
          source: 'daily_challenge_claim',
        });
      }
    }

    return {
      success: true,
      replayed: paid.replayed === true,
      claimedIds,
      alreadyClaimedIds,
      chips,
      diamonds,
      diamondBalance,
      stats: {
        totalClaimed: Math.max(0, Number(paid.stats.totalClaimed) || 0),
        totalChipsEarned: Math.max(0, Number(paid.stats.totalChipsEarned) || 0),
        totalDiamondsEarned: Math.max(0, Number(paid.stats.totalDiamondsEarned) || 0),
      },
      vault: {
        count: Math.max(0, Number(paid.vault.count) || 0),
        chips: Math.max(0, Number(paid.vault.chips) || 0),
        diamonds: Math.max(0, Number(paid.vault.diamonds) || 0),
        items: (Array.isArray(paid.vault.items) ? paid.vault.items : []).map((row: any) =>
          this.mapServerChallenge(row, userId)
        ),
        pageSize: Math.max(1, Number(paid.vault.pageSize) || 100),
        hasMore: paid.vault.hasMore === true,
      },
    };
  }

  /**
   * Legacy one-row wrapper retained for callers outside the dashboard.
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
  async getStats(userId: string): Promise<DailyChallengeStats> {
    return (await this.getDashboard(userId)).stats;
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
