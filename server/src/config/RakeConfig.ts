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

// BBJ AUDIT FIX 2026-08-18: enforce Dan's 'both cards from hand must play'.
import { evaluateHand, compareHands } from '../engine/PokerEngine.js';

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
  /** Which fields came from a table/club override rather than the schedule. */
  _overridden: { percent: boolean; cap: boolean };
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
  // ── ADDED 2026-08-31 (Dan, binding) ──────────────────────────────────────
  // Dan: "WE HAVE A SCALE THAT WE USE FOR THE CASH GAME FOR RAKE AND BBJ, USE
  // THE SAME PERCENTAGES WE USE FOR THE OTHER GAMES, IF YOU DON'T HAVE A RAKE
  // OR BBJ SCHEDULE FOR A SPECIFIC GAME."
  //
  // Six of the twelve blind presets the create-table form offers had no row
  // here, so findScheduleMatch returned null and the price fell through to
  // getTierForBB - a tier whose cap is an ABSOLUTE DOLLAR AMOUNT applied
  // regardless of stake. At the bottom of the ladder that is not a small
  // discrepancy, it is an order of magnitude:
  //
  //     0.01/0.02   $3 flat  =  150 BB
  //     0.02/0.05   $3 flat  =   60 BB
  //     0.05/0.10   $3 flat  =   30 BB   <- THE DEFAULT PRESET
  //     0.10/0.25   $3 flat  =   12 BB
  //
  // against a published ladder whose most generous row (0.1/0.2) is 15 BB and
  // whose typical row is 1-6 BB. The DB creation guard had declined to police
  // this in as many words: "NOT enforced here and left for Dan: the official
  // stakes schedule."
  //
  // HOW THESE NUMBERS WERE DERIVED - no rate is invented:
  //   rakePercent  10 at every stake, as every existing row already is.
  //   rakeCap      the same BB proportion the schedule's own cheapest
  //                published row charges (0.1/0.2 at $3 = 15 BB), so the
  //                three sub-0.2 stakes are 15 BB in dollars. 0.10/0.25 sits
  //                inside the schedule's existing flat-$3 band (0.2, 0.4 and
  //                0.5 are all $3) and takes $3. The two nosebleed rows take
  //                the Nosebleeds tier's own $20, which is what they are
  //                charged today - adding the row changes no price, it just
  //                makes the price published rather than inherited.
  //   bbjFeeBB     the tier's fee for that stake, unchanged: Nano/Micro 0.6,
  //                Nosebleeds 0.03.
  //
  // LIVE EFFECT, measured against production before committing: of 972 cash
  // tables, exactly TWO sit on a stake whose price moves - the two at
  // 0.05/0.10, whose cap falls $3 -> $1.50. Both are closed. Every other live
  // stake was already on the schedule and is untouched. No player pays more.
  { sb: 0.01, bb: 0.02, rakePercent: 10, rakeCap: 0.3, bbjFeeBB: 0.6 },
  { sb: 0.02, bb: 0.05, rakePercent: 10, rakeCap: 0.75, bbjFeeBB: 0.6 },
  { sb: 0.05, bb: 0.1, rakePercent: 10, rakeCap: 1.5, bbjFeeBB: 0.6 },
  { sb: 0.1, bb: 0.25, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 25, bb: 50, rakePercent: 10, rakeCap: 20, bbjFeeBB: 0.03 },
  { sb: 50, bb: 100, rakePercent: 10, rakeCap: 20, bbjFeeBB: 0.03 },
];

// FIX 166: Bible V8 §7.19 / §2.9 — Player-count-based rake caps.
// Standard poker rule: heads-up and short-handed games get lower rake caps.
// Each entry defines a player threshold and its corresponding cap MULTIPLIER.
// The engine finds the highest tier where playerCount >= players, then applies: cap × multiplier.
export function getPlayerCountCaps(fullCap: number): { players: number; cap: number }[] {
  return [
    { players: 2, cap: Math.round(fullCap * 0.5 * 100) / 100 }, // Heads-up: 50% of cap
    { players: 3, cap: Math.round(fullCap * 0.67 * 100) / 100 }, // 3-handed: 67% of cap
    { players: 4, cap: fullCap }, // 4+ players: full cap
  ];
}

