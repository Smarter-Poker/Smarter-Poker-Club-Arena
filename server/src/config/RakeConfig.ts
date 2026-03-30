/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVER-SIDE RAKE & BBJ CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Ported from client `src/config/RakeConfig.ts` — the AUTHORITATIVE rake schedule.
 * This is the SINGLE SOURCE OF TRUTH for all rake and BBJ calculations on the server.
 *
 * OFFICIAL RAKE SCHEDULE (all cash games):
 *   - All stakes: 10% rake
 *   - Caps are FIXED DOLLAR AMOUNTS per stakes level (not BB-based)
 *   - BBJ fee is in BB units per qualifying hand
 *   - BBJ pool allocation: Main 40% / BackUp 30% / Promotional 30%
 *
 * BBJ RULES:
 *   - Pot must be >= 10BB
 *   - 3+ players must be dealt in preflop (FIX 145)
 *   - Not available for Double/Triple Board games
 *   - If run it multiple times, only first runout counts
 *   - If multiple losers qualify, prize split proportionally
 *
 * QUALIFYING HANDS (minimum losing hand):
 *   NLH/FLH: AAAJJ (full house, Aces full of Jacks)
 *   PLO4/FLO4: KKKK2 (four Kings)
 *   PLO5/FLO5: 87654 (eight-high straight flush)
 *   PLO8 (Hi-Lo 8 or Better): Same as PLO4 — KKKK2 (four Kings)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeScheduleEntry {
  sb: number;
  bb: number;
  rakePercent: number;
  rakeCap: number;
  bbjFeeBB: number;
}

export interface StakesTier {
  label: string;
  blindRange: string;
  minBB: number;
  maxBB: number;
  rakePercent: number;
  rakeCap: number;
  rakeCapBB: number;
  bbjFeeBB: number;
  /** % of BBJ pool paid out when jackpot hits at this stakes level */
  bbjPayoutTotalPercent: number;
}

export interface BBJQualifyingHand {
  label: string;
  minLosingHand: string | null;
  description: string;
  rules: string[];
  handRank?: string;
  minRankValue?: string;
  eligible?: boolean;
}

