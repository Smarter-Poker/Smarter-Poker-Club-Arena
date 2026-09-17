/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVER-SIDE RAKE & BBJ CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Ported from client `src/config/RakeConfig.ts` — the AUTHORITATIVE rake schedule.
 *
 * 2026-09-02 (Chip Accounting Standard, R7): every NUMBER in this file now
 * comes from `rakeSpec.ts`, the one rake specification the engine and the
 * database both read. The schedule, the tiers, the player-count cap factors,
 * the heads-up percent, the BBJ collection gates and the override ceilings
 * are re-exported from RAKE_SPEC so a change lands in exactly one place and
 * the boot checksum (`fn_rake_spec_checksum()`) can see it. This file keeps
 * the LOOKUP and BBJ-DETECTION logic; the data lives next door.
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
import {
  RAKE_SPEC,
  capsByPlayersDealt,
  scheduleMatch,
  tierForBB,
  tierIdForBB,
  unscheduledCapFor as specUnscheduledCapFor,
} from './rakeSpec.js';
import type { RakeScheduleEntry, StakesTier } from './rakeSpec.js';

export type { RakeScheduleEntry, StakesTier } from './rakeSpec.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BBJQualifyingHand {
  label: string;
  minLosingHand: string | null;
  description: string;
  rules: string[];
  handRank?: string;
  minRankValue?: string;
  eligible?: boolean;
  /* THE MINI'S OWN BAR FOR THIS VARIANT (Dan, 2026-09-12).

     The mini used to derive its bar from the MAIN rule's family: `full_house`
     meant hold'em, so aces-full-or-better; anything else meant Omaha, so ANY
     quads. That is a two-value guess standing in for a per-game decision, and
     Dan made the decision: PLO5/FLO5 is Quad Tens or better, Pineapple is Quad
     Deuces. Where `miniMinQuadRank` is set it is the lowest QUAD rank that
     clears the mini bar (A=14 ... 2=2) and it replaces the family default;
     where it is absent the family default still applies, so every other game
     is untouched. `miniBarLabel` is what a player is told, and it lives beside
     the number so the two cannot drift. */
  miniMinQuadRank?: number;
  miniBarLabel?: string;
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
// OFFICIAL RAKE SCHEDULE — lives in rakeSpec.ts (with its history and Dan's
// rulings). Re-exported here so every existing import keeps working.
// rakeCap is an ABSOLUTE DOLLAR AMOUNT (not BB-based).
// ═══════════════════════════════════════════════════════════════════════════════

export const RAKE_SCHEDULE: readonly RakeScheduleEntry[] = RAKE_SPEC.schedule;

// FIX 166: Bible V8 §7.19 / §2.9 — Player-count-based rake caps.
// Standard poker rule: heads-up and short-handed games get lower rake caps.
// Each entry defines a player threshold and its corresponding cap MULTIPLIER.
// The engine finds the highest tier where playerCount >= players, then applies: cap × multiplier.
// Factors (0.5 heads-up, 0.75 three-handed, full at 4+) are RAKE_SPEC.rules;
// the derivation is capsByPlayersDealt so `ca_rake_schedule_caps` and this
// list are one computation.
//
// `seats` is the table's `max_players`. Dan 2026-09-14: the three-handed
// discount is NINE-MAX ONLY - "once any 6-8 handed game reaches 3+ players
// full rake + BBJ is applied" - so a 6/7/8-max table's three-handed rung is
// the full cap. Heads-up is not gated: 50% at every table size. A caller with
// no table in hand (the published ladder, a pricing preview) omits it and
// gets the nine-max ladder, which is what the database publishes.
export function getPlayerCountCaps(
  fullCap: number,
  seats?: number | null
): { players: number; cap: number }[] {
  return capsByPlayersDealt(fullCap, seats);
}

