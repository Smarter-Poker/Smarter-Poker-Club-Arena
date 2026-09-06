/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DAILY CHALLENGE SERVICE — Rotating Challenge Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides rotating daily challenges that refresh each day.
 * Players complete challenges for DIAMONDS. Never chips (Dan 2026-09-05).
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

export function isChallengeType(value: unknown): value is ChallengeType {
  return typeof value === 'string' && (CHALLENGE_TYPES as readonly string[]).includes(value);
}

/**
 * A pot at or above this counts as a "big pot" for the big_pots challenges.
 * The threshold lives in the TYPE rather than the requirement because progress
 * is counted per type: "win 3 pots of 500+" is expressible, a separate 5000+
 * tier would need its own type.
 */
export const BIG_POT_MIN = 500;

/**
 * Authoritative client-side mirror of the database reroll price.
 *
 * The RPC rejects stale prices before touching the wallet. Keeping the UI,
 * request, receipt validation, and balance event on this one exported value
 * prevents those client surfaces from drifting independently again.
 */
export const DAILY_MISSION_REROLL_COST = 1;

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
  /**
   * THE reward. There is no `chipReward` beside it.
   *
   * Dan 2026-09-05: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS." Every
   * mission carried BOTH, and the chips were real: three RPCs credited
   * `chip_reward_snapshot` through `atomic_credit_wallet_and_log`. Migration
   * 20260905114421 removed that crediting and zeroed the catalog column - the
   * field is deleted here rather than set to 0 so no card can promise one
   * again. Chips remain chips where chips are the OBJECTIVE ("Win 2,500 Chips
   * In Pots Today" is a thing you do, not a thing you are given).
   *
   * Authoritative value lives in daily_challenge_catalog.diamond_reward; this
   * copy renders the card before the claim. The server never trusts it.
   */
  diamondReward: number;
  icon: string;
}

/** What a successful claim actually paid out. */
export interface ClaimResult {
  claimed: boolean;
  alreadyClaimed: boolean;
  diamonds: number;
  diamondBalance: number;
}

/** One replay-safe receipt for one or many completed mission contracts. */
export interface ClaimBatchResult {
  success: boolean;
  replayed: boolean;
  claimedIds: string[];
  alreadyClaimedIds: string[];
  diamonds: number;
  diamondBalance: number;
  stats: Pick<DailyChallengeStats, 'totalClaimed' | 'totalDiamondsEarned'>;
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
  totalDiamondsEarned: number;
  milestoneStart: number;
  nextMilestone: number;
  /** Diamonds. The server sends `milestoneRewardCurrency: 'diamonds'` beside it. */
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
  diamonds: number;
  items: TieredUserChallenge[];
  pageSize: number;
  hasMore: boolean;
}