export interface ServerRakeConfigResult {
  tier: string;
  blindRange: string;
  rakePercent: number;
  rakeCap: number;
  rakeCapDollars: number;
  bbjEnabled: boolean;
  bbjFeeBB: number;
  bbjFeeDollars: number;
  bbjPoolAllocation: typeof BBJ_POOL_ALLOCATION;
  /** % of BBJ pool paid out when jackpot hits (varies by stakes: 15%-85%) */
  bbjPayoutTotalPercent: number;
  /** Loser gets 50% of the total payout */
  bbjPayoutLoser: number;
  /** Winner gets 25% of the total payout */
  bbjPayoutWinner: number;
  /** Table share: all other dealt-in players split 25% of total payout */
  bbjPayoutTable: number;
  qualifyingHand: BBJQualifyingHand;
  rules: typeof BBJ_RULES;
  _exactMatch: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFICIAL RAKE SCHEDULE — Per-stakes lookup table
// rakeCap is an ABSOLUTE DOLLAR AMOUNT (not BB-based).
// ═══════════════════════════════════════════════════════════════════════════════

export const RAKE_SCHEDULE: RakeScheduleEntry[] = [
  { sb: 0.1, bb: 0.2, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.2, bb: 0.4, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.25, bb: 0.5, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.3, bb: 0.6, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.6 },
  { sb: 0.5, bb: 1.0, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.25 },
  { sb: 1, bb: 2, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.25 },
  { sb: 2, bb: 4, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  { sb: 2, bb: 5, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  { sb: 5, bb: 5, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  { sb: 3, bb: 6, rakePercent: 10, rakeCap: 8, bbjFeeBB: 0.12 },
  { sb: 4, bb: 8, rakePercent: 10, rakeCap: 10, bbjFeeBB: 0.12 },
  { sb: 5, bb: 10, rakePercent: 10, rakeCap: 12.5, bbjFeeBB: 0.06 },
  { sb: 10, bb: 20, rakePercent: 10, rakeCap: 15, bbjFeeBB: 0.06 },
  { sb: 10, bb: 25, rakePercent: 10, rakeCap: 15, bbjFeeBB: 0.06 },
];

// FIX 166: Bible V8 §7.19 / §2.9 — Player-count-based rake caps.
// Standard poker rule: heads-up and short-handed games get lower rake caps.
// Each entry defines a player threshold and its corresponding cap MULTIPLIER.
// The engine finds the highest tier where playerCount >= players, then applies: cap × multiplier.
export function getPlayerCountCaps(fullCap: number): { players: number; cap: number }[] {
  return [
    { players: 2, cap: Math.round(fullCap * 0.5 * 100) / 100 },  // Heads-up: 50% of cap
    { players: 3, cap: Math.round(fullCap * 0.67 * 100) / 100 },  // 3-handed: 67% of cap
    { players: 4, cap: fullCap },                                    // 4+ players: full cap
  ];
}

// BBJ Pool Allocation — FIX 212: Updated to match actual pivot-based allocation in logBBJCollection.
// STANDARD allocation (main pool < $100k): 50% Main / 25% Backup / 25% Promo
// PIVOT allocation (main pool >= $100k): 30% Main / 40% Backup / 30% Promo (see FIX 140 in supabase.ts)
// This constant reflects the STANDARD (default) allocation shown to clients.
export const BBJ_POOL_ALLOCATION = {
  mainBBJ: 0.5, // 50% of BBJ rake goes to Main BBJ pool (standard)
  backUpBBJ: 0.25, // 25% goes to Back Up BBJ pool (standard)
  promotional: 0.25, // 25% goes to Promotional fund (standard)
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// STAKES TIERS — Fallback for custom/non-standard stakes
// ═══════════════════════════════════════════════════════════════════════════════

export const STAKES_TIERS: Record<string, StakesTier> = {
  nano: {
    label: 'Nano',
    blindRange: '0.05/0.10 - 0.1/0.2',
    minBB: 0.1,
    maxBB: 0.2,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6,
    bbjPayoutTotalPercent: 15, // 7.5% loser / 3.75% winner / 3.75% table
  },
  micro: {
    label: 'Micro',
    blindRange: '0.2/0.4 - 0.4/0.8',
    minBB: 0.3,
    maxBB: 0.8,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6, // Per PDF rake schedule: .20/.40 and .30/.60 are both 0.6bb
    bbjPayoutTotalPercent: 25, // 12.5% loser / 6.25% winner / 6.25% table
  },
  small: {
    label: 'Small',
    blindRange: '0.5/1 - 1.5/3',
    minBB: 1,
    maxBB: 3,
    rakePercent: 10,
    rakeCap: 5,
    rakeCapBB: 5,
    bbjFeeBB: 0.25,
    bbjPayoutTotalPercent: 40, // 20% loser / 10% winner / 10% table
  },
  mid: {
    label: 'Mid',
    blindRange: '2/4 - 4/8',
    minBB: 3.5,
    maxBB: 8,
    rakePercent: 10,
    rakeCap: 8,
    rakeCapBB: 8,
    bbjFeeBB: 0.12,
    bbjPayoutTotalPercent: 55, // 27.5% loser / 13.75% winner / 13.75% table
  },
  high: {
    label: 'High',
    blindRange: '5/10 - 20/40',
    minBB: 9,
    maxBB: 40,
    rakePercent: 10,
    rakeCap: 15,
    rakeCapBB: 15,
    bbjFeeBB: 0.06,
    bbjPayoutTotalPercent: 70, // 35% loser / 17.5% winner / 17.5% table
  },
  nosebleeds: {
    label: 'Nosebleeds',
    blindRange: '25/50+',
    minBB: 41,
    maxBB: Infinity,
    rakePercent: 10,
    rakeCap: 20,
    rakeCapBB: 20,
    bbjFeeBB: 0.03,
    bbjPayoutTotalPercent: 85, // 42.5% loser / 21.25% winner / 21.25% table
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ QUALIFYING HANDS — Minimum losing hand per game variant
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJ_QUALIFYING_HANDS: Record<string, BBJQualifyingHand> = {
  nlh: {
    label: 'NLH / FLH',
    minLosingHand: 'AAAJJ',
    description: 'Full House (Aces full of Jacks) or better must LOSE to Quads or Straight Flush',
    rules: [
      'AAAJJ+ must lose to Quads or Straight Flush',
      'Player holding Full House must have at least one Ace in their hole cards (dealt cards)',
      'Both cards from hand must play',
    ],
    handRank: 'full_house',
    minRankValue: 'AAAJJ',
  },
  // Alias: flh (Fixed Limit Hold'em) uses same qualifying hand as NLH
  flh: {
    label: 'NLH / FLH',
    minLosingHand: 'AAAJJ',
    description: 'Full House (Aces full of Jacks) or better must LOSE to Quads or Straight Flush',
    rules: [
      'AAAJJ+ must lose to Quads or Straight Flush',
      'Player holding Full House must have at least one Ace in their hole cards (dealt cards)',
      'Both cards from hand must play',
    ],
    handRank: 'full_house',
    minRankValue: 'AAAJJ',
  },
  plo4: {
    label: 'PLO4 / FLO4',
    minLosingHand: 'KKKK2',
    description: 'Four of a Kind (Kings) or better must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  plo: {
    label: 'PLO4 / FLO4',
    minLosingHand: 'KKKK2',
    description: 'Four of a Kind (Kings) or better must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  plo8: {
    label: 'PLO8 (Hi-Lo 8 or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four of a Kind (Kings) or better must LOSE — evaluated on HIGH hand only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  // FIX 116: plo_hilo dead variant removed — plo8 is the only hi-lo variant
  plo5: {
    label: 'PLO5 / FLO5',
    minLosingHand: '87654',
    description: 'Straight Flush (8-high) or better must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'straight_flush',
    minRankValue: '87654',
  },
  plo6: {
    label: 'PLO6',
    minLosingHand: null,
    description: 'BBJ not available for PLO6',
    rules: [],
    eligible: false,
  },
  short_deck: {
    label: 'Short Deck',
    minLosingHand: null,
    description: 'BBJ not available for Short Deck',
    rules: [],
    eligible: false,
  },
  pineapple: {
    label: 'Pineapple',
    minLosingHand: 'KKKK2',
    description: 'Four of a Kind (Kings) or better must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  // Alias: ofc_pineapple maps to pineapple (same game, different variant key)
  ofc_pineapple: {
    label: 'Pineapple',
    minLosingHand: 'KKKK2',
    description: 'Four of a Kind (Kings) or better must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ GENERAL RULES
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJ_RULES = {
  minPotBB: 10,
  minPlayersDealt: 3, // FIX 145: BBJ requires 3+ players dealt in (not 4) per Dan's rule
  excludeDoubleBoard: true,
  onlyFirstRunout: true,
  splitIfMultipleQualify: true,
  requireBothHoleCards: true,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// LOOKUP FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find exact match in RAKE_SCHEDULE by SB/BB.
 * Falls back to null for non-standard stakes.
 */
export function findScheduleMatch(smallBlind: number, bigBlind: number): RakeScheduleEntry | null {
  return (
    RAKE_SCHEDULE.find(
      (row) => Math.abs(row.sb - smallBlind) < 0.001 && Math.abs(row.bb - bigBlind) < 0.001
    ) || null
  );
}

/**
 * Get tier config for a given Big-Blind size (fallback for non-exact matches).
 */
export function getTierForBB(bigBlind: number): StakesTier {
  // Tier boundaries based on Dan's BBJ payout screenshot + rake PDF:
  // Nano:  0.10 - 0.20   (fee 0.6bb,  payout 15%)
  // Micro: 0.40 - 0.80   (fee 0.6bb,  payout 25%)
  // Small: 1.00 - 3.00   (fee 0.25bb, payout 40%)
  // Mid:   4.00 - 8.00   (fee 0.12bb, payout 55%)
  // High:  10.0 - 40.0   (fee 0.06bb, payout 70%)
  // Nose:  50+            (fee 0.03bb, payout 85%)
  if (bigBlind <= 0.2) return STAKES_TIERS.nano;
  if (bigBlind <= 0.8) return STAKES_TIERS.micro;
  if (bigBlind <= 3) return STAKES_TIERS.small;
  if (bigBlind <= 8) return STAKES_TIERS.mid;
  if (bigBlind <= 40) return STAKES_TIERS.high;
  return STAKES_TIERS.nosebleeds;
}

/**
 * Get full rake + BBJ config for a given stakes/variant.
 * Tries exact schedule match first, then falls back to tier.
 * IMPORTANT: rakeCap is always an absolute dollar amount.
 */
export function getFullRakeConfig(
  smallBlind: number,
  bigBlind: number,
  variant: string = 'nlh'
): ServerRakeConfigResult {
  const scheduleMatch = findScheduleMatch(smallBlind, bigBlind);
  const tier = getTierForBB(bigBlind);

  // Normalize variant for lookup: 'plo4' and 'plo' both map to plo4 qualifying hand
  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant] || BBJ_QUALIFYING_HANDS.nlh;
  const bbjEligible = qualifying.eligible !== false;

  const rakePercent = scheduleMatch ? scheduleMatch.rakePercent : tier.rakePercent;
  const rakeCap = scheduleMatch ? scheduleMatch.rakeCap : tier.rakeCap;
  const bbjFeeBB = scheduleMatch ? scheduleMatch.bbjFeeBB : tier.bbjFeeBB;

  // BBJ payout: total % of pool varies by stakes tier (Dan's authoritative table)
  // Distribution is always 50/25/25 split of the total payout amount.
  const totalPayoutPercent = tier.bbjPayoutTotalPercent;

  return {
    tier: tier.label,
    blindRange: tier.blindRange,
    rakePercent,
    rakeCap,
    rakeCapDollars: rakeCap,
    bbjEnabled: bbjEligible,
    bbjFeeBB: bbjEligible ? bbjFeeBB : 0,
    bbjFeeDollars: bbjEligible ? Math.round(bigBlind * bbjFeeBB * 100) / 100 : 0,
    bbjPoolAllocation: BBJ_POOL_ALLOCATION,
    bbjPayoutTotalPercent: totalPayoutPercent,
    bbjPayoutLoser: totalPayoutPercent / 2, // 50% of total payout
    bbjPayoutWinner: totalPayoutPercent / 4, // 25% of total payout
    bbjPayoutTable: totalPayoutPercent / 4, // 25% of total payout (split among all dealt-in)
    qualifyingHand: qualifying,
    rules: BBJ_RULES,
    _exactMatch: !!scheduleMatch,
  };
}

/**
 * Calculate BBJ fee for a specific hand.
 * Returns the BBJ amount to deduct (in chips/dollars).
 * Returns 0 if BBJ conditions are not met.
 */
export function calculateBBJFee(
  smallBlind: number,
  bigBlind: number,
  potSize: number,
  numPlayersDealt: number,
  variant: string = 'nlh'
): number {
  const config = getFullRakeConfig(smallBlind, bigBlind, variant);

  if (!config.bbjEnabled) return 0;
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) return 0;
  if (potSize < bigBlind * BBJ_RULES.minPotBB) return 0;

  // BBJ fee = BB × bbjFeeBB, rounded to nearest cent
  return Math.round(bigBlind * config.bbjFeeBB * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ QUALIFYING HAND DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hand ranking values matching PokerEngine.HAND_RANKINGS.
 * Used here to avoid circular import (RakeConfig should not depend on PokerEngine).
 */
const HAND_RANK = {
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10,
} as const;

/** Rank values: A=14, K=13, Q=12, J=11, T=10, 9=9, ... 2=2 */
const RANK_VALUES: Record<string, number> = {
  A: 14,
  K: 13,
  Q: 12,
  J: 11,
  T: 10,
  '10': 10,
  '9': 9,
  '8': 8,
  '7': 7,
  '6': 6,
  '5': 5,
  '4': 4,
  '3': 3,
  '2': 2,
};

export interface BBJDetectionResult {
  hit: boolean;
  /** The player whose LOSING hand qualifies for BBJ (the "loser" gets biggest share) */
  loserUserId?: string;
  loserHand?: { ranking: number; name: string; kickers: number[] };
  /** The player whose WINNING hand beat the qualifying hand */
  winnerUserId?: string;
  winnerHand?: { ranking: number; name: string; kickers: number[] };
  /** All players dealt in (for table share) */
  dealtInPlayerIds?: string[];
  variant?: string;
  qualifyingHandLabel?: string;
}

/**
 * Check if a showdown resulted in a BBJ qualifying hit.
 *
 * BBJ rules (from Dan's authoritative screenshots):
 * - NLH/FLH: AAAJJ (Full House, Aces full of Jacks) or better must LOSE
 *   - Player holding Full House must have at least one Ace in hole cards
 *   - Both cards from hand must play
 * - PLO4/PLO8/Pineapple: KKKK (Four Kings) or better must LOSE
 *   - Must use exactly 2 cards from hand
 * - PLO5: 87654 Straight Flush or better must LOSE
 * - PLO6: NOT eligible
 * - Short Deck: NOT eligible
 *
 * Additional rules:
 * - Pot must be >= 10 BB
 * - 3+ players must be dealt in preflop (FIX 145)
 * - Not available for Double/Triple Board games
 * - If run it multiple times, only first runout counts
 * - If multiple losers qualify, prize split proportionally
 *
 * @param showdownResults - Array of { userId, handRanking, handName, kickers, holeCards }
 * @param winnerId - The user ID of the hand winner
 * @param variant - Game variant (nlh, plo4, plo5, etc.)
 * @param potSize - Pot size in chips/dollars
 * @param bigBlind - Big blind amount
 * @param numPlayersDealt - Number of players dealt in preflop
 * @param dealtInPlayerIds - All player IDs dealt in (for table share)
 */
export function detectBBJHit(
  showdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards?: Array<{ rank: string; suit: string }>;
  }>,
  winnerId: string,
  variant: string,
  potSize: number,
  bigBlind: number,
  numPlayersDealt: number,
  dealtInPlayerIds: string[]
): BBJDetectionResult {
  const noHit: BBJDetectionResult = { hit: false };

  // 1. Check basic BBJ eligibility
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) return noHit;
  if (potSize < bigBlind * BBJ_RULES.minPotBB) return noHit;

  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant];
  if (!qualifying || qualifying.eligible === false || !qualifying.minLosingHand) return noHit;

  // 2. Find the LOSER(s) with qualifying hands
  // A "loser" is any non-winner showdown player whose hand meets the minimum
  const losers = showdownResults.filter((r) => r.userId !== winnerId);
  const winner = showdownResults.find((r) => r.userId === winnerId);
  if (!winner || losers.length === 0) return noHit;

  // 3. Check each loser against the qualifying minimum
  for (const loser of losers) {
    const qualifies = doesHandQualify(
      loser.handRanking,
      loser.kickers,
      loser.holeCards || [],
      qualifying,
      normalizedVariant
    );

    if (qualifies) {
      return {
        hit: true,
        loserUserId: loser.userId,
        loserHand: {
          ranking: loser.handRanking,
          name: loser.handName,
          kickers: loser.kickers,
        },
        winnerUserId: winnerId,
        winnerHand: {
          ranking: winner.handRanking,
          name: winner.handName,
          kickers: winner.kickers,
        },
        dealtInPlayerIds,
        variant: normalizedVariant,
        qualifyingHandLabel: qualifying.label,
      };
    }
  }

  return noHit;
}

/**
 * Check if a specific hand meets the BBJ minimum qualifying hand.
 */
function doesHandQualify(
  handRanking: number,
  kickers: number[],
  holeCards: Array<{ rank: string; suit: string }>,
  qualifying: BBJQualifyingHand,
  variant: string
): boolean {
  if (!qualifying.handRank || !qualifying.minRankValue) return false;

  switch (qualifying.handRank) {
    case 'full_house': {
      // NLH/FLH: Must have Full House (7) or better.
      // Minimum: AAAJJ → kickers [14,14,14,11,11] or better
      if (handRanking < HAND_RANK.FULL_HOUSE) return false;
      if (handRanking > HAND_RANK.FULL_HOUSE) return true; // Quads+ always qualifies

      // Full House: check if it's Aces full of Jacks or better
      // kickers format: [trip_rank, pair_rank] (e.g., [14, 11] for AAAJJ)
      if (kickers.length < 2) return false;
      const tripRank = kickers[0];
      const pairRank = kickers[1];

      // Must be Aces full (tripRank = 14)
      if (tripRank < 14) return false;
      // Pair must be Jacks (11) or better
      if (pairRank < 11) return false;

      // NLH/FLH rule: Player must have at least one Ace in hole cards
      // FIX 146: Both NLH and FLH require this check (same qualifying rules)
      if (variant === 'nlh' || variant === 'flh') {
        const hasAceInHole = holeCards.some((c) => c.rank === 'A' || c.rank === '14');
        if (!hasAceInHole) return false;
      }

      return true;
    }

    case 'four_of_a_kind': {
      // PLO4/PLO8/Pineapple: Must have Four of a Kind (8) with Kings or better
      if (handRanking < HAND_RANK.FOUR_OF_A_KIND) return false;
      if (handRanking > HAND_RANK.FOUR_OF_A_KIND) return true; // SF+ always qualifies

      // Four of a Kind: check if quads rank is Kings (13) or better
      if (kickers.length < 1) return false;
      const quadsRank = kickers[0];
      return quadsRank >= 13; // K=13, A=14
    }

    case 'straight_flush': {
      // PLO5: Must have Straight Flush (9) with 8-high or better
      if (handRanking < HAND_RANK.STRAIGHT_FLUSH) return false;
      if (handRanking >= HAND_RANK.ROYAL_FLUSH) return true; // Royal always qualifies

      // Straight Flush: check if the high card is 8 or better
      // kickers for straight flush: [high_card_rank]
      if (kickers.length < 1) return false;
      const highCardRank = kickers[0];
      return highCardRank >= 8; // 87654 SF = high card 8
    }

    default:
      return false;
  }
}
