/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Rake & BBJ Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `lib/poker-engine/RakeConfig.js`.
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

export interface RakeConfigResult {
  tier: string;
  blindRange: string;
  rakePercent: number;
  rakeCap: number;
  rakeCapBB: number;
  rakeCapDollars: number;
  bbjEnabled: boolean;
  bbjFeeBB: number;
  bbjPoolAllocation: typeof BBJ_POOL_ALLOCATION;
  bbjPayoutTotal: number;
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
  // BBJ-SYNC 2026-08-18: server (the authority that actually detects hits)
  // marks PLO6 ineligible — this entry used to advertise an 8-high SF rule the
  // engine never pays. Synced to match server/src/config/RakeConfig.ts.
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
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ TABLE-WIDGET LABELS (2026-08-18)
// ═══════════════════════════════════════════════════════════════════════════════
// The on-table jackpot widget used to hardcode "Quad 8s or better" — wrong for
// every variant we spread (NLH is Aces full of Jacks losing to Quads+). These
// helpers turn whatever gameType string the table state carries (short variant
// keys like 'plo4' OR display names like "No Limit Hold'em") into the correct
// per-variant qualifying text.

/** Normalize a gameType string (variant key or display name) to a BBJ_QUALIFYING_HANDS key. */
export function normalizeVariantKey(gameType: string | null | undefined): string {
  const raw = String(gameType || 'nlh')
    .toLowerCase()
    .trim();
  if (BBJ_QUALIFYING_HANDS[raw]) return raw;
  if (raw.includes('short')) return 'short_deck';
  if (raw.includes('omaha') || raw.startsWith('plo') || raw.startsWith('flo')) {
    if (raw.includes('hi-lo') || raw.includes('hilo') || raw.includes('8 or better')) return 'plo8';
    const m = raw.match(/[4568]/);
    if (m) {
      const key = 'plo' + m[0];
      if (BBJ_QUALIFYING_HANDS[key]) return key;
    }
    return 'plo4';
  }
  // Hold'em display names ("No Limit Hold'em", "Fixed Limit Hold'em") + unknowns
  if (raw.includes('fixed limit')) return 'flh';
  return 'nlh';
}

export interface BBJWidgetInfo {
  eligible: boolean;
  /** One-line qualifying rule for the widget popover. */
  shortLabel: string;
  /** Hole-card requirement line under the rule. */
  subLabel: string;
  variantLabel: string;
}

const BBJ_SHORT_LABELS: Record<string, string> = {
  nlh: 'Aces full of Jacks or better must lose to Quads or better',
  flh: 'Aces full of Jacks or better must lose to Quads or better',
  plo4: 'Quad Kings or better must lose',
  plo: 'Quad Kings or better must lose',
  plo8: 'Quad Kings or better must lose (high hand only)',
  plo_hilo: 'Quad Kings or better must lose (high hand only)',
  plo5: '8-high Straight Flush or better must lose',
};

/**
 * BBJ payout percent for a table's big blind — SYNCED TO THE SERVER (2026-08-18).
 *
 * The server pays a stakes-tiered slice of the main pool (nano 15% ... nosebleeds
 * 85%); the client's own STAKES_TIERS carry no payout percent and its tier
 * boundaries have drifted from the server's, so this helper mirrors the server's
 * getTierForBB boundaries EXACTLY (server/src/config/RakeConfig.ts) rather than
 * reusing the local tier table. If the widget preview ever disagrees with a real
 * payout, fix it HERE by re-syncing with the server file.
 */
export function getBBJPayoutPercentForBB(bigBlind: number | string): number {
  const bb = parseFloat(String(bigBlind)) || 0;
  if (bb <= 0.2) return 15; // Nano
  if (bb <= 0.8) return 25; // Micro
  if (bb <= 3) return 40; // Small
  if (bb <= 8) return 55; // Mid
  if (bb <= 40) return 70; // High
  return 85; // Nosebleeds
}

/** Per-variant info for the on-table BBJ widget. */
export function getBBJQualifyingInfo(gameType: string | null | undefined): BBJWidgetInfo {
  const key = normalizeVariantKey(gameType);
  const q = BBJ_QUALIFYING_HANDS[key] || BBJ_QUALIFYING_HANDS.nlh;
  if (q.eligible === false) {
    return {
      eligible: false,
      shortLabel: 'Bad Beat Jackpot not available for ' + q.label,
      subLabel: '',
      variantLabel: q.label,
    };
  }
  const isOmaha = key.startsWith('plo');
  return {
    eligible: true,
    shortLabel: BBJ_SHORT_LABELS[key] || q.description,
    subLabel: isOmaha
      ? 'Exactly two hole cards must play (both players).'
      : 'Both hole cards must play (with an Ace for the full house).',
    variantLabel: q.label,
  };
}

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
export function findScheduleMatch(
  smallBlind: number | string,
  bigBlind: number | string
): RakeScheduleEntry | null {
  const sb = parseFloat(String(smallBlind)) || 0;
  const bb = parseFloat(String(bigBlind)) || 0;
  return (
    RAKE_SCHEDULE.find((row) => Math.abs(row.sb - sb) < 0.001 && Math.abs(row.bb - bb) < 0.001) ||
    null
  );
}

/**
 * Get tier config for a given Big-Blind size (fallback for non-exact matches).
 */
export function getTierForBB(bigBlind: number | string): StakesTier {
  const bb = parseFloat(String(bigBlind)) || 0;
  if (bb <= 0.5) return STAKES_TIERS.nano;
  if (bb <= 1) return STAKES_TIERS.micro;
  if (bb <= 3) return STAKES_TIERS.small;
  if (bb <= 8) return STAKES_TIERS.mid;
  if (bb <= 25) return STAKES_TIERS.high;
  return STAKES_TIERS.nosebleeds;
}

/**
 * Get full rake + BBJ config for a given stakes/variant.
 * Tries exact schedule match first, then falls back to tier.
 * IMPORTANT: rakeCap is always an absolute dollar amount.
 */
/**
 * A table's (or club's) rake override, mirroring the server's RakeOverride.
 * -1 / null / undefined all mean "inherit — use the schedule".
 *
 * This exists so the Game Rules modal shows what is ACTUALLY taken. The whole
 * point of the 2026-08-15 display fix was that the number on screen is the
 * number the engine uses; once a table can override the schedule, reading the
 * schedule alone would recreate that bug for exactly the tables whose owner
 * bothered to change it.
 *
 * Keep the resolution rules identical to
 * server/src/config/RakeConfig.ts getFullRakeConfig.
 */
export interface RakeOverride {
  rakePercent?: number | null;
  rakeCapBB?: number | null;
}

/** Sentinel stored in the database meaning "inherit". */
export const RAKE_INHERIT = -1;
/** An owner may never rake above the published schedule rate. */
export const MAX_RAKE_PERCENT = 10;
/** …nor set a cap above 10 big blinds. */
export const MAX_RAKE_CAP_BB = 10;

function isRakeSet(v: number | null | undefined): v is number {
  if (v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

export function getRakeConfig(
  bigBlind: number | string,
  variant: string = 'nlh',
  smallBlind: number | string | null = null,
  override?: RakeOverride
): RakeConfigResult {
  const sb = smallBlind != null ? parseFloat(String(smallBlind)) : parseFloat(String(bigBlind)) / 2;
  const bb = parseFloat(String(bigBlind)) || 0;
  const scheduleMatch = findScheduleMatch(sb, bb);

  const tier = getTierForBB(bb);
  const qualifying = BBJ_QUALIFYING_HANDS[variant] || BBJ_QUALIFYING_HANDS.nlh;
  const bbjEligible = qualifying.eligible !== false;

  const clampNum = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const schedulePercent = scheduleMatch ? scheduleMatch.rakePercent : tier.rakePercent;
  const scheduleCap = scheduleMatch ? scheduleMatch.rakeCap : tier.rakeCap;

  const rakePercent = isRakeSet(override?.rakePercent)
    ? clampNum(Number(override!.rakePercent), 0, MAX_RAKE_PERCENT)
    : schedulePercent;
  // Big blinds -> dollars, exactly as the server does it.
  const rakeCap = isRakeSet(override?.rakeCapBB)
    ? Math.round(clampNum(Number(override!.rakeCapBB), 0, MAX_RAKE_CAP_BB) * bb * 100) / 100
    : scheduleCap;
  const bbjFeeBB = scheduleMatch ? scheduleMatch.bbjFeeBB : tier.bbjFeeBB;

  return {
    tier: tier.label,
    blindRange: tier.blindRange,
    rakePercent,
    rakeCap,
    rakeCapBB: rakeCap,
    rakeCapDollars: rakeCap,
    bbjEnabled: bbjEligible,
    bbjFeeBB: bbjEligible ? bbjFeeBB : 0,
    bbjPoolAllocation: BBJ_POOL_ALLOCATION,
    bbjPayoutTotal: 100,
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
 */
export function calculateBBJFee(
  bigBlind: number | string,
  potSize: number,
  numPlayersDealt: number,
  variant: string = 'nlh',
  smallBlind: number | string | null = null
): number {
  const config = getRakeConfig(bigBlind, variant, smallBlind);
  const bb = parseFloat(String(bigBlind)) || 0;

  if (!config.bbjEnabled) return 0;
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) return 0;
  if (potSize < bb * BBJ_RULES.minPotBB) return 0;

  return Math.round(bb * config.bbjFeeBB * 100) / 100;
}

/**
 * Get allowed stakes for table creation UI.
 * Returns the official list of supported stake levels.
 */
export function getAllowedStakes() {
  return RAKE_SCHEDULE.map((row) => ({
    label: `${row.sb}/${row.bb}`,
    smallBlind: row.sb,
    bigBlind: row.bb,
    rakeCap: row.rakeCap,
    bbjFeeBB: row.bbjFeeBB,
  }));
}