export interface DailyChallengeDashboard {
  missions: TieredUserChallenge[];
  periodKeys: Record<Tier, string>;
  stats: DailyChallengeStats;
  streak: ChallengeStreak;
  diamondBalance: number;
  vault: DailyChallengeRewardVault;
  revision: number;
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
    diamondReward: 8,
    icon: '',
  },
  {
    id: 'hp_25',
    name: 'Warmed Up',
    description: 'Play 25 Hands Today',
    type: 'hands_played',
    requirement: 25,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'hp_50',
    name: 'Half Century',
    description: 'Play 50 Hands Today',
    type: 'hands_played',
    requirement: 50,
    diamondReward: 18,
    icon: '',
  },
  {
    id: 'hp_100',
    name: 'Century Grind',
    description: 'Play 100 Hands Today',
    type: 'hands_played',
    requirement: 100,
    diamondReward: 30,
    icon: '',
  },
  {
    id: 'hp_200',
    name: 'Iron Seat',
    description: 'Play 200 Hands Today',
    type: 'hands_played',
    requirement: 200,
    diamondReward: 50,
    icon: '',
  },
  {
    id: 'hw_3',
    name: 'Three Up',
    description: 'Win 3 Hands Today',
    type: 'hands_won',
    requirement: 3,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'hw_8',
    name: 'Eight And Out',
    description: 'Win 8 Hands Today',
    type: 'hands_won',
    requirement: 8,
    diamondReward: 16,
    icon: '',
  },
  {
    id: 'hw_15',
    name: 'Fifteen Pots',
    description: 'Win 15 Hands Today',
    type: 'hands_won',
    requirement: 15,
    diamondReward: 26,
    icon: '',
  },
  {
    id: 'hw_30',
    name: 'Thirty Strong',
    description: 'Win 30 Hands Today',
    type: 'hands_won',
    requirement: 30,
    diamondReward: 42,
    icon: '',
  },
  {
    id: 'sd_3',
    name: 'Cards Up',
    description: 'Reach Showdown 3 Times Today',
    type: 'showdowns',
    requirement: 3,
    diamondReward: 9,
    icon: '',
  },
  {
    id: 'sd_10',
    name: 'Showdown Regular',
    description: 'Reach Showdown 10 Times Today',
    type: 'showdowns',
    requirement: 10,
    diamondReward: 20,
    icon: '',
  },
  {
    id: 'sd_20',
    name: 'Showdown Fixture',
    description: 'Reach Showdown 20 Times Today',
    type: 'showdowns',
    requirement: 20,
    diamondReward: 34,
    icon: '',
  },
  {
    id: 'sdw_2',
    name: 'Called And Correct',
    description: 'Win 2 Hands At Showdown Today',
    type: 'showdowns_won',
    requirement: 2,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'sdw_5',
    name: 'Showdown Sheriff',
    description: 'Win 5 Hands At Showdown Today',
    type: 'showdowns_won',
    requirement: 5,
    diamondReward: 22,
    icon: '',
  },
  {
    id: 'sdw_10',
    name: 'Proof Merchant',
    description: 'Win 10 Hands At Showdown Today',
    type: 'showdowns_won',
    requirement: 10,
    diamondReward: 38,
    icon: '',
  },
  {
    id: 'nsw_3',
    name: 'No Cards Needed',
    description: 'Win 3 Hands Without Reaching Showdown Today',
    type: 'hands_won_no_showdown',
    requirement: 3,
    diamondReward: 12,
    icon: '',
  },
  {
    id: 'nsw_7',
    name: 'Quiet Thief',
    description: 'Win 7 Hands Without Reaching Showdown Today',
    type: 'hands_won_no_showdown',
    requirement: 7,
    diamondReward: 24,
    icon: '',
  },
  {
    id: 'nsw_12',
    name: 'Ghost Stacker',
    description: 'Win 12 Hands Without Reaching Showdown Today',
    type: 'hands_won_no_showdown',
    requirement: 12,
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
    diamondReward: 60,
    icon: '',
  },
  {
    id: 'cw_2500',
    name: 'Pocket Change',
    description: 'Win 2,500 Chips In Pots Today',
    type: 'chips_won',
    requirement: 2500,
    diamondReward: 11,
    icon: '',
  },
  {
    id: 'cw_10000',
    name: 'Stack Builder',
    description: 'Win 10,000 Chips In Pots Today',
    type: 'chips_won',
    requirement: 10000,
    diamondReward: 24,
    icon: '',
  },
  {
    id: 'cw_25000',
    name: 'Chip Magnet',
    description: 'Win 25,000 Chips In Pots Today',
    type: 'chips_won',
    requirement: 25000,
    diamondReward: 40,
    icon: '',
  },
  {
    id: 'cw_100000',
    name: 'Bankroll Day',
    description: 'Win 100,000 Chips In Pots Today',
    type: 'chips_won',
    requirement: 100000,
    diamondReward: 70,
    icon: '',
  },
  {
    id: 'tp_1',
    name: 'Sign Me Up',
    description: 'Play 1 Tournament Today',
    type: 'tournaments_played',
    requirement: 1,
    diamondReward: 14,
    icon: '',
  },
  {
    id: 'tp_3',
    name: 'Triple Entry',
    description: 'Play 3 Tournaments Today',
    type: 'tournaments_played',
    requirement: 3,
    diamondReward: 30,
    icon: '',
  },
  {
    id: 'tp_5',
    name: 'Tournament Tour',
    description: 'Play 5 Tournaments Today',
    type: 'tournaments_played',
    requirement: 5,
    diamondReward: 45,
    icon: '',
  },
  {
    id: 'fa_1',
    name: 'New Face',
    description: 'Add 1 Friend Today',
    type: 'friends_added',
    requirement: 1,
    diamondReward: 10,
    icon: '',
  },
  {
    id: 'fa_3',
    name: 'Social Circle',
    description: 'Add 3 Friends Today',
    type: 'friends_added',
    requirement: 3,
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
    diamondReward: 120,
    icon: '',
  },
  {
    id: 'wk_wins_100',
    name: 'Weekly Winner',
    description: 'Win 100 Hands This Week',
    type: 'hands_won',
    requirement: 100,
    diamondReward: 130,
    icon: '',
  },
  {
    id: 'wk_sdw_40',
    name: 'Weekly Showdown King',
    description: 'Win 40 Hands At Showdown This Week',
    type: 'showdowns_won',
    requirement: 40,
    diamondReward: 115,
    icon: '',
  },
  {
    id: 'wk_nsw_50',
    name: 'Weekly Ghost',
    description: 'Win 50 Hands Without Reaching Showdown This Week',
    type: 'hands_won_no_showdown',
    requirement: 50,
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
    diamondReward: 150,
    icon: '',
  },
  {
    id: 'wk_chips_250k',
    name: 'Weekly Bankroll',
    description: 'Win 250,000 Chips In Pots This Week',
    type: 'chips_won',
    requirement: 250000,
    diamondReward: 160,
    icon: '',
  },
  {
    id: 'wk_tourneys_10',
    name: 'Weekly Circuit',
    description: 'Play 10 Tournaments This Week',
    type: 'tournaments_played',
    requirement: 10,
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
    diamondReward: 500,
    icon: '',
  },
  {
    id: 'mo_wins_500',
    name: 'Monthly Champion',
    description: 'Win 500 Hands This Month',
    type: 'hands_won',
    requirement: 500,
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
    diamondReward: 680,
    icon: '',
  },
  {
    id: 'mo_chips_1m',
    name: 'Monthly Millionaire',
    description: 'Win 1,000,000 Chips In Pots This Month',
    type: 'chips_won',
    requirement: 1000000,
    diamondReward: 800,
    icon: '',
  },
  {
    id: 'mo_tourneys_40',
    name: 'Monthly Grinder',
    description: 'Play 40 Tournaments This Month',
    type: 'tournaments_played',
    requirement: 40,
    diamondReward: 600,
    icon: '',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

const DAILY_MISSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DAILY_MISSION_PERIOD_PATTERNS: Record<Tier, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^W\d{4}-\d{2}-\d{2}$/,
  monthly: /^M\d{4}-\d{2}$/,
};