// BBJ POOL ALLOCATION (Dan, 2026-08-18 — authoritative)
//   STANDARD (main pool < 100k):  50% Main / 25% Back Up / 25% Promo
//   PIVOT    (main pool >= 100k): 25% Main / 25% Back Up / 50% Promo
// Past the pivot the jackpot is already large, so new rake is steered into the
// promo wallet rather than growing main further; the Back Up share is held flat
// at 25% because its job is to reseed main after a full hit, not to grow.
// This constant is the STANDARD split.
//
// WHERE THE PIVOT IS ACTUALLY APPLIED (corrected 2026-09-11). This said "at
// banking time in logBBJCollection against the LIVE main balance", which sent
// every reader to a function that does no arithmetic: `logBBJCollection` calls
// the `bbj_record_table_contribution` RPC and the split is decided in SQL, by
// `fn_bbj_allocate` reading `ca_bbj_policy`. THE DATABASE IS THE ALLOCATOR.
// These constants are a mirror of that policy row and nothing reads them at
// banking time; `LAW 6` in tests/the-jackpot-is-one-allocator-with-an-opening-
// balance.law.test.ts is what keeps the mirror honest, and any surface that
// needs the live rule reads `fn_bbj_allocation_policy()`.
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
// STAKES TIERS — Fallback for custom/non-standard stakes (data in rakeSpec.ts)
// ═══════════════════════════════════════════════════════════════════════════════