// BBJ POOL ALLOCATION (Dan, 2026-08-18 — authoritative)
//   STANDARD (main pool < 100k):  50% Main / 25% Back Up / 25% Promo
//   PIVOT    (main pool >= 100k): 25% Main / 25% Back Up / 50% Promo
// Past the pivot the jackpot is already large, so new rake is steered into the
// promo wallet rather than growing main further; the Back Up share is held flat
// at 25% because its job is to reseed main after a full hit, not to grow.
// This constant is the STANDARD split; the pivot split is applied at banking
// time in logBBJCollection against the LIVE main balance.
export const BBJ_POOL_ALLOCATION = {
  mainBBJ: 0.5, // 50% of BBJ rake goes to Main BBJ pool (standard)
  backUpBBJ: 0.25, // 25% goes to Back Up BBJ pool (standard)
  promotional: 0.25, // 25% goes to Promotional fund (standard)
} as const;

/** Applied once the main pool reaches BBJ_PIVOT_THRESHOLD (100,000). */
export const BBJ_POOL_ALLOCATION_PIVOT = {
  mainBBJ: 0.25,
  backUpBBJ: 0.25,
  promotional: 0.5,
} as const;

export const BBJ_PIVOT_THRESHOLD = 100000;

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
    description: 'Four of a Kind (Kings) or better must LOSE - evaluated on HIGH hand only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  // 2026-08-23: flo8 (Fixed Limit Omaha Hi-Lo) is the same GAME as plo8 — same
  // four cards, same exactly-two rule, same 8-or-better low. Only the betting
  // differs, and the betting has nothing to do with which hand qualifies for
  // the jackpot. Same entry, exactly as `flh` aliases `nlh` above.
  flo8: {
    label: 'FLO8 (Hi-Lo 8 or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four of a Kind (Kings) or better must LOSE - evaluated on HIGH hand only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  // FIX 116: plo_hilo dead variant removed — plo8 and flo8 are the hi-lo variants
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
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ GENERAL RULES
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJ_RULES = {
  /**
   * PAYOUT floor ONLY (Dan 2026-08-29): a bad beat pays out only when the pot
   * held more than this many big blinds. The FEE is collected on every flop
   * with 3+ dealt regardless of pot size — do not re-add this to a fee gate.
   */
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
 * A per-table (or per-club) rake override. Both fields use RAKE_INHERIT (-1),
 * null or undefined to mean "not set — fall through to the next level".
 *
 * 2026-08-18: until now `tables.rake_percent`, `tables.rake_cap_bb`,
 * `clubs.default_rake_percent` and `clubs.rake_cap` were written by four
 * owner-facing controls and read by nothing. An owner who set "Fee 2%" still
 * had 10% taken. These are the values that make those controls real.
 */
export interface RakeOverride {
  /** Whole-percent units, e.g. 7.5 means 7.5%. */
  rakePercent?: number | null;
  /** BIG BLINDS, not dollars. Converted here and only here. */
  rakeCapBB?: number | null;
}

/** Sentinel stored in the database meaning "inherit". */
export const RAKE_INHERIT = -1;
/** An owner may never rake above the published schedule rate. */
export const MAX_RAKE_PERCENT = 10;
/** …nor set a cap above 10 big blinds. Matches the create-table slider. */
export const MAX_RAKE_CAP_BB = 10;

/**
 * THE MOST GENEROUS SHARE OF A BIG BLIND ANY PUBLISHED ROW TAKES.
 *
 * Derived from RAKE_SCHEDULE rather than written down, so it cannot drift from
 * the ladder it describes. Today that is the 0.1/0.2 row: a $3 cap on a $0.20
 * big blind, 15 BB.
 *
 * Dan, 2026-08-31: "IF YOU DON'T HAVE A RAKE OR BBJ SCHEDULE FOR A SPECIFIC
 * GAME, USE THE SAME PERCENTAGES WE USE FOR THE OTHER GAMES." A stake with no
 * row falls through to a stakes TIER, and a tier's cap is an absolute dollar
 * amount - which is a sane number at the stake the tier was written for and an
 * absurd one two rungs below it ($3 on a $0.02 big blind is 150 BB). Holding
 * the fallback to this proportion is what makes an unscheduled stake priced
 * "the same as the other games" instead of priced by accident.
 *
 * This binds ONLY the fallback. A stake with its own published row is charged
 * that row, and MAX_RAKE_CAP_BB continues to bind operator OVERRIDES - a
 * separate ceiling for a separate thing.
 */
export const UNSCHEDULED_CAP_BB = RAKE_SCHEDULE.reduce(
  (worst, row) => (row.bb > 0 ? Math.max(worst, row.rakeCap / row.bb) : worst),
  0
);

/** The cap for a stake with no published row: the tier's, held to the ladder. */
export function unscheduledCapFor(bigBlind: number, tierCap: number): number {
  if (!(bigBlind > 0)) return tierCap;
  return Math.min(tierCap, Math.round(bigBlind * UNSCHEDULED_CAP_BB * 100) / 100);
}

/** true only for a real, in-range number; -1 / null / NaN / '' all mean inherit. */
function isRakeSet(v: number | null | undefined): v is number {
  if (v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Get full rake + BBJ config for a given stakes/variant.
 * Tries exact schedule match first, then falls back to tier.
 * IMPORTANT: rakeCap is always an absolute dollar amount.
 *
 * `override` lets a table or club take LESS than the schedule. It can never
 * take more, and that is enforced twice: the raw value is clamped to
 * MAX_RAKE_PERCENT / MAX_RAKE_CAP_BB so an absurd row cannot get through, and
 * the result is then min()'d against the published schedule for the stake so
 * the game's max rake is never exceeded. Anything non-finite falls back to the
 * schedule rather than throwing — a bad row must not be able to stop a table
 * dealing. These guards are load-bearing: `tables` is UPDATE-able by any club
 * admin through RLS, so the database is not a trusted source for these two
 * numbers.
 *
 * The BBJ fields are deliberately NOT overridable. The jackpot drop is a fixed
 * number of big blinds from the schedule and funds a shared pool; letting one
 * table opt out of contributing while still being eligible to win would be a
 * way to farm the pool.
 */
export function getFullRakeConfig(
  smallBlind: number,
  bigBlind: number,
  variant: string = 'nlh',
  override?: RakeOverride
): ServerRakeConfigResult {
  const scheduleMatch = findScheduleMatch(smallBlind, bigBlind);
  const tier = getTierForBB(bigBlind);

  // Normalize variant for lookup: 'plo4' and 'plo' both map to plo4 qualifying hand
  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant] || BBJ_QUALIFYING_HANDS.nlh;
  const bbjEligible = qualifying.eligible !== false;

  const schedulePercent = scheduleMatch ? scheduleMatch.rakePercent : tier.rakePercent;
  const scheduleCap = scheduleMatch
    ? scheduleMatch.rakeCap
    : unscheduledCapFor(bigBlind, tier.rakeCap);
  const bbjFeeBB = scheduleMatch ? scheduleMatch.bbjFeeBB : tier.bbjFeeBB;

  const overridePercent = isRakeSet(override?.rakePercent)
    ? clamp(Number(override!.rakePercent), 0, MAX_RAKE_PERCENT)
    : null;
  // BIG BLINDS -> DOLLARS happens here and nowhere else. Everything downstream
  // (calculateRake's Math.min, getPlayerCountCaps' 0.5x / 0.67x short-handed
  // multipliers) assumes an absolute cash cap.
  const overrideCap = isRakeSet(override?.rakeCapBB)
    ? round2(clamp(Number(override!.rakeCapBB), 0, MAX_RAKE_CAP_BB) * bigBlind)
    : null;

  // Each game has a max rake, and that maximum is the published schedule for
  // the stake. An override may only move DOWNWARD from it.
  //
  // 2026-08-19: the clamps above bound an override to MAX_RAKE_PERCENT and
  // MAX_RAKE_CAP_BB, which stops an absurd value but is NOT the published
  // ceiling. Because the cap is denominated in big blinds, 10 BB was worth far
  // more than the schedule cap at every stake above micro — $20 at 1/2 against
  // a $5 cap, $100 at 5/10 against $12.50, $250 at 10/25 against $15. A club
  // admin can UPDATE these columns through RLS, so this min() is the guard
  // that actually holds the published rate.
  const rakePercent =
    overridePercent !== null ? Math.min(overridePercent, schedulePercent) : schedulePercent;
  const rakeCap = overrideCap !== null ? Math.min(overrideCap, scheduleCap) : scheduleCap;

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
    _overridden: { percent: overridePercent !== null, cap: overrideCap !== null },
  };
}

/**
 * Calculate BBJ fee for a specific hand — the COLLECTION rule.
 *
 * Dan 2026-08-29 (BINDING): "POT DOESN'T NEED TO BE 10 BB FOR THE BBJ TO BE
 * TAKEN OUT... IF THERE IS A FLOP, BBJ SHOULD BE RAKED (3 OR MORE PLAYERS
 * DEALT INTO THE HAND). BAD BEAT JACKPOT IS ONLY PAID OUT IF THERE IS MORE
 * THAN 10 BB IN THE POT... BIG DIFFERENCE."
 *
 * Collection gates: eligible variant, flop seen, 3+ players dealt in.
 * BBJ_RULES.minPotBB gates the PAYOUT only (detectBBJHit).
 * The live engine paths (HandController completeHand / finalizeRunout /
 * computeRakeAndBBJ) implement this same rule inline.
 */
export function calculateBBJFee(
  smallBlind: number,
  bigBlind: number,
  flopSeen: boolean,
  numPlayersDealt: number,
  variant: string = 'nlh'
): number {
  const config = getFullRakeConfig(smallBlind, bigBlind, variant);

  if (!config.bbjEnabled) return 0;
  if (!flopSeen) return 0;
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) return 0;

  // BBJ fee = BB × bbjFeeBB, rounded to nearest cent
  return Math.round(bigBlind * config.bbjFeeBB * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ QUALIFYING HAND DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hand ranking values matching PokerEngine.HAND_RANKINGS.
 * Historical note: HAND_RANK was duplicated here to avoid importing
 * PokerEngine. The 2026-08-18 both-cards-play rule genuinely needs the
 * evaluator, and PokerEngine only imports from types.js - no cycle exists.
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
  /**
   * The pot winner, or ALL of them on a chopped pot.
   *
   * AUDIT FIX 2026-08-27: settlement passed `currentHandWinnerIds[0]` and this
   * took a single id, so on a split pot exactly one winner was examined. The
   * "winner must hold quads or better" gate then ran against whichever winner
   * happened to be first in the array — and if the OTHER one held the quads,
   * a real bad beat was silently refused. That is a false negative on a money
   * surface: the player who took the beat is simply not paid, and nothing
   * anywhere records that a jackpot was considered and dropped.
   *
   * All winners are now evaluated and the STRONGEST is the one the rule is
   * applied to, mirroring exactly what the loser side has done since
   * 2026-08-18. A string is still accepted so every existing caller and test
   * keeps working unchanged.
   */
  winnerId: string | string[],
  variant: string,
  potSize: number,
  bigBlind: number,
  numPlayersDealt: number,
  dealtInPlayerIds: string[],
  // BBJ AUDIT FIX 2026-08-18: the final community cards (board 0 for RIT
  // hands). Needed to enforce Dan's "both cards from hand must play" rule -
  // BBJ_RULES.requireBothHoleCards was declared and never enforced.
  communityCards?: Array<{ rank: string; suit: string }>,
  /**
   * AUDIT FIX 2026-08-27: the last two BBJ_RULES that were declared, published
   * to players, and enforced NOWHERE.
   *
   * `excludeDoubleBoard` and `onlyFirstRunout` appeared in exactly two places
   * before today: this constant, and the rules panel that tells players they
   * apply (BBJBasicPanel.tsx:266-269, BBJRulesPanel.tsx:151). No code read
   * them. A double-board bomb pot could therefore pay a jackpot that the
   * published rules say it cannot — the rules page and the engine disagreed,
   * and the engine wins, which means the page was lying.
   *
   * `onlyFirstRunout` needs no flag and never did: `SHOWDOWN` is emitted once
   * per hand (HandController.ts:1559), before the extra runouts happen in
   * ServerTableEngineRunout, so `showdownResults` is already board one's
   * evaluation — and settlement passes board one's cards to match. It is
   * asserted by construction rather than by a condition. Saying so here is the
   * point: the next person to read the rule should not have to re-derive that.
   */
  context?: { doubleBoard?: boolean }
): BBJDetectionResult {
  const noHit: BBJDetectionResult = { hit: false };

  // 1. Check basic BBJ eligibility
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) return noHit;
  if (potSize < bigBlind * BBJ_RULES.minPotBB) return noHit;
  // A double-board bomb pot deals two boards for one pot, so a "bad beat" on
  // one of them is not the hand the jackpot is for.
  if (BBJ_RULES.excludeDoubleBoard && context?.doubleBoard === true) return noHit;

  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant];
  if (!qualifying || qualifying.eligible === false || !qualifying.minLosingHand) return noHit;

  // 2. Find the LOSER(s) with qualifying hands
  // A "loser" is any non-winner showdown player whose hand meets the minimum
  const winnerIds = Array.isArray(winnerId) ? winnerId.filter(Boolean) : [winnerId];
  const winnerIdSet = new Set(winnerIds);
  const losers = showdownResults.filter((r) => !winnerIdSet.has(r.userId));
  // On a chopped pot, the rule is applied to the STRONGEST winning hand — the
  // same "take the best, not the first" rule the loser side uses below.
  const winner = showdownResults
    .filter((r) => winnerIdSet.has(r.userId))
    .reduce<(typeof showdownResults)[number] | undefined>((best, r) => {
      if (!best) return r;
      if (r.handRanking > best.handRanking) return r;
      if (r.handRanking === best.handRanking && compareKickers(r.kickers, best.kickers) > 0)
        return r;
      return best;
    }, undefined);
  if (!winner || losers.length === 0) return noHit;

  // BBJ AUDIT FIX 2026-08-18 (the $99k finding): the WINNER's hand was never
  // checked. Dan's NLH/FLH rule reads "AAAJJ+ must LOSE TO QUADS OR STRAIGHT
  // FLUSH" - but a bigger full house (boat-over-boat) was triggering the
  // jackpot: 25 of the 39 live payouts ($99,066 of $148,121) were paid on
  // hands the pot-winner took with a mere Full House. For the quads/SF
  // variants the loser rule already implies a qualifying winner (whatever
  // beats quad kings is quad aces or a straight flush), but it is asserted
  // here uniformly anyway: the winning hand must be Four of a Kind or better
  // (PLO5's straight-flush floor is stricter still and implied by victory).
  if (winner.handRanking < HAND_RANK.FOUR_OF_A_KIND) return noHit;

  // BBJ AUDIT FIX 2026-08-18: "Both cards from hand must play" - declared in
  // BBJ_RULES and the NLH/FLH rule text, enforced nowhere. For hold'em-family
  // variants (2 hole cards at showdown: nlh, flh, pineapple post-discard),
  // BOTH the loser's and the winner's best five must use both hole cards.
  // Omaha variants are game-enforced (exactly 2 of 4/5 always play).
  const needBothCards =
    BBJ_RULES.requireBothHoleCards &&
    (normalizedVariant === 'nlh' ||
      normalizedVariant === 'flh' ||
      normalizedVariant === 'pineapple');
  const shortDeck = normalizedVariant === 'short_deck';
  const bothPlayOk = (hole: Array<{ rank: string; suit: string }>): boolean => {
    if (!needBothCards) return true;
    // FAIL CLOSED 2026-08-18 (live finding, $11,392.67 across 3 hits, most
    // recent 15:14 that day): this used to `return true` when no board was
    // supplied — "legacy behavior" — which silently DISABLED the
    // both-cards-must-play rule instead of enforcing it. Every one of those
    // three payouts was a hand where the BOARD itself made quads, so no
    // player's two hole cards could both play; the rule would have rejected
    // all of them had it run.
    //
    // A qualifying hand always needs a five-card board, so refusing to pay
    // when we cannot see one cannot cost a legitimate jackpot — while paying
    // blind demonstrably costs real money. If the board is missing, that is a
    // bug upstream to fix, not a payout to wave through.
    if (!communityCards || communityCards.length < 5) return false;
    if (hole.length < 2) return false;
    return bothHoleCardsPlay(hole, communityCards, shortDeck);
  };

  if (!bothPlayOk(winner.holeCards || [])) return noHit;

  // 3. Check each loser against the qualifying minimum.
  // BBJ AUDIT FIX 2026-08-18: evaluate ALL losers and take the STRONGEST
  // qualifying hand (was: first in seat order). BBJ_RULES.splitIfMultipleQualify
  // remains a documented aspiration - a split payout needs the atomic payout
  // RPC to accept two bad-beat holders and the odds of two independent
  // qualifying losers in one hand are astronomical; the strongest-hand rule
  // is deterministic and favors the worse beat.
  let best: (typeof losers)[number] | null = null;
  for (const loser of losers) {
    const qualifies = doesHandQualify(
      loser.handRanking,
      loser.kickers,
      loser.holeCards || [],
      qualifying,
      normalizedVariant
    );
    if (!qualifies) continue;
    if (!bothPlayOk(loser.holeCards || [])) continue;
    if (
      best === null ||
      loser.handRanking > best.handRanking ||
      (loser.handRanking === best.handRanking && compareKickers(loser.kickers, best.kickers) > 0)
    ) {
      best = loser;
    }
  }

  if (best) {
    return {
      hit: true,
      loserUserId: best.userId,
      loserHand: {
        ranking: best.handRanking,
        name: best.handName,
        kickers: best.kickers,
      },
      // The winner the rule was actually applied to, which on a chopped pot is
      // the strongest of them rather than whichever id arrived first.
      winnerUserId: winner.userId,
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

  return noHit;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BBJ NEAR-MISS DETECTION (2026-08-18)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A jackpot that only ever announces itself on a hit is invisible: players
 * never learn the rules and never feel the pull. This reports hands where a
 * player DID hold a qualifying losing hand (aces full of jacks+, quad kings+,
 * etc.) but exactly one other condition blocked the payout.
 *
 * Deliberately conservative: it fires ONLY when a real qualifying loser hand
 * was made and lost. "You had a pair and lost" is not a near miss, and
 * spamming one after every hand would train players to ignore it.
 *
 * This function NEVER moves money and never gates a payout — detectBBJHit
 * remains the single authority on whether the jackpot fires. It is display
 * only, so a bug here can cost a cosmetic banner and nothing else.
 */
export type BBJNearMissReason =
  | 'winner_not_quads'
  | 'both_cards_must_play'
  | 'pot_too_small'
  | 'not_enough_players';

export interface BBJNearMissResult {
  nearMiss: boolean;
  reason?: BBJNearMissReason;
  /** Player-facing one-liner. */
  message?: string;
  /** The player who held the qualifying losing hand. */
  userId?: string;
  handName?: string;
}

export function detectBBJNearMiss(
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
  communityCards?: Array<{ rank: string; suit: string }>
): BBJNearMissResult {
  const none: BBJNearMissResult = { nearMiss: false };

  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant];
  if (!qualifying || qualifying.eligible === false || !qualifying.minLosingHand) return none;

  const winner = showdownResults.find((r) => r.userId === winnerId);
  const losers = showdownResults.filter((r) => r.userId !== winnerId);
  if (!winner || losers.length === 0) return none;

  // Find the strongest loser who met the qualifying HAND bar (ignoring every
  // other condition — that is exactly what we are reporting on).
  let best: (typeof losers)[number] | null = null;
  for (const loser of losers) {
    if (
      !doesHandQualify(
        loser.handRanking,
        loser.kickers,
        loser.holeCards || [],
        qualifying,
        normalizedVariant
      )
    ) {
      continue;
    }
    if (
      best === null ||
      loser.handRanking > best.handRanking ||
      (loser.handRanking === best.handRanking && compareKickers(loser.kickers, best.kickers) > 0)
    ) {
      best = loser;
    }
  }
  if (!best) return none;

  const base = { nearMiss: true as const, userId: best.userId, handName: best.handName };

  // Report the FIRST unmet condition, in the order a player would ask about.
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) {
    return {
      ...base,
      reason: 'not_enough_players',
      message: `So close! ${best.handName} would have qualified, but the jackpot needs ${BBJ_RULES.minPlayersDealt}+ players dealt in.`,
    };
  }

  if (potSize < bigBlind * BBJ_RULES.minPotBB) {
    return {
      ...base,
      reason: 'pot_too_small',
      message: `So close! ${best.handName} would have qualified, but the pot needs to reach ${BBJ_RULES.minPotBB} big blinds.`,
    };
  }

  if (winner.handRanking < HAND_RANK.FOUR_OF_A_KIND) {
    return {
      ...base,
      reason: 'winner_not_quads',
      message: `So close! ${best.handName} lost - but the jackpot needs the winning hand to be Quads or better.`,
    };
  }

  // Both-cards-play (hold'em family only; Omaha is game-enforced).
  const needBothCards =
    BBJ_RULES.requireBothHoleCards &&
    (normalizedVariant === 'nlh' ||
      normalizedVariant === 'flh' ||
      normalizedVariant === 'pineapple');
  if (needBothCards && communityCards && communityCards.length >= 5) {
    // needBothCards is true only for nlh/flh/pineapple, so short-deck
    // evaluation never applies on this branch.
    const loserOk =
      (best.holeCards || []).length >= 2 &&
      bothHoleCardsPlay(best.holeCards || [], communityCards, false);
    const winnerOk =
      (winner.holeCards || []).length >= 2 &&
      bothHoleCardsPlay(winner.holeCards || [], communityCards, false);
    if (!loserOk || !winnerOk) {
      return {
        ...base,
        reason: 'both_cards_must_play',
        message: `So close! ${best.handName} lost to Quads - but the jackpot needs BOTH hole cards to play.`,
      };
    }
  }

  // Every condition met — this was a real hit, not a near miss.
  return none;
}

/** Lexicographic kicker comparison (higher wins). */
function compareKickers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * BBJ AUDIT FIX 2026-08-18: do BOTH hole cards play in the best five?
 *
 * The evaluator returns the best-5 cards; "plays" means the best five that
 * includes both hole cards is STRICTLY better than any five buildable
 * without one of them - i.e. dropping either hole card weakens the hand.
 * (If board + one hole card ties the full evaluation, the other card is
 * replaceable and does not "play" - the strict reading, which is the
 * standard casino BBJ interpretation.)
 */
function bothHoleCardsPlay(
  hole: Array<{ rank: string; suit: string }>,
  board: Array<{ rank: string; suit: string }>,
  shortDeck: boolean
): boolean {
  const toCard = (c: { rank: string; suit: string }) => ({ rank: c.rank, suit: c.suit });
  const full = evaluateHand(hole.map(toCard) as never, board.map(toCard) as never, shortDeck);
  for (let drop = 0; drop < 2; drop++) {
    const kept = hole[1 - drop];
    // Best five from board + the OTHER hole card only (6 cards).
    const partial = evaluateHand([toCard(kept)] as never, board.map(toCard) as never, shortDeck);
    if (compareHands(partial, full) >= 0) return false; // dropped card not needed
  }
  return true;
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