const DAILY_MISSION_TIER_COUNTS: Record<Tier, number> = {
  daily: 5,
  weekly: 3,
  monthly: 2,
};
const DAILY_MISSION_CLAIM_BATCH_LIMIT = 100;

function parseUtcDateKey(value: string): number | null {
  if (!DAILY_MISSION_PERIOD_PATTERNS.daily.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function isValidDailyMissionPeriod(tier: Tier, value: string): boolean {
  if (!DAILY_MISSION_PERIOD_PATTERNS[tier].test(value)) return false;
  if (tier === 'monthly') {
    const timestamp = Date.parse(`${value.slice(1)}-01T00:00:00.000Z`);
    return (
      Number.isFinite(timestamp) && `M${new Date(timestamp).toISOString().slice(0, 7)}` === value
    );
  }
  return parseUtcDateKey(tier === 'weekly' ? value.slice(1) : value) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DailyMissionRpcError = Error & { code?: string };

function wrapDailyMissionRpcError(error: unknown, fallback: string): DailyMissionRpcError {
  const detail = isRecord(error) ? error : {};
  const wrapped = new Error(
    typeof detail.message === 'string' && detail.message.length > 0 ? detail.message : fallback
  ) as DailyMissionRpcError;
  if (typeof detail.code === 'string') wrapped.code = detail.code;
  return wrapped;
}

/**
 * Daily Mission mutations carry stable request UUIDs, so retrying a PostgreSQL
 * deadlock victim is as safe as retrying a dropped network response. Keeping
 * this predicate local prevents non-idempotent callers of the shared retry
 * utility from silently gaining database retries.
 */
function isRetryableDailyMissionMutation(error: unknown): boolean {
  if (isRecord(error) && error.code === '40P01') return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    (error as DailyMissionRpcError).code === '40P01' ||
    message.includes('deadlock detected') ||
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('aborted') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('429')
  );
}

function invalidDailyMissionReceipt(context: string, detail: string): never {
  const error = new Error(`Daily Challenges returned an invalid ${detail} receipt`);
  reportError(error, `DailyChallengeService.${context}_invalid_receipt`);
  throw error;
}

function readReceiptString(value: unknown, context: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalidDailyMissionReceipt(context, field);
  }
  return value;
}

function readReceiptBoolean(value: unknown, context: string, field: string): boolean {
  if (typeof value !== 'boolean') return invalidDailyMissionReceipt(context, field);
  return value;
}

function readReceiptInteger(value: unknown, context: string, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return invalidDailyMissionReceipt(context, field);
  }
  return value as number;
}

function readReceiptNumber(
  value: unknown,
  context: string,
  field: string,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    return invalidDailyMissionReceipt(context, field);
  }
  return value;
}