export const STAKES_TIERS: Readonly<Record<string, StakesTier>> = RAKE_SPEC.tiers;

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ QUALIFYING HANDS — Minimum losing hand per game variant
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJ_QUALIFYING_HANDS: Record<string, BBJQualifyingHand> = {
  nlh: {
    label: 'NLH / FLH',
    minLosingHand: 'AAAJJ',
    description: 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush',
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
    description: 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush',
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
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
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
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  plo8: {
    label: 'PLO8 (Hi-Lo 8 Or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',
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
    label: 'FLO8 (Hi-Lo 8 Or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  // FIX 116: plo_hilo dead variant removed — plo8 and flo8 are the hi-lo variants
  /* Mirrors the client half. `normalizeVariantKey` maps every hi-lo display
     name to 'plo8', so this key is reached only when a caller passes the raw
     'plo_hilo'. It exists on both sides because the two constants must be
     identical - a key on one side and not the other is how Pineapple came to
     be misstated for months. */
  plo_hilo: {
    label: 'PLO8 (Hi-Lo 8 Or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',
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
    description: 'Straight Flush (8-High) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'straight_flush',
    minRankValue: '87654',
    /* MINI: Quad Tens or better (Dan, 2026-09-12). Stricter than the Omaha
       family default of any quads - five hole cards make quads common. */
    miniMinQuadRank: 10,
    miniBarLabel: 'Quad Tens Or Better',
  },
  /* FLO4 / FLO5 ARE THE SAME GAMES AS PLO4 / PLO5 (2026-09-12). Both labels
     have always read "PLO4 / FLO4" and "PLO5 / FLO5", but neither key existed,
     and the engine's BBJ detectors look this table up by the RAW variant - only
     the client normalises. So an FLO5 table would have taken the mini's
     "variant not covered" branch and paid NO mini at all, while getRakeConfig's
     `|| BBJ_QUALIFYING_HANDS.nlh` fallback judged its MAIN bar by hold'em
     rules. That is the Pineapple defect exactly: a key on one side and not the
     other. No such table exists in production today (nlh, plo4, plo5, plo6,
     plo8, short_deck, pineapple, flh, flo8 are the live variants), so this
     closes a trap rather than repairing a loss - and `flo8` and `flh` were
     already here for the same reason. */
  flo4: {
    label: 'PLO4 / FLO4',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  flo5: {
    label: 'PLO5 / FLO5',
    minLosingHand: '87654',
    description: 'Straight Flush (8-High) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'straight_flush',
    minRankValue: '87654',
    /* MINI: Quad Tens or better (Dan, 2026-09-12) - the same bar as plo5,
       because it is the same game. */
    miniMinQuadRank: 10,
    miniBarLabel: 'Quad Tens Or Better',
  },
  plo6: {
    label: 'PLO6',
    minLosingHand: null,
    description: 'BBJ Not Available For PLO6',
    rules: [],
    eligible: false,
  },
  short_deck: {
    label: 'Short Deck',
    minLosingHand: null,
    description: 'BBJ Not Available For Short Deck',
    rules: [],
    eligible: false,
  },
  pineapple: {
    label: 'Pineapple',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
    /* MINI: Quad Deuces (Dan, 2026-09-12) - every quad clears it. Same effect
       as the old family default for this game, written down explicitly so the
       bar is a stated rule rather than a fall-through nobody chose. */
    miniMinQuadRank: 2,
    miniBarLabel: 'Quad Deuces Or Better',
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
  minPotBB: RAKE_SPEC.rules.bbjMinPotBB,
  // FIX 145: BBJ requires 3+ players dealt in (not 4) per Dan's rule
  minPlayersDealt: RAKE_SPEC.rules.bbjMinPlayersDealt,
  /**
   * THE MINI'S OWN PLAYERS-DEALT FLOOR (phase 3, 2026-09-11).
   *
   * The mini read `minPlayersDealt` directly, so the two jackpots could never
   * be set apart - and they are different products: the mini fires about four
   * times a day at a flat amount out of a reserve, the main about once a day
   * at a share of a pool.
   *
   * It lives HERE and not in `RAKE_SPEC.rules` deliberately. That spec is a
   * contract with SQL - `rakeSpecChecksum()` is pinned against what the
   * database's own serialiser returns - and the database applies no jackpot
   * detection rule. The mini's floor is engine-only, exactly like
   * `excludeDoubleBoard` and `requireBothHoleCards` beside it.
   *
   * Ships EQUAL to the main's, so nothing changes until somebody sets it. What
   * it SHOULD be is Dan's (CLAUDE.md 10.9 - it decides who is owed a jackpot
   * in future hands); this is only the knob.
   */
  miniMinPlayersDealt: RAKE_SPEC.rules.bbjMinPlayersDealt,
  excludeDoubleBoard: true,
  onlyFirstRunout: true,
  /**
   * FALSE, AND IT ALWAYS WAS (2026-09-11).
   *
   * This flag read `true` and the rules page printed, to every player, "If
   * More Than One Player Loses With A Qualifying Hand, The Prize Is Divided
   * Between Them." The engine has never done that. `detectBBJHit` below
   * evaluates every loser and pays the STRONGEST qualifying hand - its own
   * comment called the split "a documented aspiration" while the surface
   * above it stated the aspiration as the rule.
   *
   * A flag nothing enforces is the same defect `excludeDoubleBoard` and
   * `onlyFirstRunout` were pinned for beside it; this was the third one in
   * the object and it was the only one a player could read.
   *
   * It is set to what the engine does rather than the engine being changed
   * to match it, and that is a decision, not a shortcut. Dividing a bad-beat
   * share needs the atomic payout RPC to accept two bad-beat holders - a
   * money path with no observed case to build against - and "the strongest
   * losing hand takes it" is not a worse deal, it is the rule that favours
   * the worse beat, which is the entire point of a bad beat jackpot. The
   * copy now states it.
   *
   * Pinned by tests/one-qualifying-rule-for-one-jackpot.law.test.ts.
   */
  splitIfMultipleQualify: false,
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
  return scheduleMatch(smallBlind, bigBlind);
}

/**
 * Get tier config for a given Big-Blind size (fallback for non-exact matches).
 */
/** The tier KEY for a stake - what `bbj_mini_tiers` is filed under. */
export function getTierIdForBB(bigBlind: number): string {
  return tierIdForBB(bigBlind);
}

export function getTierForBB(bigBlind: number): StakesTier {
  // Tier boundaries based on Dan's BBJ payout screenshot + rake PDF:
  // Nano:  0.10 - 0.20   (fee 0.6bb,  payout 15%)
  // Micro: 0.40 - 0.80   (fee 0.6bb,  payout 25%)
  // Small: 1.00 - 3.00   (fee 0.25bb, payout 40%)
  // Mid:   4.00 - 8.00   (fee 0.12bb, payout 55%)
  // High:  10.0 - 40.0   (fee 0.06bb, payout 70%)
  // Nose:  50+            (fee 0.03bb, payout 85%)
  return tierForBB(bigBlind);
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
export const MAX_RAKE_PERCENT = RAKE_SPEC.rules.maxRakePercent;
/** …nor set a cap above 10 big blinds. Matches the create-table slider. */
export const MAX_RAKE_CAP_BB = RAKE_SPEC.rules.maxRakeCapBB;

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
export const UNSCHEDULED_CAP_BB = RAKE_SPEC.unscheduledCapBB;

/** The cap for a stake with no published row: the tier's, held to the ladder. */
export function unscheduledCapFor(bigBlind: number, tierCap: number): number {
  return specUnscheduledCapFor(bigBlind, tierCap);
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
  // (calculateRake's Math.min, getPlayerCountCaps' 0.5x heads-up and 0.75x
  // nine-max three-handed multipliers) assumes an absolute cash cap.
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
  // qualifying hand (was: first in seat order). A split payout would need the
  // atomic payout RPC to accept two bad-beat holders, the odds of two
  // independent qualifying losers in one hand are astronomical, and the
  // strongest-hand rule is deterministic and favors the worse beat.
  //
  // UNTIL 2026-09-11 this comment called the split "a documented aspiration"
  // while BBJ_RULES.splitIfMultipleQualify read `true` and the rules page
  // printed the aspiration to players as the rule. The flag is `false` now
  // and the surface states what this loop does. An aspiration belongs in a
  // comment; it must never sit in a flag a player-facing surface reads.
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

// ═══════════════════════════════════════════════════════════════════════════════
// MINI BBJ DETECTION (BBJ build plan phase 6 of 6, Dan 2026-09-07)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The SECOND tier of the jackpot: a flat amount out of the backup reserve for a
 * hand that came close to the main bar and did not meet it.
 *
 * DAN'S DESIGN, signed off 2026-09-07 with the measurement in front of him:
 *
 *   hold'em family   ACES FULL OR BETTER must lose
 *   PLO family       QUADS OR BETTER must lose
 *
 * and that asymmetry is the point rather than an accident. Measured over seven
 * days of live cash play, the hands that qualify at those two bars arrive at
 * 3.4 a day in hold'em and 0.6 a day in PLO - one rule applied to both games
 * would have been either a lottery in one or a shrug in the other.
 *
 * WHAT THE MINI DROPS, and it is exactly the near-miss set. The main hold'em
 * rule is aces full of JACKS or better, PLUS an Ace in the hole cards, PLUS
 * both hole cards playing. The mini keeps the strength floor and drops the
 * other two, so the hands it catches are the ones a player would swear was a
 * bad beat and the main rule refused on a technicality. The main PLO rule is
 * quad KINGS or better; the mini takes any quads, which is every quad below
 * the main's floor.
 *
 * WHAT IT DOES NOT DROP:
 *
 *   - the winner must still hold QUADS OR BETTER. Aces full losing to a bigger
 *     boat is a cooler, not a bad beat, and paying it was the 2026-08-18
 *     finding that had cost $99,066 across 25 hits. Measured against seven days
 *     of real showdowns this gate excludes nothing at these bars anyway -
 *     anything that beats aces full already is quads or better - so it costs no
 *     legitimate mini and closes the door on the shape that went wrong before.
 *   - the pot floor, the 3-players-dealt floor and the double-board exclusion,
 *     all read from BBJ_RULES so they can never drift apart from the main's.
 *   - variant eligibility. PLO6 and Short Deck are not eligible for the
 *     jackpot, so they are not eligible for the mini either.
 *
 * THIS FUNCTION CANNOT OVERRULE THE MAIN JACKPOT. Settlement calls it only
 * when detectBBJHit returned no hit, and the payout RPC shares the main's
 * idempotency key (pool, table, hand), so one hand can produce one payout of
 * either kind and never both. Both halves of that are pinned by
 * `theMiniNeverOverrulesTheMain.law.test.ts`.
 */
export interface BBJMiniDetectionResult extends BBJDetectionResult {
  /**
   * Which of Dan's two rules was applied, for the celebration and the log -
   * or `drill`, when the verdict was injected by an armed mini drill rather
   * than ruled by `detectMiniBBJHit`.
   *
   * `drill` IS IN THE UNION DELIBERATELY. Settlement writes it, and it was
   * typechecking only because `currentHandMiniBBJHit` is declared as the base
   * `BBJDetectionResult` - which has no `miniRule` at all - so the field was
   * erased on assignment and read back through a cast. It worked and no
   * compiler could have caught a typo in it. Naming it here is what makes
   * `miniRule` a closed set again: every value settlement can write is a value
   * this type admits, and the near-miss message and the payout metadata that
   * interpolate it can be read against a list rather than against a hope.
   */
  miniRule?: 'holdem_aces_full' | 'plo_quads' | 'ranked_quads' | 'drill';
}

/**
 * Quads of a given rank or better (Dan, 2026-09-12).
 *
 * `kickers[0]` on a four-of-a-kind is the QUAD rank, A=14 down to 2 - the same
 * encoding `doesHandQualify` reads for the main rule's `minRankValue: 'KKKK'`,
 * so the mini and the main are judging the same number and not two guesses at
 * it. Anything ABOVE quads (straight flush, royal) clears every quad bar.
 */
function isQuadsOfRankOrBetter(
  handRanking: number,
  kickers: number[],
  minQuadRank: number
): boolean {
  if (handRanking > HAND_RANK.FOUR_OF_A_KIND) return true;
  if (handRanking < HAND_RANK.FOUR_OF_A_KIND) return false;
  return kickers.length >= 1 && kickers[0] >= minQuadRank;
}

/** Aces full or better: a full house whose trips are Aces, or anything above. */
function isAcesFullOrBetter(handRanking: number, kickers: number[]): boolean {
  if (handRanking > HAND_RANK.FULL_HOUSE) return true;
  if (handRanking < HAND_RANK.FULL_HOUSE) return false;
  // Full house kickers are [tripRank, pairRank]; A = 14.
  return kickers.length >= 1 && kickers[0] >= RANK_VALUES.A;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE MINI'S OWN NEAR MISSES (BBJ phase 3, 2026-09-11)

   `detectBBJNearMiss` only ever judged the MAIN rule, and only for a loser who
   had already cleared the MAIN hand bar. So the mini - which exists precisely
   to catch the beats the main turns away - had NO near-miss record at all.
   Measured on production that day: 50 near misses in seven days, ZERO of them
   about the mini, and 13 of the 50 were `both_cards_must_play`, a rule the
   mini DROPS. Nobody could say how often the mini nearly fired, or why it did
   not, which makes its rate unmeasurable and its tuning guesswork.

   This mirrors `detectMiniBBJHit` gate for gate and reports the FIRST unmet
   condition, in the order a player would ask about. Every reason is prefixed
   `mini_` so one table can carry both jackpots without a schema change and a
   query can always tell them apart - the same shape settlement already uses
   for `mini_refused:<reason>`.
   ═══════════════════════════════════════════════════════════════════════════ */

export type BBJMiniNearMissReason =
  | 'mini_not_enough_players'
  | 'mini_pot_too_small'
  | 'mini_double_board'
  | 'mini_winner_not_quads';

export interface BBJMiniNearMissResult {
  nearMiss: boolean;
  reason?: BBJMiniNearMissReason;
  message?: string;
  userId?: string;
  handName?: string;
}

export function detectMiniBBJNearMiss(
  showdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards?: Array<{ rank: string; suit: string }>;
  }>,
  winnerId: string | string[],
  variant: string,
  potSize: number,
  bigBlind: number,
  numPlayersDealt: number,
  context?: { doubleBoard?: boolean }
): BBJMiniNearMissResult {
  const none: BBJMiniNearMissResult = { nearMiss: false };

  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant];
  // A variant with no jackpot at all has nothing to nearly miss.
  if (!qualifying || qualifying.eligible === false || !qualifying.handRank) return none;

  const winnerIds = Array.isArray(winnerId) ? winnerId.filter(Boolean) : [winnerId];
  const winnerIdSet = new Set(winnerIds);
  const losers = showdownResults.filter((r) => !winnerIdSet.has(r.userId));
  const winner = showdownResults
    .filter((r) => winnerIdSet.has(r.userId))
    .reduce<(typeof showdownResults)[number] | undefined>((best, r) => {
      if (!best) return r;
      if (r.handRanking > best.handRanking) return r;
      if (r.handRanking === best.handRanking && compareKickers(r.kickers, best.kickers) > 0)
        return r;
      return best;
    }, undefined);
  if (!winner || losers.length === 0) return none;

  const isHoldemFamily = qualifying.handRank === 'full_house';
  /* THE SAME BAR detectMiniBBJHit APPLIES, including the per-variant ranked
     quad (Dan, 2026-09-12). If these two drift, a hand the payout refused is
     reported as refused for a rule the payout never used - which is worse than
     no near miss at all, because it reads as an explanation. */
  const rankedQuadBar = qualifying.miniMinQuadRank;
  const meetsMiniBar = (r: (typeof showdownResults)[number]): boolean =>
    rankedQuadBar != null
      ? isQuadsOfRankOrBetter(r.handRanking, r.kickers, rankedQuadBar)
      : isHoldemFamily
        ? isAcesFullOrBetter(r.handRanking, r.kickers)
        : r.handRanking >= HAND_RANK.FOUR_OF_A_KIND;

  // The strongest loser who cleared the MINI's hand bar - the same choice
  // detectMiniBBJHit makes, so the two name the same player.
  let best: (typeof losers)[number] | null = null;
  for (const loser of losers) {
    if (!meetsMiniBar(loser)) continue;
    if (
      best === null ||
      loser.handRanking > best.handRanking ||
      (loser.handRanking === best.handRanking && compareKickers(loser.kickers, best.kickers) > 0)
    ) {
      best = loser;
    }
  }

  const bar =
    qualifying.miniBarLabel ?? (isHoldemFamily ? 'Aces Full or better' : 'Quads or better');
  if (!best) {
    /* Nobody cleared the bar. That is not a near miss - it is an ordinary hand,
       and recording it would bury the real ones.
       This used to return `reason: 'mini_loser_below_bar'` "so the caller can
       distinguish no-candidate from not-evaluated", and no caller ever did:
       the one call site tests `nearMiss` alone and cannot tell it from the
       four other reason-less refusals. A value with no reader is the thing
       10.86 is about, so it is gone rather than left looking meaningful. */
    return none;
  }

  const base = { nearMiss: true as const, userId: best.userId, handName: best.handName };

  if (numPlayersDealt < BBJ_RULES.miniMinPlayersDealt) {
    return {
      ...base,
      reason: 'mini_not_enough_players',
      message: `So close! ${best.handName} would have taken the Mini, but it needs ${BBJ_RULES.miniMinPlayersDealt}+ players dealt in.`,
    };
  }

  if (potSize < bigBlind * BBJ_RULES.minPotBB) {
    return {
      ...base,
      reason: 'mini_pot_too_small',
      message: `So close! ${best.handName} would have taken the Mini, but the pot needs to reach ${BBJ_RULES.minPotBB} big blinds.`,
    };
  }

  if (BBJ_RULES.excludeDoubleBoard && context?.doubleBoard === true) {
    return {
      ...base,
      reason: 'mini_double_board',
      message: `So close! ${best.handName} would have taken the Mini, but double-board hands do not qualify.`,
    };
  }

  if (winner.handRanking < HAND_RANK.FOUR_OF_A_KIND) {
    return {
      ...base,
      reason: 'mini_winner_not_quads',
      message: `So close! ${best.handName} lost with ${bar} - but the Mini needs the WINNING hand to be Quads or better.`,
    };
  }

  // Every gate cleared: this was a hit, not a near miss.
  return none;
}

export function detectMiniBBJHit(
  showdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards?: Array<{ rank: string; suit: string }>;
  }>,
  winnerId: string | string[],
  variant: string,
  potSize: number,
  bigBlind: number,
  numPlayersDealt: number,
  dealtInPlayerIds: string[],
  context?: { doubleBoard?: boolean }
): BBJMiniDetectionResult {
  const noHit: BBJMiniDetectionResult = { hit: false };

  // The mini lives under the main and inherits its floors, with ONE exception
  // since phase 3: players-dealt is its own knob (BBJ_RULES.miniMinPlayersDealt,
  // shipped equal to the main's), because the mini is a different product and
  // has to be tunable without moving the main jackpot's bar.
  if (numPlayersDealt < BBJ_RULES.miniMinPlayersDealt) return noHit;
  if (potSize < bigBlind * BBJ_RULES.minPotBB) return noHit;
  if (BBJ_RULES.excludeDoubleBoard && context?.doubleBoard === true) return noHit;

  const normalizedVariant = variant.toLowerCase();
  const qualifying = BBJ_QUALIFYING_HANDS[normalizedVariant];
  // A variant the jackpot does not cover at all does not get a mini either.
  if (!qualifying || qualifying.eligible === false || !qualifying.handRank) return noHit;

  const winnerIds = Array.isArray(winnerId) ? winnerId.filter(Boolean) : [winnerId];
  const winnerIdSet = new Set(winnerIds);
  const losers = showdownResults.filter((r) => !winnerIdSet.has(r.userId));
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

  // A bad beat means beaten by something huge, in both tiers.
  if (winner.handRanking < HAND_RANK.FOUR_OF_A_KIND) return noHit;

  const isHoldemFamily = qualifying.handRank === 'full_house';
  /* A RANKED QUAD BAR BEATS THE FAMILY DEFAULT (Dan, 2026-09-12). PLO5/FLO5 is
     Quad Tens or better and Pineapple is Quad Deuces; every other game keeps
     the family rule it had. The bar lives on the variant, not in a branch
     here, so adding a third game is a config line rather than another `if`. */
  const rankedQuadBar = qualifying.miniMinQuadRank;
  const rule: BBJMiniDetectionResult['miniRule'] =
    rankedQuadBar != null ? 'ranked_quads' : isHoldemFamily ? 'holdem_aces_full' : 'plo_quads';
  const meetsMiniBar = (r: (typeof showdownResults)[number]): boolean =>
    rankedQuadBar != null
      ? isQuadsOfRankOrBetter(r.handRanking, r.kickers, rankedQuadBar)
      : isHoldemFamily
        ? isAcesFullOrBetter(r.handRanking, r.kickers)
        : r.handRanking >= HAND_RANK.FOUR_OF_A_KIND;

  // The strongest qualifying loser, exactly as the main chooses one: the worse
  // beat wins, deterministically, rather than whoever sat first.
  let best: (typeof losers)[number] | null = null;
  for (const loser of losers) {
    if (!meetsMiniBar(loser)) continue;
    if (
      best === null ||
      loser.handRanking > best.handRanking ||
      (loser.handRanking === best.handRanking && compareKickers(loser.kickers, best.kickers) > 0)
    ) {
      best = loser;
    }
  }
  if (!best) return noHit;

  return {
    hit: true,
    loserUserId: best.userId,
    loserHand: { ranking: best.handRanking, name: best.handName, kickers: best.kickers },
    winnerUserId: winner.userId,
    winnerHand: { ranking: winner.handRanking, name: winner.handName, kickers: winner.kickers },
    dealtInPlayerIds,
    variant: normalizedVariant,
    qualifyingHandLabel:
      qualifying.miniBarLabel ?? (isHoldemFamily ? 'Aces Full Or Better' : 'Quads Or Better'),
    miniRule: rule,
  };
}
