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
 *   - 4+ players must be dealt in preflop
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
  bbjPayoutLoser: number;
  bbjPayoutWinner: number;
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

// BBJ Pool Allocation — uniform across all stakes
export const BBJ_POOL_ALLOCATION = {
  mainBBJ: 0.4, // 40% of BBJ rake goes to Main BBJ pool
  backUpBBJ: 0.3, // 30% goes to Back Up BBJ pool
  promotional: 0.3, // 30% goes to Promotional fund
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// STAKES TIERS — Fallback for custom/non-standard stakes
// ═══════════════════════════════════════════════════════════════════════════════

export const STAKES_TIERS: Record<string, StakesTier> = {
  nano: {
    label: 'Nano',
    blindRange: '0.05/0.10 - 0.25/0.50',
    minBB: 0.1,
    maxBB: 0.5,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6,
  },
  micro: {
    label: 'Micro',
    blindRange: '0.30/0.60 - 0.50/1.00',
    minBB: 0.6,
    maxBB: 1,
    rakePercent: 10,
    rakeCap: 5,
    rakeCapBB: 5,
    bbjFeeBB: 0.25,
  },
  small: {
    label: 'Small',
    blindRange: '1/2',
    minBB: 1.5,
    maxBB: 3,
    rakePercent: 10,
    rakeCap: 5,
    rakeCapBB: 5,
    bbjFeeBB: 0.25,
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
  },
  high: {
    label: 'High',
    blindRange: '5/10 - 10/25',
    minBB: 9,
    maxBB: 25,
    rakePercent: 10,
    rakeCap: 15,
    rakeCapBB: 15,
    bbjFeeBB: 0.06,
  },
  nosebleeds: {
    label: 'Nosebleeds',
    blindRange: '25/50+',
    minBB: 26,
    maxBB: Infinity,
    rakePercent: 10,
    rakeCap: 20,
    rakeCapBB: 20,
    bbjFeeBB: 0.03,
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
  // Alias: plo_hilo maps to same rules as plo8
  plo_hilo: {
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
    minLosingHand: '87654',
    description: 'Straight Flush (8-high) or better must LOSE',
    rules: ['Must use exactly 2 cards from hand'],
    handRank: 'straight_flush',
    minRankValue: '87654',
  },
  short_deck: {
    label: 'Short Deck',
    minLosingHand: null,
    description: 'BBJ not available for Short Deck',
    rules: [],
    eligible: false,
  },
  ofc: {
    label: 'Open Face Chinese',
    minLosingHand: null,
    description: 'BBJ not available for OFC',
    rules: [],
    eligible: false,
  },
  ofc_pineapple: {
    label: 'OFC Pineapple',
    minLosingHand: null,
    description: 'BBJ not available for OFC Pineapple',
    rules: [],
    eligible: false,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ GENERAL RULES
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJ_RULES = {
  minPotBB: 10,
  minPlayersDealt: 4,
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
  if (bigBlind <= 0.5) return STAKES_TIERS.nano;
  if (bigBlind <= 1) return STAKES_TIERS.micro;
  if (bigBlind <= 3) return STAKES_TIERS.small;
  if (bigBlind <= 8) return STAKES_TIERS.mid;
  if (bigBlind <= 25) return STAKES_TIERS.high;
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
    bbjPayoutLoser: 50,
    bbjPayoutWinner: 25,
    bbjPayoutTable: 25,
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