class DailyChallengeServiceClass {
  private mapServerChallenge(
    value: unknown,
    userId: string,
    context = 'contract'
  ): TieredUserChallenge {
    if (!isRecord(value)) return invalidDailyMissionReceipt(context, 'challenge row');
    const row = value;
    const id = readReceiptString(row.id, context, 'challenge identifier');
    if (!DAILY_MISSION_UUID_PATTERN.test(id)) {
      return invalidDailyMissionReceipt(context, 'challenge identifier');
    }
    const challengeId = readReceiptString(
      row.challenge_id,
      context,
      'challenge catalog identifier'
    );
    const name = readReceiptString(row.name, context, 'challenge name');
    const description = readReceiptString(row.description, context, 'challenge description');
    if (!isChallengeType(row.challenge_type)) {
      return invalidDailyMissionReceipt(context, 'challenge type');
    }
    const type = row.challenge_type;
    if (row.tier !== 'daily' && row.tier !== 'weekly' && row.tier !== 'monthly') {
      return invalidDailyMissionReceipt(context, 'challenge tier');
    }
    const tier = row.tier;
    const assignedDate = readReceiptString(row.assigned_date, context, 'challenge period');
    if (!isValidDailyMissionPeriod(tier, assignedDate)) {
      return invalidDailyMissionReceipt(context, 'challenge period');
    }
    const requirement = readReceiptInteger(row.requirement, context, 'challenge requirement', 1);
    const diamondReward = readReceiptInteger(row.diamond_reward, context, 'challenge reward');
    const progress = readReceiptInteger(row.progress, context, 'challenge progress');
    const completed = readReceiptBoolean(row.completed, context, 'challenge completion state');
    const claimed = readReceiptBoolean(row.claimed, context, 'challenge claim state');
    if (progress > requirement || completed !== (progress === requirement)) {
      return invalidDailyMissionReceipt(context, 'challenge progress state');
    }
    if (claimed && !completed) return invalidDailyMissionReceipt(context, 'challenge claim state');
    const hasCompletionTime =
      typeof row.completed_at === 'string' && Number.isFinite(Date.parse(row.completed_at));
    if ((row.completed_at !== null && !hasCompletionTime) || completed !== hasCompletionTime) {
      return invalidDailyMissionReceipt(context, 'challenge completion time');
    }

    return {
      id,
      challengeId,
      userId,
      progress,
      completed,
      claimed,
      completedAt: typeof row.completed_at === 'string' ? row.completed_at : undefined,
      tier,
      challenge: {
        id: challengeId,
        // Catalog text is data, so static copy gates cannot inspect it. Keep
        // the page rule true even while an older immutable assignment snapshot
        // is still being served from production.
        name: titleCase(name),
        description: titleCase(description),
        type,
        requirement,
        diamondReward,
        icon: '',
      },
    };
  }

  private mapServerChallenges(
    rows: unknown,
    userId: string,
    context = 'contracts'
  ): TieredUserChallenge[] {
    if (!Array.isArray(rows)) return invalidDailyMissionReceipt(context, 'challenge list');
    const seen = new Set<string>();
    const mapped: TieredUserChallenge[] = [];
    for (const row of rows) {
      const challenge = this.mapServerChallenge(row, userId, context);
      if (seen.has(challenge.id)) {
        return invalidDailyMissionReceipt(context, 'duplicate challenge');
      }
      seen.add(challenge.id);
      mapped.push(challenge);
    }
    return mapped;
  }

  private mapRewardVault(
    value: unknown,
    userId: string,
    context: string
  ): DailyChallengeRewardVault {
    if (!isRecord(value)) return invalidDailyMissionReceipt(context, 'reward vault');
    const count = readReceiptInteger(value.count, context, 'reward vault count');
    const diamonds = readReceiptInteger(value.diamonds, context, 'reward vault total');
    const pageSize = readReceiptInteger(value.pageSize, context, 'reward vault page size', 1);
    if (pageSize > DAILY_MISSION_CLAIM_BATCH_LIMIT) {
      return invalidDailyMissionReceipt(context, 'reward vault page size');
    }
    const hasMore = readReceiptBoolean(value.hasMore, context, 'reward vault page state');
    const items = this.mapServerChallenges(value.items, userId, `${context}_vault`);
    const expectedItems = Math.min(count, pageSize);
    if (items.length !== expectedItems || hasMore !== count > pageSize) {
      return invalidDailyMissionReceipt(context, 'reward vault pagination');
    }
    if (items.some((item) => !item.completed || item.claimed)) {
      return invalidDailyMissionReceipt(context, 'reward vault state');
    }
    const itemDiamonds = items.reduce((total, item) => total + item.challenge.diamondReward, 0);
    if ((!hasMore && itemDiamonds !== diamonds) || (hasMore && diamonds < itemDiamonds)) {
      return invalidDailyMissionReceipt(context, 'reward vault total');
    }
    return { count, diamonds, items, pageSize, hasMore };
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
    const { data, error } = await retryFetch(
      () => supabase.rpc('get_daily_challenge_dashboard_v3'),
      { maxRetries: 2, baseDelayMs: 250 }
    );

    if (error) {
      reportError(error, 'DailyChallengeService.getDashboard_failed');
      throw new Error(error.message || 'Could not synchronize Daily Missions');
    }

    const context = 'getDashboard';
    if (!isRecord(data)) return invalidDailyMissionReceipt(context, 'dashboard');
    const payload = data;
    if (!isRecord(payload.periodKeys)) {
      return invalidDailyMissionReceipt(context, 'dashboard period keys');
    }
    const periodKeys = payload.periodKeys;
    const dailyKey = readReceiptString(periodKeys.daily, context, 'daily period key');
    const weeklyKey = readReceiptString(periodKeys.weekly, context, 'weekly period key');
    const monthlyKey = readReceiptString(periodKeys.monthly, context, 'monthly period key');
    const dailyTimestamp = parseUtcDateKey(dailyKey);
    const weeklyTimestamp = parseUtcDateKey(weeklyKey.slice(1));
    const dailyDate = dailyTimestamp === null ? null : new Date(dailyTimestamp);
    const expectedWeeklyKey =
      dailyDate === null
        ? null
        : `W${new Date(dailyDate.getTime() - ((dailyDate.getUTCDay() + 6) % 7) * 86_400_000)
            .toISOString()
            .slice(0, 10)}`;
    if (
      dailyTimestamp === null ||
      weeklyTimestamp === null ||
      !isValidDailyMissionPeriod('weekly', weeklyKey) ||
      !isValidDailyMissionPeriod('monthly', monthlyKey) ||
      weeklyKey !== expectedWeeklyKey ||
      monthlyKey.slice(1) !== dailyKey.slice(0, 7)
    ) {
      return invalidDailyMissionReceipt(context, 'dashboard period keys');
    }
    if (!Array.isArray(payload.missions)) {
      return invalidDailyMissionReceipt(context, 'dashboard challenge list');
    }
    const expectedPeriodKeys: Record<Tier, string> = {
      daily: dailyKey,
      weekly: weeklyKey,
      monthly: monthlyKey,
    };
    for (const mission of payload.missions) {
      if (
        !isRecord(mission) ||
        (mission.tier !== 'daily' && mission.tier !== 'weekly' && mission.tier !== 'monthly') ||
        mission.assigned_date !== expectedPeriodKeys[mission.tier]
      ) {
        return invalidDailyMissionReceipt(context, 'dashboard challenge period');
      }
    }
    const missions = this.mapServerChallenges(payload.missions, userId, `${context}_missions`);
    const catalogContracts = new Set<string>();
    for (const mission of missions) {
      const catalogContract = `${mission.tier}:${mission.challengeId}`;
      if (catalogContracts.has(catalogContract)) {
        return invalidDailyMissionReceipt(context, 'duplicate challenge catalog contract');
      }
      catalogContracts.add(catalogContract);
    }
    for (const tier of Object.keys(DAILY_MISSION_TIER_COUNTS) as Tier[]) {
      if (
        missions.filter((mission) => mission.tier === tier).length !==
        DAILY_MISSION_TIER_COUNTS[tier]
      ) {
        return invalidDailyMissionReceipt(context, `${tier} challenge count`);
      }
    }
    if (!isRecord(payload.stats) || !isRecord(payload.streak)) {
      return invalidDailyMissionReceipt(context, 'dashboard summary');
    }
    const stats = payload.stats;
    const streak = payload.streak;
    const totalCompleted = readReceiptInteger(stats.totalCompleted, context, 'completed total');
    const totalClaimed = readReceiptInteger(stats.totalClaimed, context, 'claimed total');
    if (totalClaimed > totalCompleted) {
      return invalidDailyMissionReceipt(context, 'challenge totals');
    }
    const vault = this.mapRewardVault(payload.vault, userId, context);
    if (vault.count !== totalCompleted - totalClaimed) {
      return invalidDailyMissionReceipt(context, 'challenge reward vault total');
    }
    const currentStreak = readReceiptInteger(stats.currentStreak, context, 'current streak');
    const streakCount = readReceiptInteger(streak.streak, context, 'streak count');
    if (currentStreak !== streakCount || stats.milestoneRewardCurrency !== 'diamonds') {
      return invalidDailyMissionReceipt(context, 'streak summary');
    }
    const freezesAvailable = readReceiptInteger(
      streak.freezesAvailable,
      context,
      'freeze inventory'
    );
    const usedFreeze = readReceiptBoolean(streak.usedFreeze, context, 'freeze usage state');
    const frozenDate = streak.frozenDate;
    if (freezesAvailable > 3 || (frozenDate !== null && typeof frozenDate !== 'string')) {
      return invalidDailyMissionReceipt(context, 'freeze inventory');
    }
    if (
      (typeof frozenDate === 'string' && parseUtcDateKey(frozenDate) === null) ||
      usedFreeze !== (frozenDate !== null)
    ) {
      return invalidDailyMissionReceipt(context, 'frozen date');
    }
    const nextFreezeIn =
      streak.nextFreezeIn === null
        ? null
        : readReceiptInteger(streak.nextFreezeIn, context, 'next freeze distance', 1);
    if (
      (nextFreezeIn !== null && nextFreezeIn > 7) ||
      freezesAvailable >= 3 !== (nextFreezeIn === null)
    ) {
      return invalidDailyMissionReceipt(context, 'next freeze distance');
    }
    const syncedAt = readReceiptString(payload.syncedAt, context, 'synchronization time');
    const syncedTimestamp = Date.parse(syncedAt);
    if (
      !Number.isFinite(syncedTimestamp) ||
      new Date(syncedTimestamp).toISOString().slice(0, 10) !== dailyKey
    ) {
      return invalidDailyMissionReceipt(context, 'synchronization time');
    }

    return {
      missions,
      periodKeys: expectedPeriodKeys,
      stats: {
        totalCompleted,
        totalClaimed,
        currentStreak,
        totalDiamondsEarned: readReceiptInteger(
          stats.totalDiamondsEarned,
          context,
          'earned diamond total'
        ),
        milestoneStart: readReceiptInteger(stats.milestoneStart, context, 'milestone start'),
        nextMilestone: readReceiptInteger(stats.nextMilestone, context, 'next milestone', 1),
        milestoneReward: readReceiptNumber(stats.milestoneReward, context, 'milestone reward'),
        milestoneProgressPercent: readReceiptNumber(
          stats.milestoneProgressPercent,
          context,
          'milestone progress',
          0,
          100
        ),
        daysToMilestone: readReceiptInteger(stats.daysToMilestone, context, 'milestone distance'),
      },
      streak: {
        streak: streakCount,
        freezesAvailable,
        usedFreeze,
        frozenDate: frozenDate as string | null,
        nextFreezeIn,
      },
      diamondBalance: readReceiptInteger(payload.diamondBalance, context, 'diamond balance'),
      vault,
      revision: readReceiptInteger(payload.revision, context, 'dashboard revision', 1),
      syncedAt,
    };
  }

  /**
   * Read only the durable cursor used to repair a missed Realtime event.
   * This is deliberately much smaller than the atomic dashboard RPC.
   */
  async getDashboardRevision(userId: string): Promise<number> {
    const { data, error } = await retryFetch(
      () =>
        supabase
          .from('daily_challenge_dashboard_revisions')
          .select('revision')
          .eq('user_id', userId)
          .maybeSingle(),
      { maxRetries: 1, baseDelayMs: 250 }
    );

    if (error) {
      reportError(error, 'DailyChallengeService.getDashboardRevision_failed');
      throw new Error(error.message || 'Could not reconcile Daily Missions');
    }

    if (data === null) return 0;
    if (!isRecord(data)) return invalidDailyMissionReceipt('getDashboardRevision', 'revision row');
    return readReceiptInteger(data.revision, 'getDashboardRevision', 'dashboard revision', 1);
  }

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
      const { data } = await retryAsync(
        async () => {
          const result = await supabase.rpc('buy_streak_freeze', {
            p_user_id: userId,
            p_cost: 5000,
            p_request_id: requestId,
          });
          if (result.error) {
            reportError(result.error, 'DailyChallengeService.buyStreakFreeze_rpc_failed');
            throw wrapDailyMissionRpcError(
              result.error,
              'Streak freeze purchase could not be confirmed'
            );
          }
          return result;
        },
        3,
        500,
        isRetryableDailyMissionMutation
      );
      // The RPC reports refusals in its payload (at the 3-freeze cap, not
      // enough diamonds) rather than as a Postgres error, so an absent or
      // false `success` is still a failed purchase.
      if (!isRecord(data)) return invalidDailyMissionReceipt('buyStreakFreeze', 'freeze purchase');
      const result = data;
      const success = readReceiptBoolean(
        result.success,
        'buyStreakFreeze',
        'freeze purchase state'
      );
      if (!success) {
        const diamondBalance =
          result.diamondBalance === undefined
            ? undefined
            : readReceiptInteger(result.diamondBalance, 'buyStreakFreeze', 'diamond balance');
        return {
          success: false,
          alreadyPurchased: false,
          diamondBalance,
          error:
            typeof result.error === 'string' && result.error.length > 0
              ? result.error
              : 'Purchase failed',
        };
      }
      const alreadyPurchased = readReceiptBoolean(
        result.alreadyPurchased,
        'buyStreakFreeze',
        'freeze replay state'
      );
      const freezesAvailable = readReceiptInteger(
        result.freezesAvailable,
        'buyStreakFreeze',
        'freeze inventory'
      );
      if (freezesAvailable > 3) {
        return invalidDailyMissionReceipt('buyStreakFreeze', 'freeze inventory');
      }
      const diamondsSpent = readReceiptInteger(
        result.diamondsSpent,
        'buyStreakFreeze',
        'freeze purchase total'
      );
      if (diamondsSpent !== (alreadyPurchased ? 0 : 5000)) {
        return invalidDailyMissionReceipt('buyStreakFreeze', 'freeze purchase total');
      }
      const diamondBalance = readReceiptInteger(
        result.diamondBalance,
        'buyStreakFreeze',
        'diamond balance'
      );
      masterBus.emit('DIAMOND_BALANCE_CHANGED', {
        newBalance: diamondBalance,
        delta: alreadyPurchased ? 0 : -5000,
        source: 'streak_freeze_purchase',
      });
      return {
        success: true,
        alreadyPurchased,
        freezesAvailable,
        diamondBalance,
      };
    } catch (err: any) {
      reportError(err, 'DailyChallengeService.buyStreakFreeze_failed');
      return {
        success: false,
        alreadyPurchased: false,
        error: err?.message || 'Purchase failed',
      };
    }
  }

  /**
   * Atomically replace one unfinished challenge and spend the reroll price.
   *
   * One request UUID survives every transient retry. The database persists the
   * exact receipt, so a lost committed response cannot charge twice and a
   * catalog ID cycling back onto the same assignment cannot become a free
   * reroll. `expectedChallengeId` remains the optimistic concurrency guard.
   */
  async rerollChallenge(
    userId: string,
    challengeRowId: string,
    expectedChallengeId: string
  ): Promise<RerollResult> {
    const requestId = uuid();
    try {
      const { data } = await retryAsync(
        async () => {
          const receipt = await supabase.rpc('reroll_daily_challenge', {
            p_user_id: userId,
            p_challenge_row_id: challengeRowId,
            p_expected_challenge_id: expectedChallengeId,
            p_cost: DAILY_MISSION_REROLL_COST,
            p_request_id: requestId,
          });
          if (receipt.error) {
            reportError(receipt.error, 'DailyChallengeService.rerollChallenge_rpc_failed');
            throw wrapDailyMissionRpcError(
              receipt.error,
              'Challenge reroll could not be confirmed'
            );
          }
          return receipt;
        },
        3,
        500,
        isRetryableDailyMissionMutation
      );

      if (!isRecord(data)) {
        return invalidDailyMissionReceipt('rerollChallenge', 'reroll');
      }
      const result = data;

      if (result.success !== true) {
        return {
          success: false,
          alreadyRerolled: result.alreadyRerolled === true,
          error:
            typeof result.error === 'string' ? result.error : 'Challenge reroll was not confirmed',
        };
      }

      const alreadyRerolled = readReceiptBoolean(
        result.alreadyRerolled,
        'rerollChallenge',
        'reroll replay state'
      );
      const receiptRequestId = readReceiptString(
        result.requestId,
        'rerollChallenge',
        'reroll request identifier'
      );
      if (receiptRequestId !== requestId || !DAILY_MISSION_UUID_PATTERN.test(receiptRequestId)) {
        return invalidDailyMissionReceipt('rerollChallenge', 'reroll request identifier');
      }
      const diamondsSpent = readReceiptInteger(
        result.diamondsSpent,
        'rerollChallenge',
        'reroll settlement total'
      );
      if (diamondsSpent !== (alreadyRerolled ? 0 : DAILY_MISSION_REROLL_COST)) {
        return invalidDailyMissionReceipt('rerollChallenge', 'reroll settlement total');
      }
      const challengeId = readReceiptString(
        result.challengeId,
        'rerollChallenge',
        'rerolled challenge identifier'
      );
      const challenge = this.mapServerChallenge(result.challenge, userId, 'rerollChallenge');
      if (
        challenge.challengeId !== challengeId ||
        challenge.id !== challengeRowId ||
        challengeId === expectedChallengeId
      ) {
        return invalidDailyMissionReceipt('rerollChallenge', 'rerolled challenge');
      }
      const diamondBalance = readReceiptInteger(
        result.diamondBalance,
        'rerollChallenge',
        'diamond balance'
      );
      masterBus.emit('DIAMOND_BALANCE_CHANGED', {
        newBalance: diamondBalance,
        delta: alreadyRerolled ? 0 : -DAILY_MISSION_REROLL_COST,
        source: 'daily_challenge_reroll',
      });

      return {
        success: true,
        alreadyRerolled,
        challengeId,
        challenge,
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

  /**
   * Claim one or many completed contracts in one wallet transaction.
   *
   * The request UUID is stable across network retries and the database stores
   * the complete receipt. If the commit succeeds but its response is lost, the
   * retry gets the original payout and next vault page instead of reporting a
   * zero-value duplicate.
   */
  async claimChallenges(userId: string, challengeRowIds: string[]): Promise<ClaimBatchResult> {
    const ids = [...new Set(challengeRowIds)];
    if (ids.length === 0) throw new Error('Choose at least one completed challenge to claim.');
    if (ids.length > DAILY_MISSION_CLAIM_BATCH_LIMIT) {
      throw new Error('Claim up to 100 challenge rewards at a time.');
    }
    if (ids.some((id) => !DAILY_MISSION_UUID_PATTERN.test(id))) {
      throw new Error('One or more challenges are not ready to claim. Refresh and try again.');
    }

    const requestId = uuid();
    const rpcResult = await retryAsync(
      async () => {
        const result = await supabase.rpc('claim_daily_challenges', {
          p_user_id: userId,
          p_challenge_row_ids: ids,
          p_request_id: requestId,
        });
        if (result.error) {
          reportError(result.error, 'DailyChallengeService.RPC_claim_batch_error');
          throw wrapDailyMissionRpcError(result.error, 'Challenge rewards could not be claimed');
        }
        return result;
      },
      3,
      500,
      isRetryableDailyMissionMutation
    );

    const context = 'claimChallenges';
    const paid = (rpcResult as { data?: unknown } | null)?.data;
    if (!isRecord(paid) || paid.success !== true || !isRecord(paid.stats)) {
      return invalidDailyMissionReceipt(context, 'claim');
    }

    const requestedIds = new Set(ids);
    const normalizeReceiptIds = (value: unknown, field: string): string[] => {
      if (!Array.isArray(value)) return invalidDailyMissionReceipt(context, field);
      const normalized = value.filter((id): id is string => typeof id === 'string');
      if (
        normalized.length !== value.length ||
        new Set(normalized).size !== normalized.length ||
        normalized.some((id) => !DAILY_MISSION_UUID_PATTERN.test(id) || !requestedIds.has(id))
      ) {
        return invalidDailyMissionReceipt(context, field);
      }
      return normalized;
    };
    const claimedIds = normalizeReceiptIds(paid.claimedIds, 'claimed challenge');
    const alreadyClaimedIds = normalizeReceiptIds(
      paid.alreadyClaimedIds,
      'previously claimed challenge'
    );
    if (claimedIds.some((id) => alreadyClaimedIds.includes(id))) {
      return invalidDailyMissionReceipt(context, 'overlapping claim');
    }
    const settledIds = new Set([...claimedIds, ...alreadyClaimedIds]);
    if (settledIds.size !== ids.length || ids.some((id) => !settledIds.has(id))) {
      return invalidDailyMissionReceipt(context, 'incomplete claim coverage');
    }
    const replayed = readReceiptBoolean(paid.replayed, context, 'claim replay state');
    const diamonds = readReceiptInteger(paid.diamonds, context, 'claimed diamond total');
    const diamondBalance = readReceiptInteger(paid.diamondBalance, context, 'diamond balance');
    const totalClaimed = readReceiptInteger(
      paid.stats.totalClaimed,
      context,
      'claimed challenge total'
    );
    const totalDiamondsEarned = readReceiptInteger(
      paid.stats.totalDiamondsEarned,
      context,
      'earned diamond total'
    );
    const vault = this.mapRewardVault(paid.vault, userId, context);
    if (
      (claimedIds.length === 0 && diamonds !== 0) ||
      totalClaimed < settledIds.size ||
      totalDiamondsEarned < diamonds
    ) {
      return invalidDailyMissionReceipt(context, 'claim settlement totals');
    }

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
      replayed,
      claimedIds,
      alreadyClaimedIds,
      diamonds,
      diamondBalance,
      stats: {
        totalClaimed,
        totalDiamondsEarned,
      },
      vault,
    };
  }
}

export const dailyChallengeService = new DailyChallengeServiceClass();
export default dailyChallengeService;
