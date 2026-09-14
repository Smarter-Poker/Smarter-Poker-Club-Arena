import { hasHorseReviewSignals } from './HorseReviewSignals.js';
import { evaluateJointLivePolicy } from './multiway/JointLivePolicy.js';
import { horseVariantRulesFor } from './VariantRules.js';
import { jointPlayersBehind } from './multiway/JointActionModel.js';
import { tournamentSampleEquity } from './HorseTournamentUtility.js';
import {
  evaluateRemainingVariantPolicy,
  type RemainingVariantMode,
} from './remainingVariants/RemainingVariantLivePolicy.js';
import { isRemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';
import {
  evaluateOmahaVariantPolicy,
  type OmahaVariantMode,
} from './omaha/OmahaVariantLivePolicy.js';
import { isOmahaPolicyVariant } from './omaha/OmahaVariantPolicyPack.js';
import {
  evaluatePlo4LivePolicy,
  type Plo4EquityEvidence,
  type Plo4LiveMode,
} from './plo4/Plo4LivePolicy.js';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE AI — Server-Side Horse Decision Engine (V2 — 2026-07-23 full rewrite)
 * ═══════════════════════════════════════════════════════════════════════════════
 * ALL horses are fundamentally WINNING poker players.
 * They have DIFFERENT STYLES, but they all play sound, +EV poker.
 * NEVER refer to them as "bots" — they are HORSES only.
 *
 * V2 upgrades over the original engine:
 *  - Position-aware preflop play (EP/MP/CO/BTN/SB/BB) with a proper tiered
 *    169-combo hand classifier instead of the old Chen-style score.
 *  - Raise-context awareness: open vs limped vs single-raised vs 3-bet+ pots,
 *    limper/caller counts, squeeze spots, correct raise-TO sizing.
 *  - Real postflop equity via fast Monte Carlo simulation (draws are priced
 *    correctly — the old engine folded every flush draw to a single bet).
 *  - Full variant support: nlh, short_deck (stripped deck + flush > full house),
 *    plo4/plo5/plo6 (true Omaha 2+3 evaluation, pot-limit sizing caps),
 *    plo8 (hi-lo scoop awareness), pineapple (3-card hands + smart discard).
 *  - Opponent-count-aware thresholds (multiway pots tighten value/bluff mixes).
 *  - SPR-based commitment logic and short-stack push/fold play.
 *  - Guaranteed-legal outputs: every amount is clamped to the engine's
 *    min-bet / min-raise / pot-limit / stack rules and rounded to whole cents.
 *  - Style resolution hardened: accepts string profiles, jsonb object profiles
 *    ({"style":"tag",...}) or anything else — falls back to a deterministic
 *    per-horse hash so all 574 horses do NOT play the same style.
 *
 * V4 (2026-07-23) STREET IQ upgrades:
 *  - Initiative tracking: the preflop raiser (or prior-street aggressor) runs
 *    a real continuation-bet strategy; callers probe instead of auto-checking.
 *  - Postflop position: closing the action changes bluff frequency, call
 *    margins, and check-raise mixes.
 *  - Made-hand classification alongside MC equity: vulnerable made hands bet
 *    for protection and never slowplay; pure draws semi-bluff; monsters size
 *    geometrically to get stacks in by the river.
 *  - Scare-card awareness: fresh flush/straight/pair completions slow value
 *    down, tighten calls without blockers, and upgrade blocker bluffs.
 *
 * V5 (2026-07-24) DYNAMIC HAND READING upgrades:
 *  - Street-by-street range narrowing: every postflop street an opponent bets
 *    or raises tightens their sampled range — a turn barrel is priced as a
 *    barrel, not as the preflop range.
 *  - Missed-c-bet probes: when a street checks through, the capped field gets
 *    attacked with turn probes and delayed c-bets.
 *  - River polarization: medium made hands stop thin bet-folding into
 *    non-stations and take check-back/bluff-catch lines instead.
 *
 * ZERO browser dependencies. Runs on Node.js. Decisions are synchronous and
 * budgeted to stay under ~15ms even for 6-card PLO.
 */

import type {
  Card,
  SeatPlayer,
  HandStage,
  HorseStyle,
  HorseDecision,
  HorseGameState,
  ActionRecord,
  ActionType,
  Pot,
  RakeConfig,
  HorseVariantRules,
} from '../types.js';
import {
  RANK_VALUES,
  validateAction,
  calculateBettingState,
  HEADS_UP_RAKE_PERCENT,
} from './PokerEngine.js';
// V3 (2026-07-23): real-time opponent intelligence — live stats, range reading,
// exploit adjustments, board texture, blockers. See HorseMind.ts.
import { bestPineappleDiscard } from './pineappleDiscardChoice.js';
import { HorseMind, SNAP_MS, TANK_MS, readScopeOf } from './HorseMind.js';
// V7 (2026-07-24): position-pair preflop mastery — 3-bet/4-bet bluffs, blind
// vs blind, squeezes, stack depth, reshoves, ICM. See HorsePreflop.ts.
import {
  decidePreflopV7,
  ploRaiseTo,
  PLO_MIN_OPEN_BB,
  type PreflopPosition,
} from './HorsePreflop.js';
import {
  classifyTournamentPreflopBranch,
  tournamentMZone,
  tournamentPositionForSeat,
  tournamentPreflopPolicy,
  type TournamentAnteType,
  type TournamentContextStatus,
  type TournamentMState,
} from './HorseTournamentPreflop.js';
import { potLimitRaiseTo } from './BettingStructure.js';
import { reportError } from '../services/errorReporter.js';
// V16 ICM: real Malmuth-Harville pressure from the live stack distribution.
import { bubbleFactor, premiumFromBubbleFactor } from './IcmModel.js';
// PROOF OF RECEIPT (Dan 2026-08-26): live decisions stamp the layers that
// actually executed. Gated on opts.telemetry — league/benchmark/tests never
// count. See engine/BrainTelemetry.ts.
import { noteDecisionMs, noteFire, telemetryOn } from './BrainTelemetry.js';
// V27 (Dan 2026-08-29): the PioSolver push/fold charts, preloaded in memory
// by GtoChartLoader so the synchronous decision can read them at zero I/O.
// See engine/GtoCharts.ts for scope and why absence falls back to heuristics.
import { gtoOpenJam, gtoBbVsSbJam, handClass as gtoHandClass } from './GtoCharts.js';
// V29 (Dan 2026-08-29): the flop plays from the solver — class-mean mixes
// aggregated offline from the 8.8M-solution warehouse, preloaded by
// GtoPostflopLoader. See engine/GtoPostflop.ts for scope and honesty notes.
import {
  gtoStreetAdvice,
  rollMix,
  snapDepthBucket,
  beyondGtoDepthCeiling,
  GTO_MAX_DEPTH_BB,
} from './GtoPostflop.js';
import {
  gtoStreetAdviceV31,
  type GtoV31ActionFamily,
  type GtoV31GameFamily,
  type GtoV31Objective,
  type GtoV31SourceSeal,
} from './GtoPostflopV31.js';
import {
  classifyGtoDecisionContext,
  gtoV31FlopRootStack,
  gtoV31HasHeadsUpPostflopLine,
  gtoV31Position,
  gtoV31PotType,
  gtoV31UtilityContext,
  type GtoV31FacingKind,
  type GtoV31NodeRole,
  type GtoV31Position,
  type GtoV31PotType,
  type GtoV31SizeBucket,
  type GtoV31UtilityContext,
} from './GtoDecisionContext.js';
import { gtoFacingDefense, realizationFactor } from './GtoFacingDefenseV32.js';
// V7 split: evaluators + Monte Carlo equity + preflop scores live in
// HorseEval.ts (extracted verbatim; zero behavior change).
import {
  setEquityDepth,
  fastRandom,
  equitySampleSizeOfLastCall,
  variantInfo,
  type VariantInfo,
  simulateEquity,
  type HorseEquityOutcomeCollector,
  type HiLoSplit,
  omahaDrawQuality,
  type OmahaDrawInfo,
  omahaNutStatus,
  type OmahaNutStatus,
  omahaMadeClass,
  type OmahaMadeInfo,
  type OppPostflopRead,
  nlhNutStatus,
  type NlhNutStatus,
  preflopEquity,
  holdemPreflopScore,
  omahaPreflopStrength,
  multiwayValueBar,
  shortDeckPreflopStrength,
  pineapplePreflopStrength,
  scoreHoldem,
  scoreOmahaHi,
  scoreOmahaHiPartial,
  scoreOmahaLow,
  straightTop,
  nextCardOutlook,
} from './HorseEval.js';
import { anteOrbitCostBB } from './AnteMath.js';
// V35 (2026-09-02): the games are different games — per-variant preflop width
// and postflop temperament, one row per game. See HorseVariantProfile.ts.
import { variantPostflopProfile, variantPreflopShift } from './HorseVariantProfile.js';
import { handClassRead } from './HorseHandClasses.js';
import { personaFromValue, followsSolver, type HorsePersonaV2 } from './HorsePersona.js';
// V38 (2026-09-03): the EV engine — the arithmetic behind every choice, the
// arbiter for the games with no solver export and for every river fold/call
// the hold'em solver range did not answer. See HorseEvEngine.ts.
import { evaluateSpot, riverCallVerdict, type EvOpponentModel } from './HorseEvEngine.js';
import {
  evaluateTournamentUtilityDetailed,
  type TournamentUtilityInput,
  type TournamentContinuationRunner,
  type TournamentUtilityOpponentEvidence,
  type TournamentUtilityShowdownSample,
} from './HorseTournamentUtility.js';
import { evaluateTournamentPostflop, type Phase8Mode } from './HorseTournamentPostflop.js';
import { liveHorsePhase8Safety } from './HorsePhase8Safety.js';
import { performance } from 'node:perf_hooks';

// BUG 020 FIX (2026-04-15) — round chip amounts to whole cents so horse decisions
// don't pollute hand_history.actions with 15-digit floats. Bible V8 §2.6.
const toCents = (n: number): number => Math.round(n * 100) / 100;
// Directional cent snapping for clamping against legal minimums / maximums:
// floor against a max cap (never exceed it), ceil against a min bound.
const floorCents = (n: number): number => Math.floor(n * 100 + 1e-9) / 100;
const ceilCents = (n: number): number => Math.ceil(n * 100 - 1e-9) / 100;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// ── Dan 2026-08-18: "it should never be a CALL to 3.85 - use whole dollars" ──
//
// Horses size bets off pot fractions and then snapped to CENTS, so a 1/2 game
// produced bets like 3.85 and the next player faced "CALL 3.85". Blinds are
// whole dollars at every real stake on the platform (1/2 through 750/1500), so
// that fractional part was noise from the sizing maths, not a chip value anyone
// chose.
//
// chipStep is the granularity a bet should land on: whole dollars whenever the
// big blind is itself a whole number - which is every live table - and cents
// otherwise, so a hypothetical 0.05/0.10 game is not rounded into nonsense.
// Calls and all-ins are deliberately NOT snapped: a call must match exactly
// what is owed, and a short stack's all-in is whatever it is.
const chipStep = (bigBlind: number | undefined): number =>
  typeof bigBlind === 'number' && bigBlind >= 1 && Number.isInteger(bigBlind) ? 1 : 0.01;

/**
 * Reconcile a sampled certified action with the decision that reached the
 * engine. A call that consumes the remaining stack is still the sampled call;
 * wagers must retain both their family and their size (apart from one legal
 * chip-step of deterministic rounding). This helper is exported so the
 * release gate's exact semantics have direct unit coverage.
 */
export function gtoV31ExecutionMatches(args: {
  sampledFamily: GtoV31ActionFamily;
  sampledAmount: number | null;
  finalAction: HorseDecision['action'];
  finalAmount: number | null;
  bigBlind?: number;
}): boolean {
  const amountPreserved =
    args.sampledAmount !== null &&
    args.finalAmount !== null &&
    Number.isFinite(args.sampledAmount) &&
    Number.isFinite(args.finalAmount) &&
    Math.abs(args.sampledAmount - args.finalAmount) <= chipStep(args.bigBlind) + 0.005;
  if (args.sampledFamily === 'call') {
    return args.finalAction === 'all_in' || (args.finalAction === 'call' && amountPreserved);
  }
  if (args.sampledFamily === 'bet' || args.sampledFamily === 'raise') {
    return args.finalAction === args.sampledFamily && amountPreserved;
  }
  return args.finalAction === args.sampledFamily;
}

/** Largest multiple of `step` that is <= n. */
const snapDown = (n: number, step: number): number =>
  step === 1 ? Math.floor(n + 1e-9) : Math.floor(n * 100 + 1e-9) / 100;

/** Smallest multiple of `step` that is >= n. */
const snapUp = (n: number, step: number): number =>
  step === 1 ? Math.ceil(n - 1e-9) : Math.ceil(n * 100 - 1e-9) / 100;

/**
 * Snap a bet/raise size to the chip step while staying legal.
 *
 * Legality beats tidiness. Round DOWN to the step; if that falls under the
 * legal minimum round UP instead; and if the result would exceed the cap, fall
 * back to the exact minimum rather than emit an illegal amount. A whole-dollar
 * preference must never get a horse's action rejected.
 */
const snapBetSize = (amount: number, min: number, max: number, step: number): number => {
  if (!isFinite(amount)) return min;
  let out = snapDown(amount, step);
  if (out < min) out = snapUp(min, step);
  if (out > max) {
    const capped = snapDown(max, step);
    out = capped >= min ? capped : min;
  }
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE PARAMETERS — All styles are winning; they differ in HOW they win
// ═══════════════════════════════════════════════════════════════════════════════

interface StyleParams {
  /** <1 = looser preflop, >1 = tighter preflop */
  tightness: number;
  /** scales bluff / semi-bluff frequencies */
  bluffFreq: number;
  /** scales 3-bet / raise aggression */
  aggression: number;
  /** probability of trapping with a monster instead of fast-playing */
  slowplayFreq: number;
  /** probability of raising (instead of calling) when facing a bet with a strong hand */
  checkRaiseFreq: number;
  /** scales bet sizes */
  sizingMultiplier: number;
  /** humanlike think-time range in ms */
  thinkRange: [number, number];
  /** V18: stable per-horse sizing-family bias (0..1; 0.5 = neutral). */
  familyBias?: number;
  /** V35: variant call-down adjustment added to `respect` (fixed limit calls
   *  lighter — the pot always lays the price). 0 = none. */
  callRespect?: number;
  /** V48: the authored persona's solver adherence, 0.5..1 (1 = always). */
  gtoAdherence?: number;
}

const STYLE_PARAMS: Record<HorseStyle, StyleParams> = {
  tag: {
    tightness: 1.06,
    bluffFreq: 0.12,
    aggression: 1.1,
    slowplayFreq: 0.1,
    checkRaiseFreq: 0.1,
    sizingMultiplier: 1.0,
    thinkRange: [1400, 4200],
  },
  lag: {
    tightness: 0.9,
    bluffFreq: 0.24,
    aggression: 1.25,
    slowplayFreq: 0.12,
    checkRaiseFreq: 0.16,
    sizingMultiplier: 1.12,
    thinkRange: [1100, 3600],
  },
  balanced: {
    tightness: 1.0,
    bluffFreq: 0.17,
    aggression: 1.0,
    slowplayFreq: 0.18,
    checkRaiseFreq: 0.13,
    sizingMultiplier: 1.0,
    thinkRange: [1500, 4600],
  },
  tricky: {
    tightness: 1.0,
    bluffFreq: 0.2,
    aggression: 0.95,
    slowplayFreq: 0.32,
    checkRaiseFreq: 0.24,
    sizingMultiplier: 0.92,
    thinkRange: [1700, 5200],
  },
  grinder: {
    tightness: 1.12,
    bluffFreq: 0.09,
    aggression: 0.95,
    slowplayFreq: 0.12,
    checkRaiseFreq: 0.09,
    sizingMultiplier: 0.88,
    thinkRange: [1200, 3800],
  },
};

/** Optional per-horse modifiers stored in profiles.horse_profile (jsonb). */
export interface HorseProfileMods {
  aggression?: number;
  tightness?: number;
  bluffFreq?: number;
  sizingMultiplier?: number;
  /** Historical review counts; diagnostic only, never causal policy authority. */
  leaks?: Record<string, number>;
  /** V40: reviewed hands the leak counts were taken over (the denominator). */
  leaksHands?: number;
  /** Historical variant-family counts and reviewed-hand denominators. */
  leaksOmaha?: Record<string, number>;
  leaksHandsOmaha?: number;
  leaksHoldem?: Record<string, number>;
  leaksHandsHoldem?: number;
  /** Historical tournament counts, retained independently of cash reports. */
  leaksTournament?: Record<string, number>;
  leaksHandsTournament?: number;
  /**
   * V48 (2026-09-05): the AUTHORED persona. Resolved through the same read
   * boundary as the dials so there is exactly one place a horse_profile turns
   * into behaviour, and bounded there (HorsePersona.resolvePersona). The
   * self-tuner never writes it - ThePersonaSurvivesTheTuner.law.test.ts.
   */
  persona?: HorsePersonaV2;
}

/** Omaha stack-off review categories. Diagnostic classifications, not policy authority. */
export const PLO_STACKOFF_TAGS = [
  'plo_naked_trips_stackoff',
  'plo_toppair_no_redraw_stackoff',
  'coldcall_stackoff',
  'dominated_straight_stackoff',
  'nonnut_flush_stackoff',
  'second_nut_flush_stackoff',
] as const;

/** Diagnostic rates use their variant family and a 40-reviewed-hand floor. */
export type LeakFamily = 'omaha' | 'holdem' | 'tournament';

export function leakLoad(
  mods: HorseProfileMods | undefined,
  tags: readonly string[],
  family: LeakFamily
): number {
  if (!mods) return 0;
  const scoped =
    family === 'omaha'
      ? mods.leaksOmaha
      : family === 'holdem'
        ? mods.leaksHoldem
        : mods.leaksTournament;
  const scopedHands =
    family === 'omaha'
      ? mods.leaksHandsOmaha
      : family === 'holdem'
        ? mods.leaksHandsHoldem
        : mods.leaksHandsTournament;
  // The tournament family never falls back to the pooled map: the pooled
  // map is mostly cash, and cash verdicts are not event verdicts.
  if (family === 'tournament' && !scoped) return 0;
  const counts = scoped ?? mods.leaks;
  const hands = scoped ? (scopedHands ?? 0) : (mods.leaksHands ?? 0);
  if (!counts || hands < 40) return 0;
  let n = 0;
  for (const t of tags) n += Number(counts[t] ?? 0) || 0;
  return n / hands;
}

export function ploStackoffLoad(mods: HorseProfileMods | undefined): number {
  return leakLoad(mods, PLO_STACKOFF_TAGS, 'omaha');
}

/** Hold em stack-off review categories; outcome labels do not establish action EV. */
export const NLH_STACKOFF_TAGS = [
  'top_pair_weak_kicker_stackoff',
  'weak_kicker_trips_stackoff',
  'straight_into_flush_stackoff',
  'nonnut_straight_stackoff',
  'underfull_stackoff',
  'nonnut_flush_stackoff',
  'coldcall_stackoff',
] as const;

export function nlhStackoffLoad(mods: HorseProfileMods | undefined): number {
  return leakLoad(mods, NLH_STACKOFF_TAGS, 'holdem');
}

/** Historical river escalation reports, partitioned by variant family. */
export const RIVER_WAR_TAGS = ['river_raise_war', 'river_raise_paidoff'] as const;

export function riverWarLoad(mods: HorseProfileMods | undefined, family: LeakFamily): number {
  return leakLoad(mods, RIVER_WAR_TAGS, family);
}

/** Historical limped-pot reports. They cannot authorize a decision adjustment. */
export const LIMP_BLOAT_TAGS = ['limped_pot_bloat'] as const;

export function limpBloatLoad(mods: HorseProfileMods | undefined, family: LeakFamily): number {
  return leakLoad(mods, LIMP_BLOAT_TAGS, family);
}

/** Tournament review categories. Observational losses do not establish a survival premium. */
export const TOURNEY_STACKOFF_TAGS = [
  'preflop_stackoff',
  'coldcall_stackoff',
  'top_pair_weak_kicker_stackoff',
  'weak_kicker_trips_stackoff',
  'nonnut_flush_stackoff',
  'second_nut_flush_stackoff',
  'dominated_straight_stackoff',
  'plo_naked_trips_stackoff',
  'plo_toppair_no_redraw_stackoff',
] as const;

export function tourneyStackoffLoad(mods: HorseProfileMods | undefined): number {
  return leakLoad(mods, TOURNEY_STACKOFF_TAGS, 'tournament');
}

/** Legacy premium proposal for audit comparisons ONLY; never read by live ICM. */
export function tourneyLeakPremium(mods: HorseProfileMods | undefined): number {
  const load = tourneyStackoffLoad(mods);
  return load >= LEAK_LOAD_TAGGED ? Math.min(0.03, load * 0.25) : 0;
}

/** V41: a load at or above this is "the tagger keeps catching this horse". */
export const LEAK_LOAD_TAGGED = 0.08;
/** V41: river war / limp bloat are rarer shapes; their bar is lower. */
export const LEAK_LOAD_TAGGED_LINE = 0.04;

/**
 * Resolve any horse_profile value (string, jsonb object, null, legacy names)
 * into a concrete style + modifiers. Falls back to a DETERMINISTIC hash of the
 * horse's user id so a fleet with empty profiles still gets stable diversity.
 */
export function resolveHorseStyle(
  profile: unknown,
  horseId: string
): { style: HorseStyle; mods: HorseProfileMods } {
  const legacyMap: Record<string, HorseStyle> = {
    tag: 'tag',
    lag: 'lag',
    balanced: 'balanced',
    tricky: 'tricky',
    grinder: 'grinder',
    reg: 'tag',
    fish: 'balanced',
    nit: 'grinder',
    maniac: 'lag',
    whale: 'lag',
    shark: 'tag',
  };

  let styleName: string | undefined;
  let mods: HorseProfileMods = {};

  if (typeof profile === 'string') {
    styleName = profile.toLowerCase();
  } else if (profile && typeof profile === 'object') {
    const obj = profile as Record<string, unknown>;
    const cand = obj.style ?? obj.type ?? obj.personality ?? obj.profile;
    if (typeof cand === 'string') styleName = cand.toLowerCase();
    // V28 AUDIT FIX: clamp at the READ boundary, not only in the self-tuner.
    // The tuner clamps its writes to [0.85, 1.18], but any other writer of
    // horse_profile — a seed script, an admin edit, a manual SQL fix — could
    // put 0 or 5 here, and the live path multiplied straight through:
    // tightness 0 plays every hand, bluffFreq 5 saturates every bluff branch
    // past probability 1. The clamp range is wider than the tuner's so a
    // deliberate manual setting still expresses, but a typo cannot lobotomize.
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && isFinite(v) ? Math.max(0.6, Math.min(1.5, v)) : undefined;
    mods = {
      aggression: num(obj.aggression),
      tightness: num(obj.tightness),
      bluffFreq: num(obj.bluffFreq ?? obj.bluff_freq),
      sizingMultiplier: num(obj.sizingMultiplier ?? obj.sizing_multiplier),
    };
    // V40: the horse's own leak profile, counts only (anything else is
    // dropped at the boundary the same way an absurd dial is).
    if (obj.leaks && typeof obj.leaks === 'object') {
      const leaks: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj.leaks as Record<string, unknown>)) {
        if (typeof v === 'number' && isFinite(v) && v >= 0) leaks[k] = v;
      }
      if (Object.keys(leaks).length > 0) {
        mods.leaks = leaks;
        const lh = obj.leaksHands ?? obj.leaks_hands;
        mods.leaksHands = typeof lh === 'number' && isFinite(lh) && lh > 0 ? lh : undefined;
      }
    }
    // V41: the family-split maps, same boundary rules. A family map is
    // kept only with a positive denominator; counts alone are not a rate.
    const counts = (raw: unknown): Record<string, number> | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const m: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && isFinite(v) && v >= 0) m[k] = v;
      }
      return m;
    };
    const hands = (v: unknown): number | undefined =>
      typeof v === 'number' && isFinite(v) && v > 0 ? v : undefined;
    const omaha = counts(obj.leaksOmaha);
    const omahaHands = hands(obj.leaksHandsOmaha);
    if (omaha && omahaHands !== undefined) {
      mods.leaksOmaha = omaha;
      mods.leaksHandsOmaha = omahaHands;
    }
    const holdem = counts(obj.leaksHoldem);
    const holdemHands = hands(obj.leaksHandsHoldem);
    if (holdem && holdemHands !== undefined) {
      mods.leaksHoldem = holdem;
      mods.leaksHandsHoldem = holdemHands;
    }
    // V48: the persona rides the same boundary as the dials - one place a
    // horse_profile turns into behaviour, bounded per field.
    mods.persona = personaFromValue(obj.persona, horseId);
    const tourney = counts(obj.leaksTournament);
    const tourneyHands = hands(obj.leaksHandsTournament);
    if (tourney && tourneyHands !== undefined) {
      mods.leaksTournament = tourney;
      mods.leaksHandsTournament = tourneyHands;
    }
  }

  let style = styleName ? legacyMap[styleName] : undefined;
  if (!style) {
    // Deterministic per-horse fallback: hash the id onto the 5 styles so the
    // fleet is diverse even when horse_profile is {} for every row.
    let h = 0;
    for (let i = 0; i < horseId.length; i++) {
      h = (h * 31 + horseId.charCodeAt(i)) >>> 0;
    }
    const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
    style = styles[h % styles.length];
  }
  return { style, mods };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION
// ═══════════════════════════════════════════════════════════════════════════════

type PositionClass = 'early' | 'middle' | 'late' | 'sb' | 'bb';

function classifyPosition(
  heroSeat: number,
  dealerSeat: number | undefined,
  players: SeatPlayer[],
  v13: boolean = true,
  allPlayersDealt: boolean = false
): PositionClass {
  // ── V13 (2026-08-23): position comes from who was DEALT IN ───────────────
  // Filtering on `!is_folded` derived position from who is still LIVE, so
  // every fold between the button and the actor compressed the ring and
  // promoted everyone left to a later seat. 6-max, UTG opens, MP and CO fold:
  // inHand becomes [SB,BB,UTG,BTN], n=4, and UTG lands at pos 0 of 2 non-blind
  // seats -> classified 'late'. The horse then 3-bets a UTG open with the top
  // 26% instead of the top 14% (THREEBET_VS late 0.74 vs early 0.86) and
  // cold-calls to the 50th percentile instead of the 58th — against the
  // tightest range at the table. It also made blindVsSteal fire against UTG,
  // and let the 13-20bb reshove jam over an under-the-gun open. A player who
  // has folded still occupied their seat when the button was set.
  const dealtIn = (p: SeatPlayer): boolean =>
    allPlayersDealt ||
    p.seat === heroSeat ||
    (p.totalInvested ?? 0) > 0 ||
    (Array.isArray(p.cards) && p.cards.length > 0) ||
    (!p.is_sitting_out && !p.is_folded);
  const inHand = players
    .filter((p) => (v13 ? dealtIn(p) : !p.is_folded || p.seat === heroSeat))
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  if (dealerSeat === undefined || inHand.length < 2) return 'middle';

  // Order seats clockwise starting after the dealer: SB, BB, UTG, ..., BTN
  const after = (seat: number) => {
    const higher = inHand.filter((s) => s > seat);
    return higher.length > 0 ? higher : inHand;
  };
  const order: number[] = [];
  let cur = dealerSeat;
  for (let i = 0; i < inHand.length; i++) {
    const nxt = after(cur)[0];
    order.push(nxt);
    cur = nxt;
    if (order.length > 1 && nxt === order[0]) break;
  }
  const idx = order.indexOf(heroSeat);
  const n = order.length;
  if (idx === -1) return 'middle';
  /**
   * V29 AUDIT FIX (2026-08-29): HEADS-UP WAS INVERTED. The clockwise walk
   * starts at the seat AFTER the dealer, and `idx === 0 ? 'sb'` assumes ring
   * order — true three-handed and up, backwards heads-up, where the DEALER
   * posts the small blind and the other seat is the BB. So at every
   * two-handed table the real SB was classified 'bb' and vice versa: the
   * blind-vs-blind branch fired for the wrong seat, the V27 push/fold charts
   * were consulted with the positions swapped, and the V29 flop cells missed
   * or answered from the wrong side. The comment on the old line even said
   * "dealer is SB" — the code did the opposite of its own comment.
   */
  if (n === 2) return heroSeat === dealerSeat ? 'sb' : 'bb';
  if (idx === 0) return 'sb';
  if (idx === 1) return 'bb';
  /**
   * V28 AUDIT FIX (2026-08-29): 'middle' was UNREACHABLE at 6-max and below.
   * The old bucketing was early = first ceil(nonBlind/3), late = last two —
   * at 6-max (nonBlind 4) that made early = {0,1} and late = {2,3}, leaving
   * middle the empty set. The hijack was classified 'early', so its opens
   * were 3-bet on the top-14% bar instead of top-20%, the V20/V25 middle
   * reshove layers were dead code at every 6-max table on the platform, and
   * the V27 charts could never select 'MP'. Thirteen unit tests injected
   * 'middle' directly and stayed green while the bucket was unreachable live.
   *
   * New bucketing: last two non-blind seats are late (CO+BTN), the first
   * HALF of what remains is early, the rest middle. 6-max: UTG early, HJ
   * middle, CO+BTN late. 9-max: 3 early, 2 middle, 2 late. 5-max and below
   * have no middle seat in real poker and correctly produce none.
   */
  const nonBlind = n - 2;
  const pos = idx - 2; // 0-based among non-blind seats
  if (pos >= nonBlind - 2) return 'late';
  const earlyCount = Math.max(1, Math.ceil((nonBlind - 2) / 2));
  if (pos < earlyCount) return 'early';
  return 'middle';
}

// ═══════════════════════════════════════════════════════════════════════════════
// V4 STREET IQ (2026-07-23) — initiative, position, made-hand class, scare cards
// ═══════════════════════════════════════════════════════════════════════════════

const STAGE_ORDER: Record<string, number> = {
  preflop: 0,
  pineapple_discard: 1,
  flop: 1,
  turn: 2,
  river: 3,
};

/**
 * Who holds the betting initiative entering this street: the player who made
 * the LAST aggressive action on any earlier street. The preflop raiser owns
 * the flop; a flop check-raiser owns the turn. Drives the c-bet/probe split.
 */
/**
 * True when the advice cell's depth bucket is the PRIMARY snap for this
 * stack — false means the answer came from the neighbouring bucket. The
 * cell key is `street|family|position|depth|texture`; parsing it here keeps
 * the stores' return shape untouched.
 */
/**
 * NAME THE MISS (2026-09-01).
 *
 * On 2026-08-31 the solver layers missed far more than they hit: V32 recorded
 * v32_defend_no_range 9,693 times against 7,202 usable answers (a 57% miss),
 * and V31 answered 165 consults against gto_miss_no_cell 12,193 - a 1.3% hit
 * rate. The counters proved there was a hole and could not say WHERE, so the
 * only available response was to guess at the export or to widen the gate.
 *
 * These two axes make the hole addressable. Cardinality is deliberately tiny
 * - five depth buckets and four streets per layer, not the full
 * street x family x position x depth product, which would be ~432 rows a day
 * and unreadable. Depth and street are the two that were actually suspected,
 * and either can be split further once the coarse answer points somewhere.
 */
function missDepthBand(stackBB: number): string {
  if (!(stackBB > 0) || !isFinite(stackBB)) return 'unknown';
  if (stackBB <= 20) return 'le20';
  if (stackBB <= 50) return 'le50';
  if (stackBB <= 110) return 'le110';
  if (stackBB <= GTO_MAX_DEPTH_BB) return 'le' + GTO_MAX_DEPTH_BB;
  return 'gt' + GTO_MAX_DEPTH_BB;
}

/** Record one miss against both axes. `layer` is 'v31' or 'v32'. */
function noteGtoMiss(layer: string, street: string, stackBB: number): void {
  noteFire(layer + '_miss_depth_' + missDepthBand(stackBB));
  noteFire(layer + '_miss_street_' + street);
}

function cellDepthIsPrimary(cell: string, stackBB: number, certifiedDepth?: number): boolean {
  if (certifiedDepth !== undefined) return certifiedDepth === snapDepthBucket(stackBB);
  const parts = cell.split('|');
  if (parts.length < 5) return true; // unknown shape: do not invent a miss
  // V29/V30 keys place depth at 3. Certified V31 keys place it at 8, after
  // objective, utility context, table size, pot type, and both positions.
  const d = Number(parts[parts.length >= 13 ? 8 : 3]);
  if (!isFinite(d)) return true;
  return d === snapDepthBucket(stackBB);
}

function readInitiative(
  history: ActionRecord[] | undefined,
  heroUserId: string,
  stage: HandStage
): 'hero' | 'opp' | 'none' {
  if (!history || history.length === 0) return 'none';
  const cur = STAGE_ORDER[stage] ?? 1;
  let last: ActionRecord | null = null;
  for (const a of history) {
    if ((STAGE_ORDER[a.stage] ?? 0) >= cur) continue; // earlier streets only
    if (
      a.action === 'bet' ||
      a.action === 'raise' ||
      (a.action === 'all_in' && a.isFullRaise === true)
    ) {
      last = a;
    }
  }
  if (!last) return 'none';
  return last.userId === heroUserId ? 'hero' : 'opp';
}

/**
 * True when hero closes the postflop action (acts last among live players).
 * Postflop order starts left of the dealer; the dealer (or the live seat
 * closest to the dealer clockwise) acts last.
 */
function actsLastPostflop(
  heroSeat: number,
  dealerSeat: number | undefined,
  players: SeatPlayer[],
  v13: boolean = true
): boolean {
  if (dealerSeat === undefined) return false;
  // V13: an all-in player cannot act, so they cannot act after hero. Counting
  // them made a button with one all-in opponent behind believe it was OUT of
  // position: it lost the positional bluff scaling and, worse, became
  // eligible for the V11 initiative gate, which checks 100% of the time
  // without initiative.
  const live = players
    .filter((p) => !p.is_folded && !p.is_sitting_out && (v13 === false || !p.is_all_in))
    .map((p) => p.seat);
  if (live.length < 2 || !live.includes(heroSeat)) return false;
  const WRAP = 1024; // any bound above the max seat number
  const pos = (seat: number) => {
    const d = seat - dealerSeat;
    return d <= 0 ? d + WRAP : d; // dealer itself maps to WRAP = latest
  };
  const heroPos = pos(heroSeat);
  for (const s of live) if (pos(s) > heroPos) return false;
  return true;
}

/**
 * Made-hand category RIGHT NOW (1=high card .. 10=royal), 0 preflop/unknown.
 * Separates a vulnerable made hand (bet for protection, never slowplay wet)
 * from a pure draw (equity comes from the runout) at the same MC equity.
 */
/**
 * V13: best made category over every 2-card subset of the hole cards. For
 * every variant except the pineapple discard street this is just
 * madeCategory, because the hole is already the playable size.
 */
function bestTwoCardCategory(hole: Card[], board: Card[], vi: VariantInfo): number {
  if (!hole || hole.length <= 2 || vi.isOmaha) return madeCategory(hole, board, vi);
  let best = 0;
  for (let i = 0; i < hole.length; i++) {
    for (let j = i + 1; j < hole.length; j++) {
      const c = madeCategory([hole[i], hole[j]], board, vi);
      if (c > best) best = c;
    }
  }
  return best;
}

function madeCategory(hole: Card[], board: Card[], vi: VariantInfo): number {
  if (!hole || hole.length < 2 || !board || board.length < 3) return 0;
  try {
    let score: number;
    if (vi.isOmaha) {
      score = scoreOmahaHiPartial(hole, board);
    } else {
      const all = hole.concat(board);
      score = scoreHoldem(all, all.length, vi.isShortDeck);
    }
    return Math.floor(score / 0x100000);
  } catch {
    return 0;
  }
}

/**
 * V11: the rank of a one-pair hand's pair — a pocket pair, or the board rank
 * hero matched. 0 when unknown. NLH-family only (Omaha callers skip it).
 */
function onePairRank(hole: Card[], board: Card[]): number {
  if (!hole || hole.length < 2) return 0;
  for (let i = 0; i < hole.length; i++)
    for (let j = i + 1; j < hole.length; j++)
      if (hole[i].rank === hole[j].rank) return RANK_VALUES[hole[i].rank];
  let best = 0;
  for (const h of hole)
    for (const b of board)
      if (h.rank === b.rank && RANK_VALUES[h.rank] > best) best = RANK_VALUES[h.rank];
  return best;
}

interface ScareShift {
  /** the just-dealt card completed a 3-flush */
  flush: boolean;
  /** the just-dealt card made the board straight-coordinated */
  straight: boolean;
  /** the just-dealt card paired the board */
  pair: boolean;
  any: boolean;
}

const NO_SCARE: ScareShift = { flush: false, straight: false, pair: false, any: false };

/** Did the latest board card meaningfully change the danger level? */
function scareShift(board: Card[]): ScareShift {
  if (!board || board.length < 4) return NO_SCARE;
  try {
    const prev = HorseMind.texture(board.slice(0, board.length - 1));
    const now = HorseMind.texture(board);
    const flush = now.monotone && !prev.monotone;
    const straight = now.straighty && !prev.straighty;
    const pair = now.paired && !prev.paired;
    return { flush, straight, pair, any: flush || straight || pair };
  } catch {
    return NO_SCARE;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DECISION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/** Extended game state — ServerTableEngine passes the full HandController view. */
export interface HorseGameStateV2 extends HorseGameState {
  /** Phase 5 Round 1 canonical live-decision contract. Offline fixtures may
   * omit it; every live worker request is runtime-validated at version 1. */
  stateSchemaVersion?: 1;
  /** Public deal census captured before stripping private cards. Connectivity
   * and folding never return a dealt hand to the physical deck. */
  dealtSeatIds?: number[];
  /** Settlement units from the active controller, including whole Diamonds. */
  chipUnit?: 0.01 | 1;
  asset?: 'chips' | 'diamonds';
  bbjConfig?: import('../types.js').HandConfig['bbjConfig'] | null;
  heroSeat?: number;
  currentPlayerSeat?: number;
  legalActions?: ActionType[];
  toCall?: number;
  /** Absolute street wager / raise-to bounds from HandController. */
  minRaiseTo?: number | null;
  maxRaiseTo?: number | null;
  bettingStructure?: 'no_limit' | 'pot_limit' | 'fixed_limit';
  fixedBetSize?: number | null;
  wagersCapped?: boolean;
  commitmentCapRemaining?: number | null;
  /** Live side-pot layers with exact eligibility, before settlement. */
  pots?: Pot[];
  /**
   * Chips already in the middle hero can win after taking the effective call,
   * excluding hero's not-yet-committed call. Required on every live request;
   * optional only for legacy/offline fixtures.
   */
  contestablePot?: number;
  /** Exact active per-hand rake schedule, not a strategy approximation. */
  rakeConfig?: RakeConfig;
  variantRules?: HorseVariantRules;
  dealerSeat?: number;
  lastRaise?: number;
  actionHistory?: ActionRecord[];
  /** V7 ICM: explicit tournament context. When absent AND no gameMode is
   *  passed, tournaments are self-detected from the big blind (bb >= 10). The
   *  cash fleet has run 5/10, 10/20 and 25/50 since 2026-09-03, so that
   *  heuristic is a legacy fallback only - ServerTableEngine always passes
   *  gameMode, and isTournamentMode() trusts it first. */
  tournament?: {
    /** Phase 6 context contract. Every live tournament decision carries it. */
    schemaVersion?: 1;
    contextStatus?: TournamentContextStatus;
    contextIssues?: string[];
    sourceAgeMs?: number | null;
    tournamentId?: string | null;
    tournamentType?: string;
    tournamentStatus?: string;
    gameVariant?: string;
    entrants?: number;
    nearBubble?: boolean;
    inMoney?: boolean;
    playersLeft?: number;
    spotsPaid?: number;
    avgStackChips?: number;
    medianStackChips?: number;
    seatsPerTable?: number;
    playersAtTable?: number;
    currentLevel?: number;
    currentSmallBlind?: number;
    currentBigBlind?: number;
    currentAnte?: number;
    anteType?: TournamentAnteType;
    nextSmallBlind?: number | null;
    nextBigBlind?: number | null;
    nextAnte?: number | null;
    levelDurationMin?: number | null;
    levelElapsedMin?: number | null;
    registrationOpen?: boolean;
    lateRegistrationOpen?: boolean;
    registrationRequiresAuthorization?: boolean;
    isPko?: boolean;
    isBounty?: boolean;
    isMysteryBounty?: boolean;
    mysteryBountyStage?: 'none' | 'pending' | 'active' | 'complete';
    reentryAllowed?: boolean;
    reentryOpen?: boolean;
    maxReentries?: number | null;
    rebuyAllowed?: boolean;
    rebuyOpen?: boolean;
    maxRebuys?: number | null;
    addOnAvailable?: boolean;
    addOnPeriodOpen?: boolean;
    addOnCost?: number | null;
    addOnChips?: number | null;
    addOnLevels?: number | null;
    onBreak?: boolean;
    handForHand?: boolean;
    handForHandExpected?: boolean;
    m?: TournamentMState;
    bountyFactor?: number;
    /** V16 ICM: live stacks (chips, desc) + payout percentages by place. */
    stacks?: number[];
    /** Cached field stacks keyed by the local table identities they belong to. */
    stackByUser?: Record<string, number>;
    payoutPct?: number[];
    /** V26 PRIZE LANDSCAPE: the mystery-bounty inventory as it stands. */
    mysteryChestsLeft?: number;
    mysteryMeanCents?: number;
    mysteryTopCents?: number;
    mysteryTopLive?: boolean;
    /** V26: mean live PKO bounty per remaining player, in cents. */
    meanBountyCents?: number;
    /** Phase 7: funded pools and recovery terms in one explicit unit. */
    prizePoolCents?: number;
    bountyPoolCents?: number;
    buyInCents?: number | null;
    startingStackChips?: number | null;
    rebuyCostCents?: number | null;
    rebuyChips?: number | null;
    rebuyPrizeContributionCents?: number | null;
    rebuyBountyContributionCents?: number | null;
    reloadsUsed?: number | null;
    addOnTaken?: boolean | null;
    rebuyAffordable?: boolean | null;
    addOnAffordable?: boolean | null;
    /** V23 ENDGAME: at the final table (MTT, <= 10 left). */
    finalTable?: boolean;
    /** V23 BLIND CLOCK: minutes to the next level (null/undefined = unknown). */
    nextBlindInMin?: number | null;
    /** V23 BLIND CLOCK: next level's bb over the current bb (1 = flat). */
    nextBlindMult?: number;
    /** V37: this event pays identical tickets to the top `satelliteSeats`. */
    satellite?: boolean;
    satelliteSeats?: number;
    /** V37: live bounty per user id (cents) — the head, not the mean. */
    bountyByUser?: Record<string, number>;
  };
  /** V12: table format. HU SNGs play heads-up ranges, MTTs get the full
   *  survival model, and a Spin is decided by `spotsPaid` rather than by the
   *  word "spin": MOST spins are winner-take-all chip-EV (no ICM), but 10x
   *  and above pay 80/20 or 80/12/8 and therefore have a real ladder. See
   *  icmRisk. */
  format?: 'cash' | 'mtt' | 'sng' | 'spin' | 'hu_sng';
  /** V11 (Dan 2026-08-22): EXPLICIT game mode from the table engine
   *  (tournament_id / game_type). Cash and tournaments are different games;
   *  when this is present it is trusted over every heuristic. */
  gameMode?: 'cash' | 'tournament';
  /** V11: table ante (0/undefined = no ante). Antes widen preflop ranges. */
  ante?: number;
  /**
   * THE VPIP FLOOR (Dan 2026-09-04). The table's maintain_percent_min when
   * it runs the rule, else 0. A seat under it after ten hands is stood up,
   * horses included (10.5), so the brain plays to it - see vpipFloorMul.
   */
  vpipFloor?: number;
  /**
   * This horse's OWN judged figure at this table, this sitting - the same
   * query the eviction reads (fn_nit_status). `vpip` is null until the
   * first hand is on file. Absent when the engine could not read it.
   */
  ownVpip?: { hands: number; vpip: number | null };
  /** ALL-IN-OR-FOLD table: preflop is fold or shove and nothing else. */
  allInOrFold?: boolean;
  /** The ante is a BIG BLIND ANTE: the big blind posts it once for the whole
   *  table, rather than every player posting it every hand. Changes what an
   *  orbit COSTS, which is what Harrington M divides by — see AnteMath.ts. */
  bigBlindAnte?: boolean;
  /** V18: the table allows a UTG straddle (2xBB). Straddle posts are not
   *  ActionRecords, so the brain needs this to read a straddled pot as
   *  UNOPENED dead money rather than an open raise. */
  straddleActive?: boolean;
  /** V36 (2026-09-02): this hand is a BOMB POT — every player anted, there
   *  was no preflop street, every range is random, and with boardCount >= 2
   *  every pot layer splits equally across the boards. See the bomb-pot
   *  block in decidePostflop for what that changes. */
  bombPot?: boolean;
  /** V36: boards dealt this hand (1, 2 or 3). */
  boardCount?: number;
}

/**
 * V11: is this a tournament? The EXPLICIT gameMode from the table engine wins
 * (it knows — tournament_id is on the table row). The legacy bb>=10 heuristic
 * survives only for callers that pass no mode, and no longer mislabels
 * high-stakes cash once the engine passes gameMode: 'cash'.
 */
function isTournamentMode(gs: HorseGameStateV2): boolean {
  if (gs.gameMode) return gs.gameMode === 'tournament';
  return gs.tournament != null || (gs.bigBlind ?? 0) >= 10;
}

/**
 * Phase 6 keeps partial tournament snapshots on the decision payload so the
 * engine can emit an honest `TOURNAMENT_CONTEXT_INCOMPLETE` receipt.  Those
 * observable facts are not strategy inputs until the complete-context
 * contract holds, however.  Legacy/offline callers have no schema marker and
 * retain their historical behavior.
 */
function trustedTournamentContext(
  gs: HorseGameStateV2
): NonNullable<HorseGameStateV2['tournament']> | undefined {
  const t = gs.tournament;
  if (t?.schemaVersion === 1 && t.contextStatus !== 'complete') return undefined;
  return t;
}

/**
 * V7 ICM-lite: the survival premium in tournament play. Chips lost hurt more
 * than chips won help, so every calling threshold rises and bluff volume
 * drops — hardest around the bubble, gone again deep in the money with a big
 * stack. Returns an additive threshold premium (0 for cash games).
 */
/** PROOF OF RECEIPT: which path the last icmRisk call took. Module-level is
 *  safe for the same reason difficultyHint is: decisions are synchronous. */
let lastIcmPath: 'real' | 'legacy' | 'spin_cev' | 'warming' | 'none' = 'none';

/**
 * ═══ V23 TOURNAMENT ENDGAME (2026-08-28) ═══ adjustments the MH bubble
 * factor understates. Exported for tests — pure in (risk, context, stack).
 *  - HU of an MTT: the payout difference is fixed and every chip plays for
 *    it proportionally — survival premium collapses to chip EV.
 *  - Final-table ladder: each shorter stack still alive is money hero earns
 *    by folding; a hero who IS the short stack has no ladder to protect and
 *    takes its flips.
 */
export function endgameAdjust(
  risk: number,
  gs: HorseGameStateV2,
  stackBB: number,
  on: boolean
): number {
  const t = trustedTournamentContext(gs);
  if (!on || !t) return risk;
  if ((t.playersLeft ?? 0) === 2) return Math.min(risk, 0.01);
  if (t.finalTable === true && (t.inMoney ?? true)) {
    const stacks = t.stacks;
    const heroChips = stackBB * (gs.bigBlind || 0);
    if (Array.isArray(stacks) && stacks.length >= 2 && heroChips > 0) {
      const shorter = stacks.filter((s) => s < heroChips * 0.75).length;
      if (shorter === 0) {
        // Hero is (near-)shortest: the ladder is not hero's to protect.
        return Math.max(0, risk - 0.02);
      }
      return risk + Math.min(0.045, 0.015 * shorter);
    }
  }
  return risk;
}

/**
 * ═══ V37 SATELLITE READ (Dan 2026-09-02) ═══════════════════════════════════
 * "THE PLAY DIFFERENCE BETWEEN A SATELLITE WHERE ALL WINNERS GET THE SAME
 *  PRIZE AND A MTT WITH PRIZES PROGRESSIVELY PAYING MORE."
 *
 * In an MTT every chip is worth something all the way to first. In a
 * satellite the K-th seat pays exactly what the first does, so the only
 * question a stack ever asks is "will I be here when P - K players have
 * gone?" That splits the table into three players:
 *
 *   LOCKED   Ranked inside the seats with enough chips to post blinds until
 *            the required busts have happened. Every chip risked is a chip
 *            risked for nothing: this stack folds ACES to a covering all-in,
 *            never calls a raise, never plays a big pot postflop. The only
 *            aggression it keeps is the free kind — an open-jam into a table
 *            it covers, because nobody who wants a seat can call it.
 *   URGENT   Below the seat line with the blinds coming: this stack has to
 *            accumulate, so its jam ranges widen and its reshoves widen, and
 *            it targets the mid stacks who cannot call.
 *   NEITHER  Ordinary tournament play with the flat-curve ICM premium from
 *            IcmModel's survival model.
 *
 * Pure read: stacks and counts in, three booleans out. Exported for tests.
 */
export interface SatelliteRead {
  active: boolean;
  locked: boolean;
  urgent: boolean;
  /** hero covers every live opponent at the table by a clear margin */
  coversAll: boolean;
  /** hero's rank in the live field (1 = chip leader), 0 when unknown */
  rank: number;
}

const NO_SATELLITE: SatelliteRead = {
  active: false,
  locked: false,
  urgent: false,
  coversAll: false,
  rank: 0,
};

export function satelliteRead(
  gs: HorseGameStateV2,
  player: SeatPlayer,
  stackBB: number,
  on: boolean = true
): SatelliteRead {
  const t = trustedTournamentContext(gs);
  if (!on || !t || t.satellite !== true) return NO_SATELLITE;
  const seats = t.satelliteSeats ?? t.spotsPaid ?? 0;
  const left = t.playersLeft ?? 0;
  if (seats <= 0 || left <= seats) return NO_SATELLITE;
  /* ═══════════════════════════════════════════════════════════════════════
     A DUEL HAS NOBODY TO OUTLAST (2026-09-03)
     ═══════════════════════════════════════════════════════════════════════
     Every read below is bubble arithmetic: how many busts are still needed,
     how many blinds the stack can pay while they happen, and therefore
     whether a seat can be reached by SURVIVING rather than by winning. That
     is the whole idea of satellite play, and it is meaningless two-handed.

     With `left = 2` and `seats = 1` the arithmetic goes wrong in a way that
     inverts strategy rather than merely blunting it. `bustsNeeded` is 1, so
     `near` is true; `rank` counts stacks STRICTLY greater, so at equal stacks
     BOTH players compute `rank = 1`; `rank <= seats` and a 15bb stack clears
     the blind runway, so BOTH are `locked`; and `coversAll` cannot be true at
     equal stacks. HorsePreflop then folds anything costing 12% of the stack
     and refuses to open. The leader folds aces to a jam, and a human who
     simply jams every hand takes the ticket.

     The only route to a seat heads-up is to win the duel, which is ordinary
     tournament play. The satellite layer switches off, and the ICM premium
     carries the spot as it does in any other heads-up.

     `left <= 2` rather than `=== 2`: a one-player read is not a bubble either.
     The seats-first shape this protects is the satellite heads-up added
     2026-09-03 (2 seats, 1 ticket), but the rule is about the count, not the
     format - a 6-max satellite down to its last two hands is the same spot. */
  if (left <= 2) return NO_SATELLITE;
  const bb = gs.bigBlind > 0 ? gs.bigBlind : 1;
  const heroChips = stackBB * bb;
  const stacks = Array.isArray(t.stacks) ? t.stacks : [];
  // Conservative rank uses the worst place in an equal-stack tie. Counting
  // only strictly larger stacks made four equal stacks all claim rank 1 on a
  // three-seat bubble, so every horse believed its seat was locked.
  let rank = 0;
  if (stacks.length >= 2 && heroChips > 0) {
    let closest = 0;
    for (let i = 1; i < stacks.length; i++) {
      if (Math.abs(stacks[i] - heroChips) < Math.abs(stacks[closest] - heroChips)) closest = i;
    }
    let above = 0;
    let tied = 0;
    for (let i = 0; i < stacks.length; i++) {
      if (stacks[i] > heroChips + 0.005) above++;
      else if (Math.abs(stacks[i] - heroChips) <= 0.005) tied++;
    }
    rank =
      tied > 0
        ? above + tied
        : 1 + stacks.filter((stack, index) => index !== closest && stack > heroChips).length;
  }
  const bustsNeeded = left - seats;
  const orbitBB =
    1.5 +
    Math.max(
      0,
      anteOrbitCostBB(
        gs.ante ?? 0,
        gs.players.filter((p) => !p.is_sitting_out).length,
        bb,
        gs.bigBlindAnte === true
      )
    );
  // Blinds hero can post while the busts happen: two orbits per bust is a
  // conservative read of how fast a satellite bubble clears.
  const blindRunwayBB = orbitBB * (2 * bustsNeeded + 2);
  const bubbleRatio = left / seats;
  const near = bubbleRatio <= 1.6 || bustsNeeded <= 3;
  const locked = near && rank > 0 && rank <= seats && stackBB >= blindRunwayBB;
  // Below the seat line, waiting cannot produce a seat: the stack has to
  // grow, however many blinds it holds.
  // (rank 0 = the stack list has not arrived: neither locked nor urgent, the
  // flat-curve ICM premium alone carries the spot until it does.)
  const urgent = near && rank > seats;
  let coversAll = false;
  if (locked) {
    coversAll = true;
    for (const o of gs.players) {
      if (o.seat === player.seat || o.is_folded || o.is_sitting_out) continue;
      const os = (isFinite(o.stack) ? o.stack : 0) + (isFinite(o.bet) ? o.bet : 0);
      if (os * 1.25 > heroChips) {
        coversAll = false;
        break;
      }
    }
  }
  return { active: true, locked, urgent, coversAll, rank };
}

/**
 * ═══ V37 BOUNTY PRICING, IN ONE PLACE (Dan 2026-09-02) ═══════════════════
 * "DON'T FORGET ABOUT BOUNTY, PKO AND MYSTERY BOUNTIES. THIS PLAYS DIFFERENT
 *  WHEN A PLAYER HAS A LARGE BOUNTY ON THEIR HEAD. OR IF THE TOP PRIZES IN A
 *  MYSTERY BOUNTY ARE AVAILABLE, OR HAVE ALREADY BEEN PULLED."
 *
 * Two multipliers on the pool-ratio bountyFactor, both read live:
 *
 *  prizeLandscapeScale — the V26 inventory read (was inline in the preflop
 *    glue, and NOT applied postflop): the top chest still in the box makes
 *    every bust a lottery ticket (x1.35); a top chest far above the mean is a
 *    fat tail (x1.15); three or fewer chests left is a freezeout wearing a
 *    badge (x0.6); an exhausted inventory is over (x0.35).
 *  headBountyScale — THIS opponent's bounty against the field mean. A head
 *    worth three times the mean is worth three times the pull; a head worth
 *    a third of it is worth a third. Clamped to [0.4, 3]. 1 when the
 *    per-player map is absent (older context), so nothing regresses.
 */
export function prizeLandscapeScale(gs: HorseGameStateV2, on: boolean = true): number {
  const t = trustedTournamentContext(gs);
  if (!on || !t) return 1;
  const meanCents = Math.max(0, t.mysteryMeanCents ?? t.meanBountyCents ?? 0);
  const chestsLeft = Math.max(0, t.mysteryChestsLeft ?? 0);
  let scale = 1;
  if (meanCents > 0) {
    if (t.mysteryTopLive === true) scale *= 1.35;
    if (chestsLeft > 0 && chestsLeft <= 3) scale *= 0.6;
    const top = Math.max(0, t.mysteryTopCents ?? 0);
    if (top > meanCents * 3) scale *= 1.15;
  } else if (chestsLeft === 0 && (t.mysteryTopCents ?? 0) > 0) {
    scale = 0.35;
  }
  return scale;
}

export function headBountyScale(gs: HorseGameStateV2, userId: string | undefined): number {
  const t = trustedTournamentContext(gs);
  if (!t || !userId || !t.bountyByUser) return 1;
  const head = Number(t.bountyByUser[userId]) || 0;
  const mean = Math.max(0, t.meanBountyCents ?? 0);
  if (head <= 0 || mean <= 0) return 1;
  return Math.max(0.4, Math.min(3, head / mean));
}

/**
 * ═══ V37 BUBBLE PRESSURE (exploit, Dan 2026-09-02) ═══════════════════════
 * "EXPLOITATIVE PLAY THAT'S AVAILABLE FOR THEM AT ALL STAGES."
 *
 * The bubble is the one stage where the correct exploit is written into the
 * payout table: every covered stack near the money is folding hands it would
 * play anywhere else, and the stack that covers them is the only one at the
 * table with nothing to lose by attacking. The V12 model already HALVED the
 * captain's own premium; it never told the captain to attack. This is that:
 * 0 outside the window, 1 when hero covers every live opponent by a margin
 * near the bubble, 0.6 when hero covers only the current raiser. Preflop it
 * widens the opens and the 3-bet bluffs against covered players; postflop it
 * lifts bluff volume a notch. Satellites carry their own, stronger version
 * (satelliteRead.coversAll) and are excluded here.
 */
export function bubblePressure(
  gs: HorseGameStateV2,
  player: SeatPlayer,
  raiserSeat: number,
  on: boolean = true
): number {
  const t = trustedTournamentContext(gs);
  if (!on || !t || !isTournamentMode(gs) || gs.format === 'spin') return 0;
  if (t.satellite === true) return 0;
  const pl = t.playersLeft ?? 0;
  const paid = t.spotsPaid ?? 0;
  if (pl <= 0 || paid <= 0) return 0;
  const inMoney = t.inMoney ?? pl <= paid;
  if (inMoney || pl / paid > 1.4) return 0;
  const heroChips = player.stack + (isFinite(player.bet) ? player.bet : 0);
  let coversAll = true;
  let coversRaiser = false;
  for (const o of gs.players) {
    if (o.seat === player.seat || o.is_folded || o.is_sitting_out) continue;
    const os = (isFinite(o.stack) ? o.stack : 0) + (isFinite(o.bet) ? o.bet : 0);
    const covered = os * 1.3 <= heroChips;
    if (!covered) coversAll = false;
    if (o.seat === raiserSeat && covered) coversRaiser = true;
  }
  return coversAll ? 1 : coversRaiser ? 0.6 : 0;
}

function icmRisk(
  gs: HorseGameStateV2,
  stackBB: number,
  useV16Icm: boolean = true,
  useV23End: boolean = true
): number {
  lastIcmPath = 'legacy';
  // icmRisk v2 (V12, 2026-08-22): real bubble model from TournamentBrainContext.
  const explicit = trustedTournamentContext(gs);
  if (!isTournamentMode(gs)) return 0;
  // A SPIN IS NOT AUTOMATICALLY WINNER-TAKE-ALL (corrected 2026-08-31). The
  // ladder pays one place below 10x, but 10x pays 80/20 and 25x/50x/100x pay
  // 80/12/8 (SPIN_TIERS) — about 1.1% of games by frequency, and the biggest
  // prizes on the platform. This branch has always tested `spotsPaid <= 1`
  // rather than the format, so the CODE was right; only the comment claimed
  // otherwise, and every comment that repeated the claim is corrected in the
  // same commit. `spotsPaid` comes from TournamentBrainContext, which resolves
  // the structure from the drawn tier — so a multi-place spin correctly falls
  // through to the ICM model below and gets a genuine survival premium.
  // Pure chip EV, zero survival premium, WHEN ONE PLACE IS PAID:
  // V22 telemetry honesty (2026-08-27): this CORRECT no-ICM answer used to
  // leave lastIcmPath on whatever the previous call set, so 7,000 spins a day
  // were counted as "legacy" fallbacks in the proof-of-receipt numbers. Same
  // for a context that simply has not arrived yet (empty tournament object
  // during the first fetch): that is "warming", not a degraded model.
  if (gs.format === 'spin' && (explicit?.spotsPaid ?? 1) <= 1) {
    lastIcmPath = 'spin_cev';
    return 0;
  }
  if (!explicit || (explicit.playersLeft ?? 0) === 0) lastIcmPath = 'warming';

  // ═══ V16 REAL ICM (2026-08-26) ═══
  // When the context carries the live stack distribution and the payout
  // curve, pressure comes from Malmuth-Harville instead of a flat guess: a
  // bubble factor computed for HERO'S actual stack against the field, with
  // covering awareness built in (the risk is capped by the largest stack
  // that can actually take hero's chips — a table captain's premium shrinks
  // because busting is arithmetically impossible for him). Missing data
  // degrades to the legacy heuristic below, unchanged.
  if (
    useV16Icm &&
    explicit &&
    Array.isArray(explicit.stacks) &&
    explicit.stacks.length >= 2 &&
    Array.isArray(explicit.payoutPct) &&
    explicit.payoutPct.length >= 1 &&
    gs.bigBlind > 0
  ) {
    try {
      const heroChips = stackBB * gs.bigBlind;
      const stacks = explicit.stacks.slice();
      // Substitute hero's LIVE stack for its closest field entry (the
      // context snapshot may lag the current hand by up to its TTL).
      let closest = 0;
      for (let i = 1; i < stacks.length; i++) {
        if (Math.abs(stacks[i] - heroChips) < Math.abs(stacks[closest] - heroChips)) closest = i;
      }
      stacks[closest] = heroChips;
      let maxOther = 0;
      for (let i = 0; i < stacks.length; i++) {
        if (i !== closest && stacks[i] > maxOther) maxOther = stacks[i];
      }
      const riskChips = Math.max(1, Math.min(heroChips, maxOther));
      const bf = bubbleFactor(stacks, explicit.payoutPct, closest, riskChips);
      let premium = premiumFromBubbleFactor(bf);
      // PKO: bounty share still trims pressure — covered all-ins pay.
      if ((explicit.bountyFactor ?? 0) >= 0.2) premium = Math.max(0, premium - 0.02);
      lastIcmPath = 'real';
      return Math.min(endgameAdjust(premium, gs, stackBB, useV23End), 0.15);
    } catch {
      /* fall through to the legacy heuristic */
    }
  }

  let risk = stackBB < 40 ? 0.04 : 0.02;
  if (explicit) {
    const pl = explicit.playersLeft ?? 0;
    const paid = explicit.spotsPaid ?? 0;
    if (pl > 0 && paid > 0) {
      // Pressure scales with the ACTUAL distance to the money.
      const inMoney = explicit.inMoney ?? pl <= paid;
      if (!inMoney) {
        const ratio = pl / paid;
        if (ratio <= 1.15)
          risk += 0.06; // stone bubble
        else if (ratio <= 1.4) risk += 0.04;
        else if (ratio <= 2.0) risk += 0.02;
        // Big-stack bubble ABUSE: when hero covers the field the pressure
        // belongs to everyone else — halve the premium and open up while
        // the medium stacks have to fold.
        const avgBB = gs.bigBlind > 0 ? (explicit.avgStackChips ?? 0) / gs.bigBlind : 0;
        if (ratio <= 1.4 && avgBB > 0 && stackBB > avgBB * 1.8) risk *= 0.5;
      } else {
        // ITM: ladder pressure matters short-stacked; big stacks play chips.
        risk = stackBB < 15 ? risk + 0.02 : Math.max(0.01, risk - 0.02);
      }
    } else {
      // Legacy explicit flags (V7 shape) — behavior preserved exactly.
      if (explicit.nearBubble) risk += 0.04;
      if (explicit.inMoney && stackBB > 60) risk = Math.max(0.01, risk - 0.02);
    }
    // PKO: a fat bounty share makes covered all-ins better than raw ICM
    // says — trim the premium so the horses fight for bounties.
    if ((explicit.bountyFactor ?? 0) >= 0.2) risk = Math.max(0, risk - 0.02);
  }
  return Math.min(endgameAdjust(Math.min(risk, 0.12), gs, stackBB, useV23End), 0.15);
}

export interface GtoV31DecisionStateReceipt {
  schemaVersion: 1;
  street: Extract<HandStage, 'flop' | 'turn' | 'river'>;
  gameVariant: 'nlh';
  gameFamily: GtoV31GameFamily;
  objective: GtoV31Objective;
  utilityContext: GtoV31UtilityContext;
  format: 'cash' | 'mtt' | 'sng' | 'spin' | 'hu_sng';
  tableSize: number;
  potType: GtoV31PotType;
  heroPosition: GtoV31Position;
  opponentPosition: GtoV31Position;
  stackBb: number;
  depthBucket: number;
  textureClass: string;
  nodeRole: GtoV31NodeRole;
  facingKind: GtoV31FacingKind;
  facingSizeBucket: GtoV31SizeBucket;
  hand: string;
  handKey: string;
  cell: string;
  board: Card[];
  holeCards: Card[];
  pot: number;
  currentBet: number;
  toCall: number;
  bigBlind: number;
}

export interface GtoV31DecisionReceipt {
  datasetId: string;
  datasetChecksum: string;
  decisionState: GtoV31DecisionStateReceipt;
  nodeRole: GtoV31NodeRole;
  cell: string;
  handKey: string;
  actionId: string;
  sampledActionFamily: GtoV31ActionFamily;
  sampledAmount: number | null;
  finalAction: HorseDecision['action'];
  finalAmount: number | null;
  /** True only when legalization preserved the sampled family and wager size. */
  executedAsIntended: boolean;
  referenceDistribution: Record<string, number>;
  policyEvBb: number | null;
  actionEvsBb: Record<string, number | null> | null;
  sourceSeal: GtoV31SourceSeal;
}

/** V3/V4/V5 decision options (benchmark/test hooks — production uses defaults). */
export interface HorseDecideOpts {
  /**
   * Epoch captured when the turn decision was requested. Live decisions can
   * wait in the isolated worker's FIFO; pinning time here prevents queue
   * latency from changing an hourly mood at the boundary between two hours.
   */
  decisionTimeMs?: number;
  /** disable the HorseMind opponent-intelligence layer (default: enabled) */
  mind?: boolean;
  /**
   * Internal live-worker replay control. A deep second look must read the same
   * opponent model as its fast decision without ingesting the same action
   * snapshot again. This is deliberately separate from `mind`: false keeps
   * every strategic read enabled and suppresses only HorseMind.observe().
   */
  observeMind?: boolean;
  /** disable the V4 street-IQ layer: initiative, position, scare cards,
   *  made-hand class, pot geometry (default: enabled) */
  streetIQ?: boolean;
  /** disable the V5 dynamic hand-reading layer: street-by-street range
   *  narrowing, missed-c-bet probes, river polarization (default: enabled) */
  handReading?: boolean;
  /** disable the V7 layer: position-pair preflop, size-aware reads, barrel
   *  planning, counter-adaptation, ICM pressure (default: enabled) */
  v7?: boolean;
  /** ablation hooks (benchmarks only) — each defaults to the v7 master flag */
  v7Preflop?: boolean;
  v7SizeReads?: boolean;
  v7Barrels?: boolean;
  v7CounterAdapt?: boolean;
  v7AdaptiveMC?: boolean;
  /** disable the V8 layer: plo8 scoop/quarter awareness, Omaha nut-draw and
   *  wrap gating, NLH check-raise/river-raise bluffs, per-variant style
   *  overlays (default: enabled) */
  v8?: boolean;
  /** ablation hooks (benchmarks only) — each defaults to the v8 master flag */
  v8HiLo?: boolean;
  v8Draws?: boolean;
  v8Nlh?: boolean;
  /** disable the V9 humanization layer: bet-size families, difficulty-aware
   *  think time, hourly mood gear-shifts (default: enabled) */
  v9?: boolean;
  /** ablation hooks (benchmarks only) — each defaults to the v9 master flag */
  v9Sizing?: boolean;
  v9Timing?: boolean;
  v9Mood?: boolean;
  /** disable the V10 strategy layer: range-advantage c-bets, SPR-scaled
   *  commitment / pot control, river blocker bluff-catching, rake-aware pot
   *  odds, capped-range thin value, and limp isolation (default: enabled) */
  v10?: boolean;
  /** ablation hooks (benchmarks only) — each defaults to the v10 master flag */
  v10Cbet?: boolean;
  v10Spr?: boolean;
  v10Rake?: boolean;
  v10ThinValue?: boolean;
  v10Iso?: boolean;
  /** disable the V11 layer (Dan 2026-08-22): explicit cash/tournament game
   *  modes, the preflop price-in guard, initiative-gated leading (no more
   *  donk leads with medium hands), and board-domination call discipline
   *  (default: enabled) */
  v11?: boolean;
  /** V13 (2026-08-23): decision-core repairs found by the full-brain audit —
   *  the price-in guard no longer eats raises, position is derived from the
   *  players dealt in rather than those still live, sitting-out players stop
   *  masking heads-up play, and all-in players stop taking position. Ablation
   *  only; production leaves it on. */
  v13?: boolean;
  /** disable the V12 layer: board-conditioned opponent sampling — postflop
   *  aggressors are sampled toward hands that CONNECT with the actual board,
   *  passive checked lines get their monsters down-sampled (default: enabled) */
  v12?: boolean;
  /** ablation hook (benchmarks only) — defaults to the v12 master flag */
  v12Ranges?: boolean;
  /** PROOF OF RECEIPT: set true ONLY by the live engine's scheduleHorseAction
   *  — every synthetic caller (league, benchmarks, tests) leaves it unset so
   *  the fire counters describe the real fleet and nothing else. */
  telemetry?: boolean;
  /** disable the V16 real-ICM layer (2026-08-26): Malmuth-Harville bubble
   *  factor from the live stack distribution + payout curve, replacing the
   *  flat premium whenever the tournament context supplies both (default:
   *  enabled; degrades to the legacy heuristic without the data) */
  v16Icm?: boolean;
  /** disable the V16 heads-up postflop overlay (default: enabled) */
  v16Hu?: boolean;
  /** ENABLE the V16 bet-ratio rescale of the five thresholds still written
   *  in bet/(pot+bet) semantics (default: DISABLED — a strategy change that
   *  ships measured: the v16_ratio_rescale league matchup decides it) */
  v16Ratio?: boolean;
  /** disable the V16 blocker/unblocker river-bluff grading (default: on) */
  v16Blockers?: boolean;
  /** disable V16 size-conditioned strength sampling: a 20bb+ bet samples its
   *  maker toward two-pair-plus, not just any board contact (default: on) */
  v16SizeCond?: boolean;
  /** disable V16 PLO 3-bet polarity: AAxx 3-bets below the generic bar,
   *  speculative rundowns without AA flat at the margin (default: on) */
  v16PloPolar?: boolean;
  /** disable the V18 straddle fix: a straddled pot reads as UNOPENED and
   *  opens size off the straddle, instead of folding to dead money the
   *  brain mistook for an open raise (default: enabled) */
  v18Straddle?: boolean;
  /** disable the V18 squeeze response: an opener facing a squeeze (caller
   *  between) defends wider - squeeze ranges are polarized toward air
   *  (default: enabled) */
  v18Squeeze?: boolean;
  /** disable the V18 self-image read: a horse whose own recent line was
   *  bluff-heavy throttles bluffs - the table saw the same history it did
   *  (default: enabled) */
  v18SelfImage?: boolean;
  /** disable the V18 exploit-sized river raises: value raises grow into
   *  stations and shrink into nits (default: enabled) */
  v18ExploitSize?: boolean;
  /** disable the V18 per-horse sizing-family personality: a stable bias
   *  inside the size families, zero-mean fleet-wide (default: on) */
  v18Families?: boolean;
  /** disable the V17 positional-pressure layer (2026-08-26): bluff volume
   *  scales with how many live players still act BEHIND hero on this street
   *  — the binary ip/oop model treated first-of-four like first-of-two
   *  (default: enabled) */
  v17Pos?: boolean;
  /** disable the V17 river delayed probe: when the turn checked through, the
   *  capped field gets attacked on the river too, at a lower frequency than
   *  the turn probe (default: enabled) */
  v17RiverProbe?: boolean;
  /** disable the V17 call-side blocker read: holding the missed front-door
   *  draw yourself removes bluff combos from a big river bettor's range —
   *  fold more (default: enabled) */
  v17CatchBlock?: boolean;
  /** disable the V17 short-deck overlay: 36-card equities cluster tighter,
   *  so value thresholds rise and multiway tightens harder (default: on) */
  v17ShortDeck?: boolean;
  /** disable the V16 deep-read wiring (2026-08-26): fold-to-c-bet scaled
   *  c-bets, fold-to-3-bet scaled bluff 3-bets, and big-river-bet sizing
   *  tells in the call-down (default: enabled; reads ride the mind layer, so
   *  mind:false disables them too) */
  v16Reads?: boolean;
  /** disable the V15 layer (Dan 2026-08-26): Omaha nut discipline — made
   *  flushes and straights know their RANK, dominated hands stop raising and
   *  stop stacking off when raised, plo5/plo6 preflop scores are normalized
   *  per hole count, plo5/plo6 value sizing plays small ball, and PLO
   *  aggressors are sampled toward board contact (default: enabled) */
  v15?: boolean;
  /** disable the V12 river-sizing polish: OOP block bets, nut-advantage
   *  overbets + blocker overbet bluffs, extended blocker-aware catches
   *  (defaults to the v12 master flag) */
  v12River?: boolean;
  /** disable the V20 multiway discipline layer (Dan 2026-08-27): NLH-family
   *  structural equity caps when raised after aggression or facing serious
   *  all-ins (the T8o "two pair calls off two all-ins" hand), weak-two-pair
   *  demotion on paired boards, and a committed-branch call bar that finally
   *  respects the field size and the all-in count (default: enabled) */
  v20Multiway?: boolean;
  /** disable the V20 tournament M-zone layer (Dan 2026-08-27): effective-M
   *  computed from the real orbit cost (blinds + antes), Harrington-zone
   *  jam/reshove behavior (red jam-or-fold, orange open-jam, no raise-fold
   *  when committed), ICM-priced shove-calling, and Omaha short-stack jams
   *  (default: enabled) */
  v20Mzone?: boolean;
  /** disable the V21 river-endgame layer (Dan 2026-08-27, Phase 2): NLH nut
   *  status (which straight, which flush, whose boat), equity caps for
   *  board-dominated cat-5/6/7 hands under pressure, the river raise-war
   *  governor (non-nut hands never re-raise a river raise), and the
   *  scare-runout premium on committed calls (default: enabled) */
  v21River?: boolean;
  /** disable the V21 deep-stack preflop discipline: 150bb+ cash stack-off
   *  thresholds scale with depth — 4-bet/5-bet pots demand closer to the
   *  nuts at 250bb than at 100bb (default: enabled) */
  v21Deep?: boolean;
  /** disable the V23 tournament endgame layer (2026-08-28): final-table
   *  ladder pressure, HU-of-MTT chip-EV play, PKO bounty pricing on covered
   *  call-offs, and blind-clock anticipation (jam before the level hits)
   *  (default: enabled) */
  v23Endgame?: boolean;
  /** disable the V23 raise-response plans: the bet decides at bet time what
   *  a raise back means — commit, call once, or fold — and the answer to
   *  the raise is the one the bet already gave (default: enabled; plans are
   *  mind state, so mind:false disables them too) */
  v23Plan?: boolean;
  /** disable the V23 river reads: per-villain fold-to-river-bet frequency
   *  scales river bluffs up against folders and thin value down against
   *  stations (default: enabled; rides the mind layer) */
  v23Reads?: boolean;
  /** disable the V23 variant polish: short-deck draw/thin-value recalibration
   *  and plo8 low-only draw discipline (default: enabled) */
  v23Variants?: boolean;
  /** disable the V23 spin overlay: 3-max hypers reward aggression — bluff
   *  volume up, value thresholds down a notch (default: enabled). The overlay
   *  is about the STRUCTURE (three-handed, shallow, 3-minute levels), not the
   *  payout shape: it stays on at 10x+, where the ladder's survival premium
   *  arrives separately through icmRisk and already damps bluffScale. */
  v23Spin?: boolean;
  /** disable the V24 bounty layer (Dan 2026-08-28): PKO and mystery-bounty
   *  awareness preflop — pots against a covered raiser are worth more than
   *  their chips, so the call bar bends toward them (default: enabled) */
  v24Bounty?: boolean;
  /** disable the V24 Omaha price defense: in PLO the call bar bends toward
   *  the POT ODDS rather than a fixed NLH-calibrated percentile, and the
   *  survival premium scales with the fraction of stack actually at risk
   *  (default: enabled) */
  v24PloDefense?: boolean;
  /** disable the V25 PLO tournament layer (Dan 2026-08-28): pot limit means
   *  you cannot shove, so short-stack PLO is a COMMITMENT decision rather
   *  than push/fold — plus the Omaha reshove, price-driven all-in calls, and
   *  the rule against raise-folding a committed stack (default: enabled) */
  v25PloTourney?: boolean;
  /** disable the V26 prize-landscape layer (Dan 2026-08-28): the horse reads
   *  the LIVE bounty inventory — how many chests are left, what one is worth
   *  on average, and whether the top prize is still in the box — and prices a
   *  bust in BIG BLINDS instead of guessing from a pool ratio (default: on) */
  v26Prizes?: boolean;
  /** disable the V27 solver charts (Dan 2026-08-29): short-stack NLH preflop
   *  reads the PioSolver push/fold charts (memory_charts_gold) instead of the
   *  hand-tuned thresholds — open jam-or-fold at <=15bb, BB call-off vs an SB
   *  jam at <=25bb. With no charts hydrated the layer is inert and the
   *  heuristics decide, so a boot race can never lobotomize the brain
   *  (default: enabled) */
  v27GtoCharts?: boolean;
  /** disable the V29 solver flop layer (Dan 2026-08-29): heads-up hold'em
   *  flops with the betting lead play the PioSolver class-mean check/bet mix
   *  from the offline aggregation of the 8.8M-solution warehouse. (The
   *  facing-a-bet consult that first shipped with V29 was REMOVED the same
   *  day: the warehouse holds only open nodes, and the 'facing' cells were
   *  built from contaminated deep-tree numbers — see GtoPostflop.ts.)
   *  Empty store = inert, exactly like V27 (default: enabled) */
  v29GtoFlop?: boolean;
  /** disable the V30 solver turn/river layer (Dan 2026-08-29): same
   *  open-node consult as V29, extended to turn and river from the
   *  cursor-driven aggregation (fn_aggregate_gto_street_next, root-node
   *  actions only, per-hand validated). Empty store = inert
   *  (default: enabled) */
  v30GtoTurnRiver?: boolean;
  /** disable the V31 suit-aware solver layer (2026-08-30): the SECOND solver
   *  export, strategy_matrix_v2, which is disjoint from the one V29/V30 read
   *  - zero of 9,584 sampled turn rows carry both. Keyed by hand class AND
   *  how many of the board's flush suit the holding contains, and it carries
   *  the solver's real bet size, so it can play the 246%-pot turn overbet v1
   *  cannot express at all. Consulted BEFORE V30; empty store = inert
   *  (default: enabled) */
  v31GtoSuitAware?: boolean;
  /**
   * Offline promotion harness only: read this exact sealed candidate instead
   * of the active V31 snapshot. Production never sets it. Keeping the
   * selector in decide options makes duplicate-deal A/B evaluation use the
   * same action path without allowing a candidate to replace live policy.
   */
  gtoV31DatasetChecksum?: string;
  /**
   * Offline evidence hook used by candidate gates and the daily active-corpus
   * agreement probe. Never set by the live engine. The receipt is emitted
   * only after the ordinary V31 lookup, sample, and legalization path runs.
   */
  onGtoV31Decision?: (receipt: GtoV31DecisionReceipt) => void;
  /** V32: facing-a-bet defence from the solver's own betting range. */
  v32FacingDefense?: boolean;
  /** V33 (2026-09-01): refuse a solver consult the warehouse cannot honestly
   *  answer. DEPTH_BUCKETS stops at 150 and snapDepthBucket returns 150 for
   *  ANY stack over 110, so a 400bb or 800bb hero was served 150bb strategy
   *  silently, with no miss recorded. Above GTO_MAX_DEPTH_BB (twice the
   *  deepest bucket - the same log-distance this file already tolerates for a
   *  one-bucket fallback) the consult declines and the heuristic layers,
   *  which scale continuously with depth, play the spot. Disable to ablate
   *  (default: enabled) */
  v33DepthCeiling?: boolean;
  /** V37 (2026-09-02): satellite play — flat prizes are survival, not a
   *  ladder. A locked seat folds everything, a stack below the line jams
   *  wider, a table captain open-jams into stacks that cannot call. Disable
   *  to ablate (default: enabled). */
  v37Satellite?: boolean;
  /** V38 (2026-09-03): the EV engine arbiter for solverless games (Omaha,
   *  short deck, pineapple, fixed limit) and the MDF river line for every
   *  game. Disable to ablate (default: enabled). */
  v38Ev?: boolean;
  /** V40 (Dan 2026-09-04): Omaha is not hold'em. Aggressors are sampled
   *  toward a made category that scales with their line (a pot-sized third
   *  barrel is a boat, not "something that connects"), pair/two-pair/trips
   *  hands facing that line are equity-capped by WHICH two pair on WHAT
   *  board, and non-nut made hands stop firing pot on the turn and river.
   *  Disable to ablate (default: enabled). */
  v40Omaha?: boolean;
  /** Legacy switch for review-signal diagnostic telemetry only. Never changes policy. */
  v41Leaks?: boolean;
  /** V43 (2026-09-05): tempo reads - a river big bet priced by how fast it
   *  was made against what this player's bets at that tempo have shown down
   *  as. Disable to ablate (default: enabled). */
  v43Tempo?: boolean;
  /** V46 (2026-09-05): the Omaha / short-deck hand-class chart - AAxx
   *  double-suited 3-bets, a rundown flats, AAA-x folds. Disable to ablate
   *  (default: enabled). Hold'em is unaffected either way. */
  v46Charts?: boolean;
  /** Phase 7 Round 1: final action-specific tournament utility arbiter.
   *  Complete schema-v1 tournament decisions evaluate every legal action
   *  family after all legacy strategy layers; no global style multiplier can
   *  overwrite its choice (default: enabled). */
  phase7Utility?: boolean;
  /** Phase 8 is shadow by default. Candidate mode is for isolated promotion runs. */
  phase8Postflop?: Phase8Mode;
  /** Phase 10 complete baseline runs in shadow until its own promotion gate passes. */
  phase10Plo4?: Plo4LiveMode;
  /** Offline fixed-work evaluation only; rejected at the live worker boundary. */
  phase10EvidenceMode?: boolean;
  /** Phase 11 variant policies are live shadow; candidate/evidence controls are offline only. */
  phase11Omaha?: OmahaVariantMode;
  phase11EvidenceMode?: boolean;
  phase12Remaining?: RemainingVariantMode;
  phase12EvidenceMode?: boolean;
  phase13Joint?: import('./multiway/JointLivePolicy.js').JointPolicyMode;
  phase13EvidenceMode?: boolean;
  /** V44 (2026-09-05): the SECOND LOOK. When set above 1, every Monte Carlo
   *  read in this decision runs at that multiple of its budgeted sample. The
   *  engine uses it to replay a close decision inside the think time it was
   *  already going to spend; see ServerTableEngineTurns.scheduleHorseAction.
   *  Never set on the fast path. */
  deepEquity?: number;
}

/**
 * V9 MOOD — hourly gear-shifts. Real players run hot and cold across a
 * session: an hour where a guy is visibly opening more, an hour where he
 * tightens up. A hash of (horse, current hour) gives every horse a stable
 * within-the-hour mood that observers can actually pick up on — exactly the
 * kind of exploitable-looking texture humans produce — while staying zero-mean
 * across the fleet and across time.
 */
function moodOf(userId: string, decisionTimeMs = Date.now()): number {
  const key = userId + '|' + Math.floor(decisionTimeMs / 3_600_000);
  let h = 17;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000; // 0..1, stable for the hour
}

/**
 * THE VPIP FLOOR MULTIPLIER (Dan 2026-09-04) - a multiplier on preflop
 * tightness (<1 = looser) so a horse at a floored table keeps its VPIP above
 * the floor the way a human regular at that table would.
 *
 * WHY. Action tables carry a 30-40% floor and Madness 60-70%, judged over ten
 * hands and every hand after; a seat under it is stood up. The fleet is tuned
 * to 19-32% VPIP (HorseSelfTuner), so without this every horse at a Madness
 * table was stood up at hand eleven, the fleet reseeded, and the game churned
 * instead of ran. Measured 2026-09-04 23:0x UTC before the window moved to
 * ten: 18 of 56 seats under their floor, all horses.
 *
 * HOW. The target is the floor plus a ten-point cushion, capped at 95%. With
 * no sample yet (under three hands) the multiplier is a PRIOR: the fleet's
 * base width over the target, so a horse arrives already loose enough. From
 * three hands the loop closes on the JUDGED figure: under target by g points
 * loosens by 1.5g, floored at 0.35 (a bar at a third of its height plays
 * nearly everything); at or over target the multiplier is 1 - being above a
 * floor is fine, and the horse's own style resumes. Never above 1: this layer
 * only widens.
 *
 * It scales the same `tightness` every preflop bar is built from (t() in
 * HorsePreflop), so open, call, defend and 3-bet ranges all widen together -
 * VPIP is voluntary money in preflop by any route.
 */
/**
 * THE WINDOW THE FLOOR IS JUDGED OVER. `tables.maintain_hands`, pinned at 10
 * on every surface by migration 20260904231353 (`v_vpip_window := 10`,
 * `SET maintain_hands = 10`, `'{vpip_window}'` in the ruleset snapshot).
 */
export const VPIP_JUDGED_OVER_HANDS = 10;

/**
 * HOW FAR ABOVE THE FLOOR A HORSE AIMS, IN STANDARD ERRORS OF THAT WINDOW.
 *
 * ── DERIVED, NOT GUESSED (2026-09-09) ─────────────────────────────────────
 *
 * The cushion used to be a flat ten points, and the fleet hit it exactly -
 * which was the problem. `fn_nit_check` judges the CUMULATIVE VPIP of a
 * sitting the moment it reaches ten hands, and a ten-hand proportion has a
 * standard error near 15 points, so aiming ten points over a floor puts the
 * floor about two thirds of one standard error away and roughly a sixth of
 * all sittings under it at the very first check.
 *
 * Measured on production over the 24 hours to 2026-09-09 22:00, horse
 * sittings at floored tables that reached ten hands:
 *
 *   | template | floor | sittings | mean VPIP over first 10 | under floor at hand 10 |
 *   | action   |  30   |   392    |         47.1%           |    25  (6.4%)          |
 *   | madness  |  50   |   597    |         59.2%           |   104 (17.4%)          |
 *
 * The mean cleared both floors; the SAMPLE did not. And because the check
 * re-runs on every hand after the tenth, that first-check risk compounds into
 * the observed outcome over the same window: of every horse sitting that
 * ENDED, 56% of Madness and 27% of Action ended in `vpip_evicted`, median at
 * hand 11 - the first moment the rule can fire. Each one also writes a
 * two-hour bar on that game (`fn_cash_session_close`), which is why 42 Action
 * and Madness tables were holding 13 horses between them.
 *
 * `tests/a-vpip-floor-must-be-reachable.law.test.ts` was written for exactly
 * this and states the acceptance criterion being missed: "a horse that is
 * booted every ten hands is not obeying the floor, it is churning the game."
 *
 * 1.3 standard errors puts about a tenth of windows under the floor instead
 * of a sixth, and it is the largest margin that still leaves the widening
 * layer room to steer at the highest floor the product may set: at floor 50
 * the prior multiplier becomes 0.40, comfortably above the 0.35 clamp that
 * means "this floor cannot be reached by widening at all".
 *
 * THE FLOOR VALUES THEMSELVES ARE NOT TOUCHED HERE. 30 and 50 are Dan's
 * (2026-09-05) and a migration asserts no live table carries anything else.
 * This is only how hard the horse plays to clear one.
 */
export const VPIP_FLOOR_MARGIN_SIGMAS = 1.3;

/** The fleet's own preflop width with no floor applied. */
const BASE_VPIP = 0.28;
/** The most this layer may widen. A bar at a third of its height is already
 *  playing nearly everything; past that the floor is unreachable and the
 *  table churns however long the horse sits there. */
const VPIP_FLOOR_MUL = 0.35;

/**
 * The frequency a horse aims at on a table whose floor is `floorPct`: the
 * floor plus enough margin that an ordinary ten-hand sample does not fall
 * under it. Exported so the law that judges reachability asks the SAME
 * function the brain uses, rather than restating the arithmetic and drifting
 * from it.
 */
export function vpipTargetFor(floorPct: number): number {
  const floor = Number(floorPct) / 100;
  if (!(floor > 0)) return 0;
  /* The standard error of a proportion over the judged window, taken AT THE
     FLOOR - the horse is steering from below, so the floor is the relevant
     variance, and it is the figure that does not move as the horse's own
     rate does. */
  const se = Math.sqrt((floor * (1 - floor)) / VPIP_JUDGED_OVER_HANDS);
  return Math.min(0.95, floor + VPIP_FLOOR_MARGIN_SIGMAS * se);
}

export function vpipFloorMul(gs: {
  vpipFloor?: number;
  ownVpip?: { hands: number; vpip: number | null };
}): number {
  const floor = Number(gs.vpipFloor ?? 0);
  if (!(floor > 0)) return 1;
  const target = vpipTargetFor(floor);
  const own = gs.ownVpip;
  if (!own || own.hands < 3 || own.vpip === null || !Number.isFinite(own.vpip)) {
    return Math.max(VPIP_FLOOR_MUL, Math.min(1, BASE_VPIP / target));
  }
  const gap = target - own.vpip / 100;
  if (gap <= 0) return 1;
  return Math.max(VPIP_FLOOR_MUL, 1 - 1.5 * gap);
}

/**
 * V9 TIMING — decision-difficulty hint. decidePostflop records how close the
 * MC equity landed to the nearest strategy threshold; computeThinkTime turns
 * closeness into a TANK (humans agonize over close spots and snap the easy
 * ones). Module-level stash is safe: decisions are synchronous and
 * single-threaded, and the consumer resets it every read.
 */
let difficultyHint = 0;

interface Phase7EquityEvidence {
  equity: number;
  sampleSize: number;
  standardError: number;
  opponents: TournamentUtilityOpponentEvidence[];
  sampledOpponentIds: string[];
  showdownSamples: TournamentUtilityShowdownSample[];
}

/**
 * Per-decision bridge from the equity pass to Phase 7's final arbiter. Like
 * difficultyHint, the live worker is the only owner and HorseLogic decisions
 * are synchronous. It is cleared before and after every decision.
 */
let phase7EquityEvidence: Phase7EquityEvidence | null = null;
let phase10EquityEvidence: Plo4EquityEvidence | null = null;
let phase11DecisionEquityCeiling: number | null = null;
let phase12DecisionEquityCeiling: number | null = null;

function phase7PlayersBehind(gs: HorseGameStateV2, hero: SeatPlayer): Set<string> {
  if (gs.dealerSeat === undefined) return new Set<string>();
  const dealt = gs.players
    .filter((player) => !player.is_sitting_out)
    .slice()
    .sort((left, right) => left.seat - right.seat);
  if (dealt.length < 2) return new Set<string>();

  const afterSeat = (seat: number, steps: number): number => {
    let index = dealt.findIndex((player) => player.seat === seat);
    if (index < 0) index = 0;
    return dealt[(index + steps) % dealt.length].seat;
  };
  let firstSeat: number;
  if (gs.stage === 'preflop') {
    if (dealt.length === 2) firstSeat = gs.dealerSeat;
    else {
      // Button -> SB -> BB -> first actor. A live straddle advances one more
      // seat; the live contract currently supports the single UTG straddle.
      firstSeat = afterSeat(gs.dealerSeat, gs.straddleActive ? 4 : 3);
    }
  } else {
    firstSeat = afterSeat(gs.dealerSeat, 1);
  }

  const start = dealt.findIndex((player) => player.seat === firstSeat);
  const ordered = dealt.slice(start).concat(dealt.slice(0, start));
  const heroIndex = ordered.findIndex((player) => player.seat === hero.seat);
  if (heroIndex < 0) return new Set<string>();
  return new Set(
    ordered
      .slice(heroIndex + 1)
      .filter(
        (player) =>
          !player.is_folded &&
          !player.is_sitting_out &&
          !player.is_all_in &&
          player.user_id !== hero.user_id
      )
      .map((player) => player.user_id)
  );
}

function capturePhase7Equity(
  gs: HorseGameStateV2,
  hero: SeatPlayer,
  equity: number,
  sampleSize: number,
  bands: Array<[number, number] | null> | undefined,
  useMind: boolean,
  outcomeBoards: HorseEquityOutcomeCollector[]
): void {
  const active = gs.players.filter(
    (player) => player.user_id !== hero.user_id && !player.is_folded && !player.is_sitting_out
  );
  const behind = phase7PlayersBehind(gs, hero);
  const n = Math.max(0, Math.floor(sampleSize));
  const boundedEquity = clamp01(equity);
  const outcomeCount = outcomeBoards.reduce(
    (minimum, collector) => Math.min(minimum, collector.samples.length),
    outcomeBoards.length > 0 ? Infinity : 0
  );
  const showdownSamples: TournamentUtilityShowdownSample[] = [];
  for (let index = 0; index < outcomeCount; index++) {
    showdownSamples.push({
      boards: outcomeBoards.map((collector) => collector.samples[index]),
    });
  }
  phase7EquityEvidence = {
    equity: boundedEquity,
    sampleSize: n,
    standardError: n > 0 ? Math.sqrt((boundedEquity * (1 - boundedEquity)) / n) : 0,
    sampledOpponentIds: active.map((opponent) => opponent.user_id),
    showdownSamples,
    opponents: active.map((opponent, index) => {
      let foldMul = 1;
      if (useMind) {
        try {
          foldMul = HorseMind.exploit(opponent.user_id).bluffMod;
        } catch {
          foldMul = 1;
        }
      }
      return {
        userId: opponent.user_id,
        range: bands?.[index] ?? null,
        foldMul,
        actsAfterHero: behind.has(opponent.user_id),
      };
    }),
  };
}

function buildPhase7UtilityInput(
  gs: HorseGameStateV2,
  player: SeatPlayer,
  decision: HorseDecision,
  vi: ReturnType<typeof variantInfo>,
  tournament: NonNullable<HorseGameStateV2['tournament']>,
  evidence7: Phase7EquityEvidence
): TournamentUtilityInput {
  if (!gs.pots || !gs.legalActions) throw new Error('joint_utility_canonical_state_unavailable');
  const toCall = Math.max(0, gs.currentBet - player.bet);
  return {
    street: gs.stage,
    hero: player,
    players: gs.players,
    pots: gs.pots,
    pot: Math.max(0, Number(gs.pot) || 0),
    currentBet: Math.max(0, Number(gs.currentBet) || 0),
    toCall: Math.min(Math.max(0, Number(gs.toCall ?? toCall) || 0), Math.max(0, player.stack)),
    legalActions: gs.legalActions,
    minRaiseTo: gs.minRaiseTo ?? null,
    maxRaiseTo: gs.maxRaiseTo ?? null,
    bettingStructure:
      gs.bettingStructure ??
      (vi.isFixedLimit ? 'fixed_limit' : vi.isPotLimit ? 'pot_limit' : 'no_limit'),
    baseline: decision,
    heroEquity: evidence7.equity,
    equitySampleSize: evidence7.sampleSize,
    equityStandardError: evidence7.standardError,
    opponents: evidence7.opponents,
    sampledOpponentIds: evidence7.sampledOpponentIds,
    showdownSamples: evidence7.showdownSamples,
    context: {
      format:
        gs.format === 'spin' || gs.format === 'sng' || gs.format === 'hu_sng' ? gs.format : 'mtt',
      playersLeft: Math.max(0, tournament.playersLeft ?? 0),
      spotsPaid: Math.max(0, tournament.spotsPaid ?? 0),
      satellite: tournament.satellite === true,
      satelliteSeats: Math.max(0, tournament.satelliteSeats ?? 0),
      // Once the field is already in the money, lower-place prizes
      // belong to players who have finished. Price only places the
      // live field can still occupy; keeping the full paid tail made
      // every playersLeft < spotsPaid decision fail validation.
      payoutPct: (tournament.payoutPct ?? []).slice(0, Math.max(0, tournament.playersLeft ?? 0)),
      fieldStacks: tournament.stacks ?? [],
      fieldStackByUser: tournament.stackByUser ?? {},
      isPko: tournament.isPko === true,
      isBounty: tournament.isBounty === true,
      isMysteryBounty: tournament.isMysteryBounty === true,
      mysteryBountyStage: tournament.mysteryBountyStage ?? 'none',
      bountyFactor: Math.max(0, tournament.bountyFactor ?? 0),
      bountyByUser: tournament.bountyByUser ?? {},
      mysteryMeanCents: Math.max(0, tournament.mysteryMeanCents ?? 0),
      meanBountyCents: Math.max(0, tournament.meanBountyCents ?? 0),
      prizePoolCents: Math.max(0, tournament.prizePoolCents ?? 0),
      bountyPoolCents: Math.max(0, tournament.bountyPoolCents ?? 0),
      reentryOpen: tournament.reentryOpen === true,
      rebuyOpen: tournament.rebuyOpen === true,
      maxReentries: tournament.maxReentries ?? null,
      maxRebuys: tournament.maxRebuys ?? null,
      addOnPeriodOpen: tournament.addOnPeriodOpen === true,
      addOnCostCents:
        tournament.addOnCost == null ? null : Math.round(Math.max(0, tournament.addOnCost) * 100),
      addOnChips: tournament.addOnChips ?? null,
      buyInCents: tournament.buyInCents ?? null,
      startingStackChips: tournament.startingStackChips ?? null,
      rebuyCostCents: tournament.rebuyCostCents ?? null,
      rebuyChips: tournament.rebuyChips ?? null,
      rebuyPrizeContributionCents: tournament.rebuyPrizeContributionCents ?? null,
      rebuyBountyContributionCents: tournament.rebuyBountyContributionCents ?? null,
      reloadsUsed: tournament.reloadsUsed ?? null,
      addOnTaken: tournament.addOnTaken ?? null,
      rebuyAffordable: tournament.rebuyAffordable ?? null,
      addOnAffordable: tournament.addOnAffordable ?? null,
    },
  };
}

function currentPhase7Equity(): Phase7EquityEvidence | null {
  return phase7EquityEvidence;
}

function phase7OutcomeBudget(playersLeft: number | undefined): number {
  const field = Math.max(0, Math.floor(playersLeft ?? 0));
  if (field <= 10) return 160;
  if (field <= 200) return 64;
  return 32;
}

/** V23 RAISE-RESPONSE PLAN — set per postflop decision, consumed by
 *  betSize/raiseTo (the only places a postflop chip goes in), recorded into
 *  HorseMind so the SAME street's raise gets the answer the bet chose.
 *  Module-level is safe for the same reason difficultyHint is. */
let pendingRaisePlan: import('./HorseMind.js').RaiseResponsePlan | null = null;

/** V9 SIZING — human bet-size families. Continuous uniform sizing is a subtle
 *  tell: real players think in pot fractions (third, half, two-thirds,
 *  three-quarters, pot, overbet). Snap the computed fraction to the nearest
 *  family with a little jitter; extreme fractions (geometric jams) pass
 *  through untouched. */
const SIZE_FAMILIES = [0.33, 0.5, 0.66, 0.8, 1.0, 1.3];
function snapFraction(frac: number, familyBias: number = 0.5): number {
  // V28 AUDIT FIX: the passthrough floor was 0.25, so the river BLOCK BET
  // (0.27-0.33) and the V10 range-advantage small c-bet (0.28-0.34) all
  // snapped up into the 0.33 family — two deliberately distinct small sizes
  // were unobservable in production, and a pin on "block bet <= 0.45 pot"
  // stayed green while the documented quarter-pot bet did not exist. Sizes
  // under 0.31 now pass through untouched.
  if (frac < 0.31 || frac > 1.4) return frac;
  let best = SIZE_FAMILIES[0];
  for (const f of SIZE_FAMILIES) if (Math.abs(frac - f) < Math.abs(frac - best)) best = f;
  // V18 FAMILY PERSONALITY: a stable per-horse shift inside the family
  // (+/-3% of pot), zero-mean across the fleet. Two horses picking "half
  // pot" land on 0.47 and 0.53 for the rest of their lives - the kind of
  // signature real players carry and observers can even learn.
  return best + (fastRandom() - 0.5) * 0.08 + (familyBias - 0.5) * 0.06;
}

/**
 * V10 RAKE — only the MARGINAL rake matters to a decision. Live schema-v1
 * states carry the exact active percentage and player-count cap, including the
 * heads-up ceiling. Once that cap is reached the marginal rake is zero and pot
 * odds are honest again. The historical 10% / 2.5bb approximation remains only
 * for offline fixtures that predate the canonical state contract.
 */
const RAKE_PCT = 0.1;
function rakeDrag(
  pot: number,
  bigBlind: number,
  config?: RakeConfig,
  playerCount?: number
): number {
  if (config) {
    // Timed collection is not a marginal tax on this pot.
    if (config.timedRake) return 0;
    let rate = Math.max(0, config.percent) / 100;
    if (playerCount !== undefined && playerCount <= 2) {
      rate = Math.min(rate, HEADS_UP_RAKE_PERCENT / 100);
    }
    let cap = Math.max(0, config.cap);
    if (config.playerCountCaps?.length && playerCount !== undefined) {
      const tier = [...config.playerCountCaps]
        .sort((a, b) => b.players - a.players)
        .find((candidate) => playerCount >= candidate.players);
      if (tier) cap = Math.max(0, tier.cap);
    }
    return pot > 0 && rate > 0 && cap > 0 && pot * rate < cap ? rate : 0;
  }
  const capChips = Math.max((bigBlind > 0 ? bigBlind : 2) * 2.5, 3);
  return pot > 0 && pot * RAKE_PCT < capChips ? RAKE_PCT : 0;
}

/**
 * Last-mile Phase 5 legality. Strategy may express intent, but the immutable
 * HandController menu is the authority for reopening rights, structure caps
 * and table commitment caps. When intent cannot be represented legally, this
 * degrades without committing extra chips: check first, otherwise fold.
 */
function enforceAuthoritativeDecision(
  decision: HorseDecision,
  player: SeatPlayer,
  gs: HorseGameStateV2
): HorseDecision {
  if (gs.stateSchemaVersion !== 1 || !Array.isArray(gs.legalActions)) return decision;

  const legal = new Set(gs.legalActions);
  const stack = Number.isFinite(player.stack) ? Math.max(0, player.stack) : 0;
  const toCall = Number.isFinite(gs.toCall)
    ? Math.max(0, gs.toCall as number)
    : Math.max(0, gs.currentBet - player.bet);
  const cents = (value: number): number => Math.round(value * 100) / 100;
  const safe = (): HorseDecision => {
    if (toCall <= 0.005 && legal.has('check')) return { action: 'check', thinkTime: 0 };
    if (legal.has('fold')) return { action: 'fold', thinkTime: 0 };
    if (legal.has('check')) return { action: 'check', thinkTime: 0 };
    // A malformed menu should already have been rejected at the worker
    // boundary. These final branches keep direct/offline callers total.
    if (legal.has('call')) {
      return { action: 'call', amount: cents(Math.min(toCall, stack)), thinkTime: 0 };
    }
    return { action: 'fold', thinkTime: 0 };
  };
  const call = (): HorseDecision => {
    if (!legal.has('call')) return safe();
    if (toCall >= stack - 0.005 && legal.has('all_in')) {
      return { action: 'all_in', thinkTime: 0 };
    }
    return { action: 'call', amount: cents(Math.min(toCall, stack)), thinkTime: 0 };
  };

  if (decision.action === 'call') return call();
  if (decision.action === 'check') return legal.has('check') ? decision : safe();
  if (decision.action === 'fold') {
    const normalized =
      toCall <= 0.005 && legal.has('check') ? { action: 'check' as const, thinkTime: 0 } : safe();
    return normalized.action === 'fold' ? { ...decision, ...normalized } : normalized;
  }
  if (decision.action === 'all_in' && legal.has('all_in')) return decision;

  let wagerAction: 'bet' | 'raise' | null = null;
  if (decision.action === 'bet' || decision.action === 'raise' || decision.action === 'all_in') {
    const contextual = gs.currentBet > 0 ? 'raise' : 'bet';
    if (legal.has(contextual)) wagerAction = contextual;
  }
  if (!wagerAction) {
    return decision.action === 'raise' || decision.action === 'all_in' ? call() : safe();
  }

  const minTo = gs.minRaiseTo;
  const maxTo = gs.maxRaiseTo;
  if (
    typeof minTo !== 'number' ||
    !Number.isFinite(minTo) ||
    typeof maxTo !== 'number' ||
    !Number.isFinite(maxTo) ||
    maxTo < minTo - 0.005
  ) {
    return wagerAction === 'raise' ? call() : safe();
  }
  const requested =
    decision.action === 'all_in'
      ? maxTo
      : Number.isFinite(decision.amount)
        ? decision.amount!
        : minTo;
  const amount = cents(Math.max(minTo, Math.min(maxTo, requested)));
  return { action: wagerAction, amount, thinkTime: 0 };
}

export class HorseLogic {
  static decide(
    player: SeatPlayer,
    gameState: HorseGameStateV2,
    style: HorseStyle = 'balanced',
    mods: HorseProfileMods = {},
    opts: HorseDecideOpts = {}
  ): HorseDecision {
    try {
      // V45 SCOPED READS: every read in this decision sees the bucket for
      // this card family and table size (HorseMind.readStats). Cleared on
      // every exit, including a throw.
      HorseMind.setDecisionScope(
        readScopeOf(
          gameState.gameVariant,
          Array.isArray(gameState.players)
            ? gameState.players.filter((p) => !p.is_sitting_out).length
            : 0
        )
      );
      // V3: ingest the action stream into the opponent-intelligence layer.
      // Wrapped so observation can never take down a decision.
      // V12: benchmark/league decisions pass mind:false — they must never
      // write synthetic hands into the live opponent memory.
      if (opts.mind !== false && opts.observeMind !== false) {
        try {
          HorseMind.observe(gameState.actionHistory, gameState.players);
        } catch {
          /* observation is best-effort */
        }
      }
      // V44 SECOND LOOK: a deep replay runs the same path at a larger
      // sample. Bracketed so a throw cannot leave the depth raised for the
      // next horse to act.
      if (opts.deepEquity !== undefined && opts.deepEquity > 1) {
        setEquityDepth(opts.deepEquity);
        try {
          return this.decideInternal(player, gameState, style, mods, opts);
        } finally {
          setEquityDepth(1);
        }
      }
      return this.decideInternal(player, gameState, style, mods, opts);
    } catch (err) {
      // Absolute safety net: never let a horse hang the table.
      // V13: it used to swallow the error entirely. This is the innermost and
      // most consequential catch in the brain — if a systematic defect were
      // introduced (a null board, a bad variant, a shape change in players)
      // the whole fleet would silently degrade to check/fold while every
      // dashboard stayed green. Every other automated-action path in the
      // engine reports; this one now does too.
      reportError(err, 'HorseLogic.decide_threw');
      // V13: the think-time hint is a module global, normally consumed and
      // cleared by computeThinkTime. The safety net returns WITHOUT calling
      // it, so a throw stranded the value and the NEXT horse to act — a
      // different player, possibly a different table — inherited the tank
      // multiplier. Clear it on the way out.
      difficultyHint = 0;
      phase7EquityEvidence = null;
      phase10EquityEvidence = null;
      phase11DecisionEquityCeiling = null;
      phase12DecisionEquityCeiling = null;
      const toCall = Math.max(0, (gameState.currentBet || 0) - (player.bet || 0));
      return toCall === 0
        ? { action: 'check', thinkTime: 1500 }
        : { action: 'fold', thinkTime: 1500 };
    } finally {
      phase7EquityEvidence = null;
      phase10EquityEvidence = null;
      phase11DecisionEquityCeiling = null;
      phase12DecisionEquityCeiling = null;
      HorseMind.setDecisionScope(null);
    }
  }

  private static decideInternal(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    styleName: HorseStyle,
    mods: HorseProfileMods,
    opts: HorseDecideOpts = {}
  ): HorseDecision {
    phase7EquityEvidence = null;
    phase10EquityEvidence = null;
    phase11DecisionEquityCeiling = null;
    phase12DecisionEquityCeiling = null;
    const base = STYLE_PARAMS[styleName] || STYLE_PARAMS.balanced;
    const params: StyleParams = {
      ...base,
      tightness: base.tightness * (mods.tightness ?? 1),
      bluffFreq: base.bluffFreq * (mods.bluffFreq ?? 1),
      aggression: base.aggression * (mods.aggression ?? 1),
      sizingMultiplier: base.sizingMultiplier * (mods.sizingMultiplier ?? 1),
    };
    // Observational reports remain visible, without changing prices, gates or RNG.
    if (opts.v41Leaks !== false && telemetryOn(opts) && hasHorseReviewSignals(mods)) {
      noteFire('phase14_review_signal_ignored');
    }

    const compiledVariant = variantInfo(gs.gameVariant);
    // Phase 5 live requests carry explicit rules and the worker proves they
    // match gameVariant before this method runs. Read those facts here rather
    // than transporting a contract the brain then ignores. Offline fixtures
    // without schema-v1 rules retain the historical variant resolver.
    const vi: VariantInfo = gs.variantRules
      ? {
          ...compiledVariant,
          holeCount: gs.variantRules.holeCardsDealt,
          isOmaha:
            gs.variantRules.holeCardsUse === 'exactly_two' &&
            gs.variantRules.boardCardsUse === 'exactly_three',
          isHiLo: gs.variantRules.splitLow8OrBetter,
          isShortDeck: gs.variantRules.deckSize === 36,
          isPotLimit:
            gs.bettingStructure !== undefined
              ? gs.bettingStructure === 'pot_limit'
              : compiledVariant.isPotLimit,
          isFixedLimit:
            gs.bettingStructure !== undefined
              ? gs.bettingStructure === 'fixed_limit'
              : compiledVariant.isFixedLimit,
        }
      : compiledVariant;
    // V48: the authored persona still reaches the solver consult.
    params.gtoAdherence = mods.persona?.gtoAdherence ?? 1;
    const toCall = Math.max(0, gs.currentBet - player.bet);

    // V8: per-variant style overlays. The five styles were tuned on NLH;
    // Omaha punishes slowplay (equities swing too hard street to street), so
    // PLO variants trim bluff/slowplay volume. Short deck trims bluffs
    // slightly (equities run closer). The 'balanced' style also caps its
    // slowplay — live telemetry showed it giving away free cards at the worst
    // rate in the fleet.
    //
    // V35 (2026-09-02): the numbers come from HorseVariantProfile, one row per
    // game, so PLO4/5/6 no longer share one bluff trim (six cards connect with
    // every board; the bluff volume drops with each card), fixed limit gets
    // the overlay it never had (bluffs do not work at one-bet-into-six), and
    // the Omaha "tighten 1.03" is GONE: PLO plays MORE hands than hold'em, not
    // fewer, and the preflop width now lives in the same profile as a bar
    // shift instead of a multiplier fighting the quantile map.
    const vpost = variantPostflopProfile(gs.gameVariant);
    if (opts.v8 !== false) {
      params.bluffFreq *= vpost.bluffMul;
      params.slowplayFreq *= vpost.slowplayMul;
      params.checkRaiseFreq *= vpost.checkRaiseMul;
      params.tightness *= vpost.tightnessMul;
      params.callRespect = vpost.callRespect;
      if (styleName === 'balanced') {
        params.slowplayFreq = Math.min(params.slowplayFreq, 0.14);
      }
    }
    // THE VPIP FLOOR (Dan 2026-09-04): widen toward the table's floor. Last,
    // so it scales whatever style, mood and variant already decided.
    //
    // TELEMETRY (2026-09-05). The layer shipped in #3034 with none, so on
    // 2026-09-05 the daily audit could see `decide` firing 6,950,276 times and
    // could not answer whether this layer had ever run - the telemetry_dark
    // case the audit calls top priority, and the reason it took an outcome
    // measurement on ca_hand_facts to establish the layer worked at all.
    // Three counters, because the interesting failures are distinguishable:
    // `_prior` means it is steering with no sample yet, `_closing` means the
    // loop is reading the horse's own judged VPIP and still widening, and
    // `_satisfied` means the horse is over the floor and its own style is
    // back in charge. A floored table showing only `_prior` for ever means
    // ownVpip is not reaching the brain.
    {
      const vfMul = vpipFloorMul(gs);
      params.tightness *= vfMul;
      if (telemetryOn(opts) && Number(gs.vpipFloor ?? 0) > 0) {
        noteFire('vpip_floor');
        const own = gs.ownVpip;
        if (!own || own.hands < 3 || own.vpip === null || !Number.isFinite(own.vpip)) {
          noteFire('vpip_floor_prior');
        } else if (vfMul < 1) {
          noteFire('vpip_floor_closing');
        } else {
          noteFire('vpip_floor_satisfied');
        }
        // Pinned at its limit means the floor is unreachable by widening -
        // the state every Madness table was in before the floors were
        // retiered to 30/50. If this fires in volume, a floor is set above
        // what any strategy reaches and the table churns rather than runs.
        if (vfMul <= 0.35) noteFire('vpip_floor_clamped');
      }
    }

    // V18: per-horse sizing-family personality, hashed from the id.
    if (opts.v18Families !== false) {
      let fh = 5381;
      for (let i = 0; i < player.user_id.length; i++) {
        fh = ((fh << 5) + fh + player.user_id.charCodeAt(i)) >>> 0;
      }
      params.familyBias = ((fh >>> 7) % 1000) / 1000;
    }

    // V9: hourly mood gear-shift — a horse's bluff/aggression volume drifts
    // hour to hour the way a human's does. Zero-mean across the fleet.
    if ((opts.v9Mood ?? opts.v9) !== false) {
      const m01 = moodOf(player.user_id, opts.decisionTimeMs);
      params.bluffFreq *= 0.88 + 0.24 * m01;
      params.aggression *= 0.96 + 0.08 * m01;
    }

    const v7 = opts.v7 !== false;
    const tele = telemetryOn(opts);
    if (tele) {
      noteFire('decide');
      noteFire(`decide_${vi.isOmaha ? 'omaha' : vi.isShortDeck ? 'short_deck' : 'nlh'}`);
      if (isTournamentMode(gs)) {
        noteFire('decide_tournament');
        if (gs.stage === 'preflop') noteFire('decide_tournament_preflop');
      }
      if (isTournamentMode(gs) && gs.tournament?.schemaVersion === 1) {
        noteFire('phase6_tournament_context');
        if (gs.tournament.contextStatus === 'complete') {
          noteFire('phase6_tournament_context_complete');
        } else {
          noteFire('phase6_tournament_context_incomplete');
        }
        if (gs.tournament.m?.schemaVersion === 1) noteFire('phase6_m_engine');
      }
    }
    let decision: HorseDecision;
    if (gs.stage === 'preflop') {
      if (tele && (opts.v7Preflop ?? v7)) noteFire('preflop_v7');
      decision =
        (opts.v7Preflop ?? v7)
          ? this.decidePreflopV7Glue(player, gs, vi, params, opts)
          : this.decidePreflop(player, gs, vi, params);
    } else {
      decision = this.decidePostflop(
        player,
        gs,
        vi,
        params,
        opts.mind !== false,
        opts.streetIQ !== false,
        opts.handReading !== false,
        v7,
        opts
      );
    }

    // Legalize the heuristic/solver proposal first so its exact legal size is
    // one of Phase 7's candidates. Phase 7 then runs LAST: no mood, style,
    // threshold, chart or global ICM multiplier is allowed to overwrite its
    // action-specific tournament utility choice.
    decision = this.legalize(decision, player, gs, vi);
    const beforePhase10 = decision;
    const phase10 =
      gs.gameVariant === 'plo4' && opts.phase10Plo4 !== 'off'
        ? evaluatePlo4LivePolicy(
            player,
            gs,
            decision,
            phase10EquityEvidence,
            opts.phase10Plo4 ?? 'shadow',
            opts.phase10EvidenceMode && !tele ? () => 0 : undefined
          )
        : null;
    if (phase10) decision = this.legalize(phase10.decision, player, gs, vi);
    const phase11 =
      isOmahaPolicyVariant(gs.gameVariant) && opts.phase11Omaha !== 'off'
        ? evaluateOmahaVariantPolicy(
            player,
            gs,
            decision,
            null,
            opts.phase11Omaha ?? 'shadow',
            opts.phase11EvidenceMode && !tele ? () => 0 : undefined,
            phase11DecisionEquityCeiling ?? 1
          )
        : null;
    if (phase11) decision = this.legalize(phase11.decision, player, gs, vi);
    const phase12 =
      isRemainingPolicyVariant(gs.gameVariant) && opts.phase12Remaining !== 'off'
        ? evaluateRemainingVariantPolicy(
            player,
            gs,
            decision,
            null,
            opts.phase12Remaining ?? 'shadow',
            opts.phase12EvidenceMode && !tele ? () => 0 : undefined,
            phase12DecisionEquityCeiling ?? 1
          )
        : null;
    if (phase12) decision = this.legalize(phase12.decision, player, gs, vi);
    const variantPolicy = phase10 ?? phase11 ?? phase12;

    let phase8UtilityInput: TournamentUtilityInput | null = null;
    let phase8ReuseUtility: TournamentContinuationRunner | undefined;
    if (
      (opts.phase7Utility ?? true) !== false &&
      isTournamentMode(gs) &&
      gs.tournament?.schemaVersion === 1
    ) {
      const tournament = trustedTournamentContext(gs);
      const evidence7 = currentPhase7Equity();
      if (!tournament) {
        if (tele) noteFire('phase7_utility_skip_incomplete');
      } else if (
        gs.stateSchemaVersion === 1 &&
        Array.isArray(gs.legalActions) &&
        gs.legalActions.some((action) => action !== 'discard') &&
        Array.isArray(gs.pots) &&
        // Round 1 requires one coherent joint showdown sample per utility
        // branch.  The existing multi-board strategy still prices those
        // hands, but Phase 7 must not consume the independent per-board
        // samples as though they came from one shared-deck deal.  Keep the
        // baseline and expose the unavailable receipt until the later depth
        // pass supplies that sampler.  Guard here as well as at capture time:
        // preflop fixtures and restored hands can already carry extra boards.
        !(Array.isArray(gs.communityCards2) && gs.communityCards2.length > 0) &&
        !(Array.isArray(gs.communityCards3) && gs.communityCards3.length > 0) &&
        (gs.boardCount ?? 1) <= 1 &&
        evidence7
      ) {
        try {
          phase8UtilityInput = buildPhase7UtilityInput(
            gs,
            player,
            decision,
            vi,
            tournament,
            evidence7
          );
          const evaluation = evaluateTournamentUtilityDetailed(phase8UtilityInput);
          if (variantPolicy) {
            if (variantPolicy.receipt.mode === 'shadow' && variantPolicy.receipt.fired) {
              const shadowStart = performance.now();
              const shadow = evaluateTournamentUtilityDetailed({
                ...phase8UtilityInput,
                baseline: this.legalize(variantPolicy.proposal, player, gs, vi),
                showdownSamples: phase8UtilityInput.showdownSamples.slice(0, 32),
                withinBudget:
                  (opts.phase10EvidenceMode ||
                    opts.phase11EvidenceMode ||
                    opts.phase12EvidenceMode) &&
                  !tele
                    ? () => true
                    : () => performance.now() - shadowStart < 4,
              });
              variantPolicy.receipt.utilityLatencyMs = performance.now() - shadowStart;
              variantPolicy.receipt.utilityOwner = shadow.result
                ? 'phase7_evaluated'
                : 'phase7_unavailable';
              if (shadow.result) variantPolicy.receipt.shadowUtility = shadow.result.ledger;
              else
                variantPolicy.receipt.utilityUnavailableReason =
                  shadow.unavailableReason ?? 'unknown';
            } else {
              variantPolicy.receipt.utilityOwner = evaluation.result
                ? 'phase7_evaluated'
                : 'phase7_unavailable';
              if (!evaluation.result)
                variantPolicy.receipt.utilityUnavailableReason =
                  evaluation.unavailableReason ?? 'unknown';
            }
          }
          phase8ReuseUtility = evaluation.continuePostflop;
          const result = evaluation.result;
          if (result) {
            const selected = this.legalize(result.decision, player, gs, vi);
            const selectedAmount =
              typeof selected.amount === 'number' && Number.isFinite(selected.amount)
                ? selected.amount
                : null;
            if (
              selected.action !== result.ledger.selectedAction ||
              selectedAmount !== result.ledger.selectedAmount
            ) {
              // A utility receipt may never be relabeled as a different legal
              // action. Keep the already-legal baseline if this invariant is
              // ever violated and make the skipped arbiter observable.
              if (tele) {
                noteFire('phase7_utility_unavailable');
                noteFire('phase7_unavailable_legalizer_mismatch');
              }
            } else {
              decision = { ...selected, tournamentUtility: result.ledger };
              if (tele) {
                noteFire('phase7_tournament_utility');
                noteFire(`phase7_objective_${result.ledger.objective}`);
                noteFire(`phase7_icm_${result.ledger.icmMethod}`);
                if (result.ledger.overrodeBaseline) noteFire('phase7_utility_override');
                if (result.ledger.sidePotCount > 1) noteFire('phase7_side_pot');
                if (result.ledger.playersBehind.length > 0) noteFire('phase7_players_behind');
                if (result.ledger.objective === 'pko') noteFire('phase7_bounty_utility');
              }
            }
          } else if (tele) {
            noteFire('phase7_utility_unavailable');
            noteFire(`phase7_unavailable_${evaluation.unavailableReason ?? 'unknown'}`);
          }
        } catch (error) {
          reportError(error, 'HorseLogic.phase7_tournament_utility');
          if (variantPolicy) variantPolicy.receipt.utilityUnavailableReason = 'exception';
          if (tele) {
            noteFire('phase7_utility_unavailable');
            noteFire('phase7_unavailable_exception');
          }
        }
      } else if (tele && gs.legalActions?.some((action) => action !== 'discard')) {
        noteFire('phase7_utility_unavailable');
        const multiBoardUnavailable =
          (Array.isArray(gs.communityCards2) && gs.communityCards2.length > 0) ||
          (Array.isArray(gs.communityCards3) && gs.communityCards3.length > 0) ||
          (gs.boardCount ?? 1) > 1;
        noteFire(
          multiBoardUnavailable
            ? 'phase7_unavailable_multi_board'
            : evidence7
              ? 'phase7_unavailable_state_contract'
              : 'phase7_unavailable_equity_evidence'
        );
      }
    }
    if (
      (opts.phase8Postflop ?? 'shadow') !== 'off' &&
      isTournamentMode(gs) &&
      gs.stage !== 'preflop'
    ) {
      const disabledReason = tele ? liveHorsePhase8Safety.disabledReason : null;
      const phase8 = evaluateTournamentPostflop(
        player,
        gs,
        decision,
        disabledReason ? null : phase8UtilityInput,
        opts.phase8Postflop === 'candidate' ? 'candidate' : 'shadow',
        () => performance.now(),
        phase8ReuseUtility
      );
      if (disabledReason) phase8.ledger.reason = `disabled_${disabledReason}`;
      const proposed = this.legalize(phase8.decision, player, gs, vi);
      if (
        proposed.action !== phase8.decision.action ||
        proposed.amount !== phase8.decision.amount
      ) {
        phase8.ledger.applied = false;
        phase8.ledger.reason = 'illegal_candidate';
      } else decision = phase8.decision;
      decision = { ...decision, tournamentPostflop: phase8.ledger };
      if (tele) {
        liveHorsePhase8Safety.observe(phase8.ledger);
        noteFire('phase8_seen');
        noteDecisionMs('phase8', phase8.ledger.latencyMs);
        noteFire(`phase8_format_${gs.format ?? 'unknown'}`);
        noteFire(`phase8_reason_${phase8.ledger.reason}`);
        if (phase8.ledger.eligible) noteFire('phase8_eligible');
        if (phase8.ledger.fired) {
          noteFire('phase8_fired');
          noteFire(`phase8_objective_${phase8.ledger.objective}`);
        }
        if (phase8.ledger.changed) noteFire('phase8_shadow_changed');
        if (phase8.ledger.applied) noteFire('phase8_applied');
        else noteFire('phase8_baseline_retained');
        for (const reason of phase8.ledger.reasons) noteFire(`phase8_feature_${reason}`);
      }
    }
    if (phase10) {
      if (isTournamentMode(gs) && phase10.receipt.utilityOwner !== 'phase7_evaluated') {
        phase10.receipt.utilityOwner = 'phase7_unavailable';
        phase10.receipt.utilityUnavailableReason ??= 'context_or_equity_evidence_unavailable';
        if (phase10.receipt.mode === 'candidate') {
          decision = beforePhase10;
          phase10.receipt.applied = false;
        }
      }
      phase10.receipt.finalAction = decision.action;
      phase10.receipt.finalAmount = decision.amount ?? null;
      decision = { ...decision, plo4Policy: phase10.receipt };
      if (tele) {
        noteFire('phase10_seen');
        noteDecisionMs('phase10', phase10.receipt.latencyMs);
        noteFire(`phase10_reason_${phase10.receipt.reason}`);
        if (phase10.receipt.eligible) noteFire('phase10_eligible');
        if (phase10.receipt.fired) {
          noteFire('phase10_fired');
          noteFire(`phase10_street_${gs.stage}`);
        }
        if (phase10.receipt.changed) noteFire('phase10_shadow_changed');
        if (phase10.receipt.applied) noteFire('phase10_applied');
        else noteFire('phase10_baseline_retained');
        noteFire(`phase10_utility_${phase10.receipt.utilityOwner}`);
        if (phase10.receipt.utilityUnavailableReason)
          noteFire(`phase10_unavailable_utility_${phase10.receipt.utilityUnavailableReason}`);
      }
    }
    if (phase11) {
      if (isTournamentMode(gs) && phase11.receipt.utilityOwner !== 'phase7_evaluated') {
        phase11.receipt.utilityOwner = 'phase7_unavailable';
        phase11.receipt.utilityUnavailableReason ??= 'context_or_equity_evidence_unavailable';
        if (phase11.receipt.mode === 'candidate') {
          decision = beforePhase10;
          phase11.receipt.applied = false;
        }
      }
      phase11.receipt.finalAction = decision.action;
      phase11.receipt.finalAmount = decision.amount ?? null;
      decision = { ...decision, omahaVariantPolicy: phase11.receipt };
      if (tele) {
        noteFire('phase11_seen');
        noteFire(`phase11_variant_${phase11.receipt.variant}`);
        noteDecisionMs('phase11', phase11.receipt.latencyMs);
        noteDecisionMs(`phase11_${phase11.receipt.variant}`, phase11.receipt.latencyMs);
        noteFire(`phase11_${phase11.receipt.variant}_reason_${phase11.receipt.reason}`);
        if (phase11.receipt.eligible) noteFire(`phase11_${phase11.receipt.variant}_eligible`);
        if (phase11.receipt.fired) noteFire(`phase11_${phase11.receipt.variant}_fired`);
        noteFire(`phase11_reason_${phase11.receipt.reason}`);
        if (phase11.receipt.eligible) noteFire('phase11_eligible');
        if (phase11.receipt.fired) {
          noteFire('phase11_fired');
          noteFire(`phase11_street_${gs.stage}`);
        }
        if (phase11.receipt.changed) noteFire('phase11_shadow_changed');
        if (phase11.receipt.applied) noteFire('phase11_applied');
        else noteFire('phase11_baseline_retained');
        noteFire(`phase11_utility_${phase11.receipt.utilityOwner}`);
        if (phase11.receipt.utilityUnavailableReason)
          noteFire(`phase11_unavailable_utility_${phase11.receipt.utilityUnavailableReason}`);
      }
    }
    if (phase12) {
      if (isTournamentMode(gs) && phase12.receipt.utilityOwner !== 'phase7_evaluated') {
        phase12.receipt.utilityOwner = 'phase7_unavailable';
        phase12.receipt.utilityUnavailableReason ??= 'context_or_equity_evidence_unavailable';
        if (phase12.receipt.mode === 'candidate') {
          decision = beforePhase10;
          phase12.receipt.applied = false;
        }
      }
      phase12.receipt.finalAction = decision.action;
      phase12.receipt.finalAmount = decision.amount ?? null;
      decision = { ...decision, remainingVariantPolicy: phase12.receipt };
      if (tele) {
        noteFire('phase12_seen');
        noteFire(`phase12_variant_${phase12.receipt.variant}`);
        noteDecisionMs('phase12', phase12.receipt.latencyMs);
        noteDecisionMs(`phase12_${phase12.receipt.variant}`, phase12.receipt.latencyMs);
        noteFire(`phase12_${phase12.receipt.variant}_reason_${phase12.receipt.reason}`);
        if (phase12.receipt.eligible) noteFire(`phase12_${phase12.receipt.variant}_eligible`);
        if (phase12.receipt.fired) noteFire(`phase12_${phase12.receipt.variant}_fired`);
        noteFire(`phase12_reason_${phase12.receipt.reason}`);
        if (phase12.receipt.eligible) noteFire('phase12_eligible');
        if (phase12.receipt.fired) {
          noteFire('phase12_fired');
          noteFire(`phase12_street_${gs.stage}`);
        }
        if (phase12.receipt.changed) noteFire('phase12_shadow_changed');
        if (phase12.receipt.applied) noteFire('phase12_applied');
        else noteFire('phase12_baseline_retained');
        noteFire(`phase12_utility_${phase12.receipt.utilityOwner}`);
        if (phase12.receipt.utilityUnavailableReason)
          noteFire(`phase12_unavailable_utility_${phase12.receipt.utilityUnavailableReason}`);
      }
    }
    if (decision.action === 'fold' && beforePhase10.continuationGuard)
      decision = { ...decision, continuationGuard: beforePhase10.continuationGuard };
    const beforePhase13 = decision;
    const jointPolicy =
      opts.phase13Joint === 'off'
        ? null
        : evaluateJointLivePolicy(
            player,
            gs,
            decision,
            opts.phase13Joint ?? 'shadow',
            opts.phase13EvidenceMode && !tele ? () => 0 : undefined
          );
    if (jointPolicy) {
      let proposal = this.legalize(jointPolicy.proposal, player, gs, vi);
      if (isTournamentMode(gs)) {
        const tournament = trustedTournamentContext(gs);
        const joint = jointPolicy.jointEvidence;
        if (jointPolicy.receipt.fired && joint && tournament) {
          const utilityStarted = performance.now();
          try {
            const behind = new Set(jointPlayersBehind(player, gs));
            const moments = tournamentSampleEquity({
              hero: player,
              sampledOpponentIds: joint.opponentIds,
              showdownSamples: joint.samples,
            });
            const evidence: Phase7EquityEvidence = {
              ...moments,
              sampledOpponentIds: joint.opponentIds,
              showdownSamples: joint.samples,
              // The actual public-line distributions are in joint.ranges and
              // the scored samples; no invented calibrated percentile band.
              opponents: joint.opponentIds.map((userId) => ({
                userId,
                range: null,
                foldMul: 1,
                actsAfterHero: behind.has(userId),
              })),
            };
            const input = buildPhase7UtilityInput(gs, player, proposal, vi, tournament, evidence);
            input.settlement = {
              chipUnit: 1,
              dealerSeat: gs.dealerSeat!,
              splitLow: horseVariantRulesFor(gs.gameVariant).splitLow8OrBetter,
            };
            input.withinBudget =
              opts.phase13EvidenceMode && !tele
                ? () => true
                : () => performance.now() - utilityStarted < 4;
            const evaluated = evaluateTournamentUtilityDetailed(input);
            if (evaluated.result) {
              const selected = this.legalize(evaluated.result.decision, player, gs, vi);
              if (
                selected.action === evaluated.result.ledger.selectedAction &&
                (selected.amount ?? null) === evaluated.result.ledger.selectedAmount
              ) {
                proposal = selected;
                jointPolicy.receipt.shadowUtility = evaluated.result.ledger;
                jointPolicy.receipt.utilityOwner = 'phase7_evaluated';
                if (jointPolicy.receipt.mode === 'candidate')
                  decision = {
                    ...beforePhase13,
                    ...selected,
                    tournamentUtility: evaluated.result.ledger,
                  };
              } else {
                jointPolicy.receipt.utilityOwner = 'phase7_unavailable';
                jointPolicy.receipt.utilityUnavailableReason = 'legalizer_mismatch';
              }
            } else {
              jointPolicy.receipt.utilityOwner = 'phase7_unavailable';
              jointPolicy.receipt.utilityUnavailableReason =
                evaluated.unavailableReason ?? 'no_result';
            }
          } catch {
            jointPolicy.receipt.utilityOwner = 'phase7_unavailable';
            jointPolicy.receipt.utilityUnavailableReason = 'numerical_error';
          }
          jointPolicy.receipt.utilityLatencyMs = performance.now() - utilityStarted;
        } else {
          jointPolicy.receipt.utilityOwner = 'phase7_unavailable';
          jointPolicy.receipt.utilityUnavailableReason = 'context_or_joint_samples_unavailable';
        }
        if (jointPolicy.receipt.utilityOwner !== 'phase7_evaluated') proposal = beforePhase13;
      } else if (jointPolicy.receipt.mode === 'candidate' && jointPolicy.receipt.fired)
        decision = { ...beforePhase13, ...proposal };
      if (beforePhase13.action === 'fold' && beforePhase13.continuationGuard) {
        proposal = beforePhase13;
        decision = beforePhase13;
        jointPolicy.receipt.reason = 'protected_' + beforePhase13.continuationGuard;
      }
      const sameAction = (a: HorseDecision, b: HorseDecision) =>
        a.action === b.action && (!['bet', 'raise'].includes(a.action) || a.amount === b.amount);
      const receipt = jointPolicy.receipt;
      receipt.proposalAction = proposal.action;
      receipt.proposalAmount = proposal.amount ?? null;
      receipt.changed = !sameAction(proposal, beforePhase13);
      receipt.applied = !sameAction(decision, beforePhase13);
      receipt.finalAction = decision.action;
      receipt.finalAmount = decision.amount ?? null;
      for (const prior of [
        decision.plo4Policy,
        decision.omahaVariantPolicy,
        decision.remainingVariantPolicy,
      ])
        if (prior) {
          prior.finalAction = decision.action;
          prior.finalAmount = decision.amount ?? null;
        }
      decision = { ...decision, jointPolicy: receipt };
      if (tele) {
        noteFire('phase13_seen');
        noteFire(`phase13_variant_${receipt.variant}`);
        noteFire(`phase13_board_${receipt.boardCount}`);
        noteFire(`phase13_reason_${receipt.reason}`);
        noteFire(`phase13_${receipt.variant}_reason_${receipt.reason}`);
        if (receipt.utilityUnavailableReason)
          noteFire(`phase13_unavailable_utility_${receipt.utilityUnavailableReason}`);
        noteDecisionMs('phase13', receipt.latencyMs);
        noteDecisionMs(`phase13_${receipt.variant}`, receipt.latencyMs);
        if (receipt.utilityLatencyMs !== undefined)
          noteDecisionMs('phase13_utility', receipt.utilityLatencyMs);
        if (receipt.eligible) {
          noteFire('phase13_eligible');
          noteFire(`phase13_${receipt.variant}_eligible`);
        }
        if (receipt.fired) {
          noteFire('phase13_fired');
          noteFire(`phase13_${receipt.variant}_fired`);
          noteFire(`phase13_street_${gs.stage}`);
        }
        if (receipt.changed) noteFire('phase13_shadow_changed');
        noteFire(receipt.applied ? 'phase13_applied' : 'phase13_baseline_retained');
        noteFire(`phase13_utility_${receipt.utilityOwner}`);
      }
    }
    decision.thinkTime = this.computeThinkTime(
      decision,
      gs,
      params,
      toCall,
      (opts.v9Timing ?? opts.v9) !== false,
      player.user_id
    );
    return decision;
  }

  // ─────────────────────────────────────────────────────────────────────
  // PREFLOP
  // ─────────────────────────────────────────────────────────────────────

  /**
   * V7 glue: assemble the pure preflop context (strength, position, raiser
   * position, action counts, stack depth, ICM risk), call the HorsePreflop
   * intent engine, and legalize the intent against the engine's own rules.
   */
  private static decidePreflopV7Glue(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams,
    opts: HorseDecideOpts = {}
  ): HorseDecision {
    const bb = gs.bigBlind > 0 ? gs.bigBlind : 2;
    const trustedTournament = trustedTournamentContext(gs);
    const toCall = Math.max(0, gs.currentBet - player.bet);
    const effectiveCall = Math.min(toCall, player.stack);
    const contestablePot = Number.isFinite(gs.contestablePot)
      ? Math.max(0, gs.contestablePot as number)
      : Math.max(0, gs.pot - Math.max(0, toCall - effectiveCall));

    let strength: number;
    // PERCENTILE, not the raw Omaha score. decidePreflopV7's thresholds are
    // percentile-intent; the raw score's median is 0.24, so feeding it here
    // made every PLO hand read as trash and the fleet never opened a pot.
    // (Dan 2026-08-30 live PLO spin; see omahaPreflopPercentile.)
    if (vi.isOmaha) strength = omahaPreflopStrength(player.cards, vi.isHiLo);
    else if (player.cards.length === 3)
      strength = pineapplePreflopStrength(player.cards, vi.isShortDeck);
    else if (player.cards.length === 2)
      strength = vi.isShortDeck
        ? shortDeckPreflopStrength(player.cards[0], player.cards[1])
        : holdemPreflopScore(player.cards[0], player.cards[1], false);
    else strength = 0.3;
    strength = clamp01(strength + (fastRandom() * 0.06 - 0.03));

    const history = (gs.actionHistory || []).filter((a) => a.stage === 'preflop');
    let raises = 0;
    let limpers = 0;
    let callers = 0;
    /**
     * ═══ THE SQUEEZE COULD NOT BE SEEN (2026-09-01) ═══
     *
     * `callers` is reset by every raise, which is right for "how many people
     * have called THE CURRENT bet". But V18's squeeze test asked
     * `raises === 2 && callers >= 1`, and a squeeze is by definition
     * open -> call -> 3-BET: the 3-bet that creates the shape is the very
     * raise that zeroes the counter. At the moment the opener is asked to
     * respond, `callers` is always 0, so `squeezed` was UNSATISFIABLE in the
     * exact spot it was written for.
     *
     * It shipped 2026-08-26 and has never fired. The league said so from the
     * first run and nobody read it: `v18_squeeze_response` returns
     * 0.00 bb/100 with a stderr of 0.00 over 12,000 hands - not a small
     * effect, an IDENTICAL one, because the two arms play the same because
     * the flag never turns on. (The daily audit now flags that shape as
     * `league_matchup_inert`; this is the first bug it caught.)
     *
     * Saving the count before the reset is all that was needed: at the
     * instant the 3-bet lands, this holds the number of players who had
     * called the OPEN - which is the squeeze condition, stated correctly.
     */
    let callersOfPreviousRaise = 0;
    let lastRaiserSeat = -1;
    let firstRaiserSeat = -1;
    for (const a of history) {
      /**
       * ═══ V28 AUDIT FIX (2026-08-29): AN ALL-IN IS NEVER INVISIBLE ═══
       *
       * The old test was `a.action === 'all_in' && a.isFullRaise`, which made
       * a NON-full-raise all-in count as NEITHER a raise NOR a caller. It
       * still moves currentBet, so downstream `unopened` (raises===0 &&
       * currentBet<=1.05bb) was false too — an unhandled state that fell
       * through HorsePreflop's ladder into the "facing a 3-bet or bigger"
       * block. A 1.5bb open-shove was answered with top-7%-raise/top-25%-call
       * thresholds: the fleet folded KJ/A9/22 getting better than 5:1. This
       * fired on essentially every tournament short-stack under-shove.
       *
       * HandController's flag is the discriminator (HandController.ts:836-848):
       *   isFullRaise === true       the all-in is a full raise
       *   isFullRaise === false      it RAISED currentBet but under the min
       *   isFullRaise === undefined  it did NOT exceed currentBet: a call-off
       *
       * For ROUTING (is the pot opened, how many raises), anything that moved
       * the bet is a raise; a call-off is a caller. The full-raise distinction
       * matters for re-opening the betting, which is the engine's job, not
       * range routing's.
       */
      const isAggr =
        a.action === 'raise' ||
        a.action === 'bet' ||
        (a.action === 'all_in' && a.isFullRaise !== undefined);
      if (isAggr) {
        raises++;
        callersOfPreviousRaise = callers; // the squeeze shape, before the reset
        callers = 0; // callers-of-THE-raise reset when a new raise lands
        if (firstRaiserSeat < 0) firstRaiserSeat = a.seat;
        lastRaiserSeat = a.seat;
      } else if (a.action === 'call' || a.action === 'all_in') {
        // an all-in call-off (isFullRaise undefined) is a caller of the price
        if (raises === 0) limpers++;
        else callers++;
      }
    }
    // ═══ V18 STRADDLE FIX (widened by the V28 audit, 2026-08-29) ═══
    // A UTG straddle posts 2xBB WITHOUT an ActionRecord, so the history-empty
    // fallback below used to read every straddled pot as an open raise and
    // the fleet folded to dead money.
    //
    // The original gate ALSO required history.length === 0 — but the engine
    // records EVERY action including folds, so only the FIRST actor ever saw
    // the pot as unopened. After one fold or limp, `raises` was 0 with
    // currentBet at 2bb, `unopened` came out false, and every later seat fell
    // through to the "facing a 3-bet" thresholds: 5 of 6 seats at a straddle
    // table folded ~75% of hands to dead money — the exact bug V18 was
    // written to fix, still live for everyone but the first actor. A
    // straddled pot stays unopened until someone actually RAISES, however
    // many folds or limps came first (any real raise over a 2bb straddle is
    // at least 4bb, so the <= 2.2bb shape test still separates the cases).
    const straddleUnopened =
      (opts.v18Straddle ?? true) !== false &&
      gs.straddleActive === true &&
      raises === 0 &&
      gs.currentBet > bb * 1.05 &&
      gs.currentBet <= bb * 2.2;
    if (straddleUnopened) {
      if (telemetryOn(opts)) noteFire('v18_straddle');
    } else if (history.length === 0 && gs.currentBet > bb * 1.05) {
      raises = gs.currentBet > bb * 4.5 ? 2 : 1;
    }

    const phase6DealtRoster = gs.tournament?.schemaVersion === 1;
    const position = classifyPosition(
      player.seat,
      gs.dealerSeat,
      gs.players,
      opts.v13 !== false,
      phase6DealtRoster
    );
    const raiserPosition: PreflopPosition | null =
      lastRaiserSeat >= 0
        ? classifyPosition(
            lastRaiserSeat,
            gs.dealerSeat,
            gs.players,
            opts.v13 !== false,
            phase6DealtRoster
          )
        : null;
    // V13: a sitting-out player counted as an opponent, so a two-handed table
    // with one sitter reported oppsLeft = 2 and switched OFF the heads-up and
    // blind-vs-blind ranges entirely — the SB opened on 0.44 instead of 0.24
    // and the BB defended on 0.54 instead of 0.30. Postflop already did this.
    const oppsLeft = gs.players.filter(
      (p) => !p.is_folded && p.seat !== player.seat && (opts.v13 === false || !p.is_sitting_out)
    ).length;

    // Phase 7 needs one range-conditioned equity observation before any
    // solver/chart/atlas early return. The legacy preflop policy still
    // proposes the baseline; this observation lets the final tournament
    // arbiter price that baseline against every other legal action.
    if (
      (opts.phase7Utility ?? true) !== false &&
      gs.stateSchemaVersion === 1 &&
      isTournamentMode(gs) &&
      oppsLeft > 0 &&
      trustedTournament?.schemaVersion === 1 &&
      trustedTournament.contextStatus === 'complete'
    ) {
      try {
        const useMind7 = opts.mind !== false;
        const bands7 = useMind7
          ? HorseMind.bandsForOpponents(
              player.seat,
              gs.players,
              gs.actionHistory,
              gs.bigBlind,
              (opts.v7SizeReads ?? opts.v7) !== false
            )
          : undefined;
        const deckSize7 = vi.isShortDeck ? 36 : 52;
        const opponentCards7 = Math.max(2, vi.isOmaha ? vi.holeCount : player.cards.length);
        const maxByDeck7 = Math.max(
          1,
          Math.floor((deckSize7 - player.cards.length - 5) / opponentCards7)
        );
        const sampledOpponents7 = Math.max(1, Math.min(oppsLeft, maxByDeck7));
        const requestedSamples7 = Math.max(160, Math.min(320, vi.iterations));
        const outcomes7: HorseEquityOutcomeCollector = {
          maxSamples: phase7OutcomeBudget(trustedTournament.playersLeft),
          samples: [],
        };
        const equity7 = simulateEquity(
          player.cards,
          [],
          sampledOpponents7,
          vi,
          requestedSamples7,
          bands7,
          false,
          undefined,
          undefined,
          outcomes7
        );
        capturePhase7Equity(gs, player, equity7, equitySampleSizeOfLastCall(), bands7, useMind7, [
          outcomes7,
        ]);
      } catch (error) {
        reportError(error, 'HorseLogic.phase7_preflop_equity');
        phase7EquityEvidence = null;
        phase10EquityEvidence = null;
        phase11DecisionEquityCeiling = null;
        phase12DecisionEquityCeiling = null;
      }
    }
    const stackBB = player.stack / bb;
    const heroPreviouslyActed = history.some(
      (action) =>
        action.seat === player.seat && action.action !== 'fold' && action.action !== 'check'
    );
    const heroWasInitialRaiser = firstRaiserSeat === player.seat;
    const squeezed =
      (opts.v18Squeeze ?? true) !== false &&
      raises === 2 &&
      callersOfPreviousRaise >= 1 &&
      heroWasInitialRaiser;

    // Phase 6 exact tournament coordinate. The schema gate preserves every
    // older/offline fixture; every live tournament worker snapshot is v1.
    const phase6 = (() => {
      const tournament = gs.tournament;
      if (!isTournamentMode(gs) || tournament?.schemaVersion !== 1 || !tournament.m) return;
      // A schema-v1 live snapshot is built from HandController.state.players,
      // which is already the dealt roster. A player who disconnects or folds
      // remains part of the positional ring for this hand.
      const dealtInSeats = gs.players.map((candidate) => candidate.seat);
      const heroPosition = tournamentPositionForSeat(player.seat, gs.dealerSeat, dealtInSeats);
      const exactRaiserPosition =
        lastRaiserSeat >= 0
          ? tournamentPositionForSeat(lastRaiserSeat, gs.dealerSeat, dealtInSeats)
          : null;
      // A player whose blind consumed a short stack is marked is_all_in but
      // made no strategic all-in action. Count only seats with an actual
      // preflop all-in record, otherwise two forced blinds can manufacture a
      // multiway-all-in node and suppress a profitable price-in call.
      const voluntaryAllInSeats = new Set(
        history.filter((action) => action.action === 'all_in').map((action) => action.seat)
      );
      const imminentLevel =
        typeof tournament.nextBlindInMin === 'number' &&
        tournament.nextBlindInMin <= 3 &&
        (tournament.nextBlindMult ?? 1) > 1.15;
      const branchMZone = imminentLevel
        ? tournamentMZone(
            Math.min(tournament.m.effectiveM, tournament.m.projectedEffectiveM),
            tournament.m.zone
          )
        : tournament.m.zone;
      const branch = classifyTournamentPreflopBranch({
        raises,
        limpers,
        callers,
        callersOfPreviousRaise,
        opponentsAllIn: gs.players.filter(
          (candidate) =>
            candidate.seat !== player.seat &&
            !candidate.is_folded &&
            !candidate.is_sitting_out &&
            candidate.is_all_in &&
            voluntaryAllInSeats.has(candidate.seat)
        ).length,
        opponentsLeft: oppsLeft,
        stackBB,
        mZone: branchMZone,
        heroPosition,
        raiserPosition: exactRaiserPosition,
        heroPreviouslyActed,
        heroWasInitialRaiser,
        squeezed,
      });
      const gameFamily = vi.isOmaha
        ? ('omaha' as const)
        : !vi.isShortDeck && vi.holeCount === 2 && !vi.isFixedLimit
          ? ('nlh' as const)
          : ('other' as const);
      const heroTotalStack = Math.max(0, player.stack + player.bet);
      const policyOpponent =
        lastRaiserSeat >= 0
          ? gs.players.find(
              (candidate) =>
                candidate.seat === lastRaiserSeat &&
                !candidate.is_folded &&
                !candidate.is_sitting_out
            )
          : undefined;
      // A response range is indexed by the stack that can actually be won or
      // lost against the current aggressor, not by hero's stack in isolation.
      // Unopened nodes retain hero depth because there is no opposing actor.
      const effectivePolicyDepthBB =
        policyOpponent && bb > 0
          ? Math.min(heroTotalStack, Math.max(0, policyOpponent.stack + policyOpponent.bet)) / bb
          : heroTotalStack / bb;
      const policy = tournamentPreflopPolicy({
        gameFamily,
        contextStatus: tournament.contextStatus ?? 'incomplete',
        tableSize:
          tournament.playersAtTable ??
          gs.players.filter((candidate) => !candidate.is_sitting_out).length,
        heroPosition,
        raiserPosition: exactRaiserPosition,
        anteType:
          tournament.anteType ??
          (gs.bigBlindAnte === true ? 'big_blind' : (gs.ante ?? 0) > 0 ? 'per_player' : 'none'),
        branch,
        stackBB: effectivePolicyDepthBB,
        m: tournament.m,
      });
      if (telemetryOn(opts)) {
        noteFire('phase6_tournament_preflop');
      }
      return { policy, m: tournament.m };
    })();

    let phase6RouteNoted = false;
    const notePhase6Route = (route: 'atlas' | 'solver' | 'variant_fallback'): void => {
      if (!phase6 || phase6RouteNoted || !telemetryOn(opts)) return;
      phase6RouteNoted = true;
      noteFire(`phase6_route_${route}`);
      noteFire(`phase6_branch_${phase6.policy.branch}`);
      if (route === 'atlas') {
        noteFire(
          `phase6_atlas_${
            phase6.policy.source === 'deterministic_baseline' ? 'baseline' : 'fallback'
          }`
        );
      }
    };

    // ═══ V27 GTO CHARTS (Dan 2026-08-29) ══════════════════════════════════
    // "THEY'RE NOT JUST GUESSING — THEY HAVE SPECIFIC GTO RENDERED PLAYS."
    // Short-stack hold'em preflop consults the PioSolver charts before any
    // heuristic runs. Hold'em only (the 169 classes assume a full deck), no
    // straddle (the charts don't model one — V18 owns those pots), and
    // authoritative only where the chart answers the WHOLE question: an
    // unopened jam-or-fold at <=15bb, and the BB's call-off against an SB
    // all-in at <=25bb. Everything else falls through unchanged, and so does
    // everything when the loader has not hydrated — gtoOpenJam/gtoBbVsSbJam
    // return null on an empty store and yesterday's heuristics decide.
    if (
      (opts.v27GtoCharts ?? true) !== false &&
      player.cards.length === 2 &&
      !vi.isOmaha &&
      !vi.isShortDeck &&
      // V35: the charts are NO-LIMIT push/fold — a fixed-limit game has no
      // jam to consult them for.
      !vi.isFixedLimit &&
      gs.straddleActive !== true
    ) {
      const hand = gtoHandClass(player.cards[0], player.cards[1]);
      // CASH ANTES (Dan 2026-09-02): a cash table with an ante has dead money
      // in every pot exactly as a tournament does, and the push/fold charts
      // that model dead money are the Tournament ones. A cash chart at an
      // ante table would jam too tight for the pot it is jamming into.
      const tourney = isTournamentMode(gs) || (gs.ante ?? 0) > 0;

      // Chart positions are UTG/MP/CO/BTN/SB. classifyPosition collapses the
      // last two non-blind seats into 'late'; the dealer seat tells BTN from
      // CO exactly, so nothing is guessed.
      const chartPos =
        position === 'sb'
          ? 'SB'
          : position === 'early'
            ? 'UTG'
            : position === 'middle'
              ? 'MP'
              : position === 'late'
                ? player.seat === gs.dealerSeat
                  ? 'BTN'
                  : 'CO'
                : null;

      // V28 audit fixes to both cases:
      // - depth INCLUDES the posted blind. player.stack is chips BEHIND, so a
      //   10bb BB read as 9bb and every chart snapped one level shallow. The
      //   all-in a chart prices is blind + stack.
      // - CASE A additionally requires that nobody is already all-in. The
      //   open-jam chart prices FOLD EQUITY against players yet to act; a
      //   player already all-in has none to give, so that spot is a call-off,
      //   never an "open".
      const chartDepthBB = (player.stack + player.bet) / bb;
      const someoneAllInAhead = history.some((a) => a.action === 'all_in');

      // CASE A — folded to hero, push/fold zone: the chart decides the open.
      if (
        raises === 0 &&
        limpers === 0 &&
        callers === 0 &&
        !someoneAllInAhead &&
        chartPos !== null &&
        toCall <= bb &&
        chartDepthBB <= 15
      ) {
        const advice = gtoOpenJam({
          isTournament: tourney,
          position: chartPos,
          stackBB: chartDepthBB,
          hand,
        });
        if (advice) {
          if (telemetryOn(opts)) noteFire('v27_gto_open_jam');
          // ═══ V48 PERSONA: gtoAdherence ═══════════════════════════════════
          // Not every player takes the chart every time, and a fleet where
          // every seat plays the identical solver line at 12bb is a fleet
          // that reads as one player. A horse's adherence is authored (0.80
          // to 1.00 by default, deterministic in its id); below 1 it
          // sometimes declines the consult and answers with its own read -
          // deterministically in (horse, hand, spot), so a replayed hand
          // answers the same way twice and one hand can deviate on one node
          // and follow the chart on the next.
          const adh48 = params.gtoAdherence ?? 1;
          // The hand's identity: the first action's timestamp is stable
          // across every decision in the hand and different between hands -
          // the same key HorseMind uses to dedupe a replayed history.
          const hand48 = gs.actionHistory?.[0]?.timestamp ?? 0;
          if (
            adh48 < 1 &&
            !followsSolver(player.user_id, hand48, `openjam:${chartDepthBB}`, adh48)
          ) {
            if (telemetryOn(opts)) noteFire('v48_gto_deviation');
          } else {
            // The chart gives the mixed strategy; the horse rolls it. A 77%
            // jam is jammed 77% of the time, not rounded to always.
            const pushProb = advice.action === 'push' ? advice.freq : 1 - advice.freq;
            if (fastRandom() < pushProb) {
              notePhase6Route('solver');
              return { action: 'all_in', thinkTime: 0 };
            }
            // SB folding still surrenders the small blind; check when free.
            if (toCall <= 0) {
              notePhase6Route('solver');
              return { action: 'check', thinkTime: 0 };
            }
            notePhase6Route('solver');
            return { action: 'fold', thinkTime: 0 };
          }
        }
      }

      // CASE B — BB facing an SB all-in: call or fold IS the whole decision,
      // so the chart answers at any charted depth. Effective stack is the
      // smaller side: calling 25bb against an 8bb jam is an 8bb decision.
      // V34 (2026-09-02): `raises >= 1` let the chart answer an SB jam that
      // was a 3-BET over an open (UTG opened, SB shoved, UTG folded) — the
      // sb_push chart prices an SB open-jam into an unopened pot, a far wider
      // range than a reshove over a raise, so the BB called those off too
      // wide. The chart answers only the spot it was solved for.
      if (position === 'bb' && raises === 1 && raiserPosition === 'sb' && oppsLeft === 1) {
        const raiserAllIn = history.some((a) => a.seat === lastRaiserSeat && a.action === 'all_in');
        if (raiserAllIn && toCall > 0) {
          // currentBet is the SB's total commitment — an all-in, so his stack.
          // Hero's side includes the posted big blind (V28): the decision is
          // about hero's whole 10bb, not the 9bb behind the blind.
          const effectiveBB = Math.min(chartDepthBB, gs.currentBet / bb);
          const advice = gtoBbVsSbJam({ isTournament: tourney, effectiveBB, hand });
          if (advice) {
            if (telemetryOn(opts)) noteFire('v27_gto_bb_defend');
            const callProb = advice.action === 'call' ? advice.freq : 1 - advice.freq;
            if (fastRandom() < callProb) {
              notePhase6Route('solver');
              return { action: 'call', amount: Math.min(toCall, player.stack), thinkTime: 0 };
            }
            notePhase6Route('solver');
            return { action: 'fold', thinkTime: 0 };
          }
        }
      }
    }

    // ═══ V38 THE ALL-IN CALL IS ARITHMETIC (solverless games, preflop) ═══
    // The push/fold charts answer hold'em; Omaha, short deck and pineapple
    // faced a preflop jam with a strength bar. The bar is a percentile, the
    // jam is a price: the call is right exactly when equity against the
    // JAMMER'S range clears the pot odds plus the survival premium charged on
    // the share of stack at risk. The range is the mind's read of the jammer
    // (position, tendencies), sampled by the same Monte Carlo the postflop
    // decision uses, on an empty board. Only for a wager that commits a
    // real share of the stack (>= 40%) or comes from a player who is all-in;
    // smaller raises keep the calibrated range play below.
    if (
      (opts.v38Ev ?? true) !== false &&
      toCall > 0 &&
      (vi.isOmaha || vi.isShortDeck || vi.holeCount !== 2 || vi.isFixedLimit) &&
      lastRaiserSeat >= 0 &&
      gs.allInOrFold !== true
    ) {
      const raiser38 = gs.players.find((p) => p.seat === lastRaiserSeat);
      const raiserAllIn38 = raiser38?.is_all_in === true;
      const effCall38 = Math.min(toCall, player.stack);
      if (raiser38 && (raiserAllIn38 || effCall38 >= player.stack * 0.4)) {
        try {
          const bands38 =
            opts.mind !== false
              ? HorseMind.bandsForOpponents(
                  player.seat,
                  gs.players,
                  gs.actionHistory,
                  bb,
                  true,
                  null
                )
              : undefined;
          const live38 = gs.players.filter(
            (p) => !p.is_folded && !p.is_sitting_out && p.seat !== player.seat
          ).length;
          // The money hero is up against: the jammer and whoever has already
          // matched the price (or is all-in). Players still to act behind are
          // not in the pot yet — pricing against them would fold a call that
          // is right against the one stack actually shoving.
          const inPot38 = gs.players.filter(
            (p) =>
              !p.is_folded &&
              !p.is_sitting_out &&
              p.seat !== player.seat &&
              (p.is_all_in || (isFinite(p.bet) && p.bet >= gs.currentBet * 0.99))
          ).length;
          const eq38 = simulateEquity(
            player.cards,
            [],
            Math.max(1, Math.min(inPot38, 3)),
            vi,
            Math.max(160, Math.floor(vi.iterations * 0.8)),
            bands38,
            false
          );
          const pot38 = Math.max(0.01, contestablePot);
          const riskAdd38 = icmRisk(gs, stackBB, opts.v16Icm !== false, opts.v23Endgame !== false);
          const share38 = Math.min(1, effCall38 / Math.max(1, player.stack));
          const rake38 =
            (opts.v10Rake ?? opts.v10) !== false && !isTournamentMode(gs)
              ? rakeDrag(
                  pot38,
                  bb,
                  gs.rakeConfig,
                  gs.players.filter((candidate) => !candidate.is_sitting_out).length
                )
              : 0;
          // Omaha's range read narrows by score percentile, which cannot see
          // domination (four napkins keep 44% against the sampled "3-bet
          // range" in PLO6; against the real one it is nearer 35%). The price
          // carries a margin for that, growing with the hole count.
          const dominationMargin38 = vi.isOmaha ? 0.04 + 0.02 * Math.max(0, vi.holeCount - 4) : 0;
          const required38 = Math.min(
            0.99,
            effCall38 / ((pot38 + effCall38) * (1 - rake38)) +
              riskAdd38 * Math.sqrt(share38) +
              dominationMargin38
          );
          if (telemetryOn(opts)) noteFire('v38_preflop_allin_price');
          const gap38 = eq38 - required38;
          const callIt = Math.abs(gap38) <= 0.015 ? fastRandom() < 0.5 + gap38 / 0.03 : gap38 > 0;
          if (callIt) {
            // Clearly ahead of the price with chips behind and others still
            // to act: put them in, so nobody gets a cheap look.
            if (gap38 >= 0.12 && player.stack > effCall38 * 1.5 && live38 > 1) {
              notePhase6Route('variant_fallback');
              return { action: 'all_in', thinkTime: 0 };
            }
            notePhase6Route('variant_fallback');
            return { action: 'call', amount: Math.min(toCall, player.stack), thinkTime: 0 };
          }
          notePhase6Route('variant_fallback');
          return { action: 'fold', thinkTime: 0 };
        } catch {
          /* the price read is best-effort; the range play below decides */
        }
      }
    }

    // V12 ANTI-EXPLOIT: is the raiser hunting THIS horse? Best-effort.
    let targeted = 0;
    // V13: this is the V12 anti-exploit layer (PR #268) but it was gated on
    // v11, so `v12:false` did not disable it and `v11:false` silently killed
    // it — every V12 ablation, including the v12_ranges_river league matchup,
    // was therefore measuring the wrong thing.
    if (opts.mind !== false && opts.v12 !== false && lastRaiserSeat >= 0) {
      try {
        const raiser = gs.players.find((p) => p.seat === lastRaiserSeat);
        if (raiser && raiser.user_id !== player.user_id) {
          targeted = HorseMind.targetingOf(player.user_id, raiser.user_id);
        }
      } catch {
        /* targeting is best-effort */
      }
    }

    // V16 DEEP READS: the raiser's observed fold-to-3-bet, when the mind is
    // live and a qualifying sample exists.
    let raiserF3b: number | null = null;
    if (opts.mind !== false && opts.v16Reads !== false && lastRaiserSeat >= 0) {
      try {
        const raiser = gs.players.find((p) => p.seat === lastRaiserSeat);
        if (raiser && raiser.user_id !== player.user_id) {
          raiserF3b = HorseMind.foldTo3BetOf(raiser.user_id);
          if (raiserF3b !== null && telemetryOn(opts)) noteFire('v16_reads_f3b');
        }
      } catch {
        /* reads are best-effort */
      }
    }

    const intent = decidePreflopV7({
      strength,
      position,
      raiserPosition,
      raises,
      limpers,
      callers,
      oppsLeft,
      toCall,
      currentBet: gs.currentBet,
      contestablePot,
      pot: gs.pot,
      bigBlind: bb,
      stack: player.stack,
      stackBB,
      tightness: params.tightness,
      bluffFreq: params.bluffFreq,
      aggression: params.aggression,
      slowplayFreq: params.slowplayFreq,
      sizingMultiplier: params.sizingMultiplier,
      isOmaha: vi.isOmaha,
      isPotLimit: vi.isPotLimit,
      riskAdd: icmRisk(gs, stackBB, opts.v16Icm !== false, opts.v23Endgame !== false),
      // NLH only: widening the iso range vs limpers is an NLH edge; PLO limped
      // pots play multiway/postflop where a wide iso bloats pots out of line.
      isoWiden: (opts.v10Iso ?? opts.v10) !== false && !vi.isOmaha ? 0.06 : 0,
      // V11: explicit game mode + ante awareness (undefined when disabled so
      // the preflop layer keeps exact legacy behavior in ablation runs).
      mode: opts.v11 !== false ? (isTournamentMode(gs) ? 'tournament' : 'cash') : undefined,
      anteInPlay: opts.v11 !== false && (gs.ante ?? 0) > 0,
      allInOrFold: gs.allInOrFold === true,
      // V20 M-ZONES: the real per-orbit cost needs the ante SIZE and the
      // table size, not just "an ante exists". Undefined when the layer is
      // ablated so the preflop engine keeps exact legacy behavior.
      // The ORBIT cost, resolved for the table's ante style. Previously this
      // shipped a per-player figure that HorsePreflop multiplied by the seat
      // count — which read a big-blind-ante structure as seat-count times too
      // expensive, collapsed M, and turned tournaments into jam-or-fold.
      anteOrbitBB:
        (opts.v20Mzone ?? true) !== false
          ? anteOrbitCostBB(
              gs.ante ?? 0,
              gs.players.filter((p) => !p.is_sitting_out).length,
              bb,
              gs.bigBlindAnte === true
            )
          : undefined,
      tableSize:
        (opts.v20Mzone ?? true) !== false
          ? gs.players.filter((p) => !p.is_sitting_out).length
          : undefined,
      // V21: deep-stack cash stack-off discipline.
      deepDiscipline: (opts.v21Deep ?? true) !== false,
      ploPriceDefense: (opts.v24PloDefense ?? true) !== false,
      // V25: PLO tournament play — the pot-limit commitment zone and its
      // consequences. Tournament-only by construction inside the engine.
      ploTourney: (opts.v25PloTourney ?? true) !== false,
      // ═══ V24 BOUNTY (PKO / mystery) ═══ a bounty is prize money attached
      // to a PLAYER and collected by busting them, so pots against opponents
      // hero COVERS are worth more than their chips. Nothing preflop knew
      // this existed before; icmRisk only trimmed its own premium slightly.
      ...(() => {
        const useV24 = (opts.v24Bounty ?? true) !== false;
        const bf = useV24 ? (trustedTournament?.bountyFactor ?? 0) : 0;
        if (!(bf > 0) || lastRaiserSeat < 0) return {};
        const raiser = gs.players.find((p) => p.seat === lastRaiserSeat);
        if (!raiser) return {};
        const heroBehind = player.stack + player.bet;
        const raiserTotal = (raiser.stack ?? 0) + (raiser.bet ?? 0);
        const covers = heroBehind > raiserTotal;
        if (telemetryOn(opts) && covers) noteFire('v24_bounty_pull');
        // ═══ V26 PRICE THE BUST IN BIG BLINDS ═══════════════════════════
        // V24 guessed from bountyFactor (a pool RATIO), which says nothing
        // about what one elimination actually pays. The chest inventory
        // does: the mean live chest IS the EV of a bust, and comparing it
        // to the pot in the same unit turns "there is a bounty" into a
        // number the thresholds can use.
        const t26 = trustedTournament;
        const useV26 = (opts.v26Prizes ?? true) !== false;
        // Cents -> chips is not a conversion the engine can make (real money
        // and tournament chips are different scales), so the bust is priced
        // RELATIVE to the average remaining bounty: a chest worth well above
        // the mean is worth chasing, one below it is not. Expressed as a
        // multiplier on the existing pull rather than a new currency.
        // V37: the two reads live in prizeLandscapeScale / headBountyScale so
        // the postflop call-off prices the same bust the preflop pull does.
        const meanCents = Math.max(0, t26?.mysteryMeanCents ?? t26?.meanBountyCents ?? 0);
        let bountyScale = prizeLandscapeScale(gs, useV26);
        if (telemetryOn(opts) && useV26 && meanCents > 0) noteFire('v26_prize_read');
        // The head on THIS raiser: a bounty three times the field mean pulls
        // three times as hard; a small one barely at all.
        const head = headBountyScale(gs, raiser.user_id);
        if (head !== 1 && telemetryOn(opts)) noteFire('v37_head_bounty');
        bountyScale *= head;
        return {
          bountyFactor: Math.min(1, bf * bountyScale),
          coversRaiser: covers,
          // Live this hand: what the raiser has left behind their own raise
          // is already inside what hero would be putting in to call.
          raiserBustable: covers && (raiser.stack ?? 0) <= toCall,
        };
      })(),
      // V23 BLIND CLOCK: jam BEFORE the level halves the M, not after.
      nextBlindInMin:
        (opts.v23Endgame ?? true) !== false
          ? (trustedTournament?.nextBlindInMin ?? undefined)
          : undefined,
      nextBlindMult:
        (opts.v23Endgame ?? true) !== false ? trustedTournament?.nextBlindMult : undefined,
      // V12: table format — spins widen (3-max, shallow, high blind
      // pressure), HU SNGs ride the heads-up ranges. Not "winner-take-all
      // chip EV": at 10x and above a spin pays two or three places, and that
      // ladder is priced by icmRisk rather than here.
      // V13: `format` is a V12 field and now answers to the v12 flag.
      format:
        opts.v12 !== false ? (gs.format ?? (isTournamentMode(gs) ? 'mtt' : 'cash')) : undefined,
      targeted,
      raiserFoldTo3Bet: raiserF3b,
      // V18 STRADDLE: the shape the fallback above detected - hand the
      // truth to the preflop engine so its unopened branch owns the pot.
      // V28: the single source of truth computed above — unopened for EVERY
      // seat until someone raises, not only for the first actor.
      straddled: straddleUnopened,
      // V18 SQUEEZE: hero opened, at least one caller came along, and then
      // a 3-bet arrived - the classic squeeze shape. Squeeze ranges are
      // polarized toward air, so the opener defends wider.
      // Callers of the OPEN are captured before the squeeze resets `callers`.
      squeezed:
        (opts.v18Squeeze ?? true) !== false &&
        raises === 2 &&
        // Callers of the OPEN, counted before the 3-bet zeroed them. Reading
        // `callers` here is what made this branch dead code for six days.
        callersOfPreviousRaise >= 1 &&
        history.length > 0 &&
        (() => {
          for (const a of history) {
            if (a.action === 'raise' || a.action === 'bet') {
              return a.userId === player.user_id; // hero made the FIRST raise
            }
          }
          return false;
        })(),
      phase6,
      // V16 PLO POLARITY: AAxx is the premium the generic percentile cannot
      // see past double-counted side cards; rundowns without it flat more.
      omahaAA:
        (opts.v16PloPolar ?? true) !== false && vi.isOmaha
          ? player.cards.filter((hc) => hc.rank === 'A').length >= 2
          : undefined,
      v13: opts.v13 !== false,
      // V34: the button is not a second cutoff. classifyPosition merges the
      // two into 'late'; the dealer seat tells them apart exactly.
      isButton: gs.dealerSeat !== undefined && player.seat === gs.dealerSeat,
      // V35: the game's own preflop width (PLO wider opens, narrower 3-bets;
      // 6+ wider still; fixed limit widest). Rides the v8 variant flag.
      variantShift: opts.v8 !== false ? variantPreflopShift(gs.gameVariant) : undefined,
      // ═══ V46 (2026-09-05) ═══ the SHAPE of the hand, which the percentile
      // cannot see. AAxx double-suited is the 3-bet anchor, a rundown flats,
      // AAA-x is a fold the ladder rates highly. Hold'em returns the zero
      // read, so this is byte-identical outside Omaha and short deck.
      ...(() => {
        if ((opts.v46Charts ?? true) === false) return {};
        const read46 = handClassRead(player.cards, vi.isOmaha, vi.isShortDeck);
        if (read46.cls === 'other' || read46.cls === 'sd_other') return {};
        if (telemetryOn(opts)) {
          noteFire('v46_class_read');
          if (read46.foldAlways) noteFire('v46_class_fold');
          else if (read46.neverThreeBet) noteFire('v46_class_never_3bet');
        }
        return {
          classShift: read46.shift,
          classNeverThreeBet: read46.neverThreeBet,
          classFoldAlways: read46.foldAlways,
        };
      })(),
      // V37: preflop blockers — an ace or king in the hand.
      holdsAce: player.cards.some((hc) => hc.rank === 'A'),
      holdsKing: player.cards.some((hc) => hc.rank === 'K'),
      // V37: hero's own head — a big bounty gets called wider.
      ownHeadBounty:
        (opts.v24Bounty ?? true) !== false ? headBountyScale(gs, player.user_id) : undefined,
      // V37: the bubble is an exploit written into the payout table.
      bubblePressure: (() => {
        const bp = bubblePressure(
          gs,
          player,
          lastRaiserSeat,
          (opts.v37Satellite ?? true) !== false
        );
        if (bp > 0 && telemetryOn(opts)) noteFire('v37_bubble_pressure');
        return bp;
      })(),
      // V37: satellite survival / urgency / pressure (see satelliteRead).
      satellite: (() => {
        const sr = satelliteRead(gs, player, stackBB, (opts.v37Satellite ?? true) !== false);
        if (!sr.active) return undefined;
        if (telemetryOn(opts)) {
          noteFire(sr.locked ? 'v37_sat_locked' : sr.urgent ? 'v37_sat_urgent' : 'v37_sat_field');
        }
        return { locked: sr.locked, urgent: sr.urgent, coversAll: sr.coversAll };
      })(),
      rand: fastRandom,
    });
    notePhase6Route(
      phase6?.policy.fallbackReason === 'unsupported_variant' ? 'variant_fallback' : 'atlas'
    );
    // V20 proof-of-receipt: the M-zone wiring reached the preflop engine.
    if (telemetryOn(opts) && (opts.v20Mzone ?? true) !== false && isTournamentMode(gs) && bb > 0) {
      noteFire('v20_mzone_wired');
    }

    // ═══ PROOF OF RECEIPT for the pot-limit preflop sizer ═══
    // A layer that ships and never fires is the house failure mode here
    // (BrainTelemetry header). Every preflop raise in a pot-limit game is now
    // sized off the pot-limit ceiling, so this counter appearing in
    // horse_brain_telemetry is the receipt that the new path is the one the
    // fleet is actually running.
    if (intent.a === 'raiseTo' && vi.isPotLimit && telemetryOn(opts)) {
      noteFire('plo_pot_preflop_size');
    }

    switch (intent.a) {
      case 'jam':
        return { action: 'all_in', thinkTime: 0 };
      case 'check':
        return { action: 'check', thinkTime: 0 };
      case 'call':
        return { action: 'call', amount: toCall, thinkTime: 0 };
      case 'raiseTo':
        return this.raiseTo(intent.to ?? gs.currentBet * 3, player, gs, vi);
      case 'fold':
      default:
        return { action: 'fold', thinkTime: 0 };
    }
  }

  private static decidePreflop(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, bigBlind, pot } = gs;
    const bb = bigBlind > 0 ? bigBlind : 2;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const stackBB = stack / bb;
    const effectiveCall = Math.min(toCall, stack);
    const pricePot = Number.isFinite(gs.contestablePot)
      ? Math.max(0, gs.contestablePot as number)
      : Math.max(0, pot - Math.max(0, toCall - effectiveCall));

    // Hand strength 0..1 (percentile-style, variant-aware). Omaha goes
    // through its empirical CDF so it actually IS percentile-style — the
    // raw score is compressed (median 0.24) and broke every threshold here.
    let strength: number;
    if (vi.isOmaha) strength = omahaPreflopStrength(player.cards, vi.isHiLo);
    else if (player.cards.length === 3)
      strength = pineapplePreflopStrength(player.cards, vi.isShortDeck);
    else if (player.cards.length === 2)
      strength = vi.isShortDeck
        ? shortDeckPreflopStrength(player.cards[0], player.cards[1])
        : holdemPreflopScore(player.cards[0], player.cards[1], false);
    else strength = 0.3;

    // Small per-decision jitter creates mixed strategies at the boundaries.
    strength = clamp01(strength + (fastRandom() * 0.06 - 0.03));

    // Read the action so far this street.
    const history = (gs.actionHistory || []).filter((a) => a.stage === 'preflop');
    let raises = 0;
    let limpers = 0;
    let callers = 0;
    for (const a of history) {
      if (a.action === 'raise' || a.action === 'bet') raises++;
      else if (a.action === 'all_in' && a.isFullRaise) raises++;
      else if (a.action === 'call') {
        if (raises === 0) limpers++;
        else callers++;
      }
    }
    // Fallback when history is unavailable: infer from bet size.
    if (history.length === 0 && currentBet > bb * 1.05) {
      raises = currentBet > bb * 4.5 ? 2 : 1;
    }

    const position = classifyPosition(player.seat, gs.dealerSeat, gs.players);
    // Position-based open thresholds (percentile strength required)
    const OPEN_THRESH: Record<PositionClass, number> = {
      early: 0.62,
      middle: 0.54,
      late: 0.42,
      sb: 0.5,
      bb: 0.42,
    };
    /**
     * The floor for limping BEHIND another limper. Set at the single-raise
     * calling threshold on purpose: a hand that cannot call a raise has no
     * business putting a chip in, because the only thing it can do next is
     * fold. See the no-open-limp note in the unopened branch.
     */
    const LIMP_BEHIND_MIN = 0.5;
    const t = (x: number) => clamp01(x * params.tightness);

    const unopened = raises === 0 && currentBet <= bb * 1.05;

    // ── Short-stack push/fold (cash short stacks + tournament endgame) ──
    if (stackBB <= 12 && !vi.isOmaha) {
      if (unopened) {
        const jamThresh = position === 'late' || position === 'sb' ? 0.5 : 0.6;
        if (strength >= t(jamThresh)) return { action: 'all_in', thinkTime: 0 };
        if (toCall === 0) return { action: 'check', thinkTime: 0 };
        return { action: 'fold', thinkTime: 0 };
      }
      // Facing action short-stacked: jam or fold on real strength.
      if (strength >= t(raises >= 2 ? 0.85 : 0.72)) return { action: 'all_in', thinkTime: 0 };
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      if (toCall <= bb && strength >= 0.3) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }

    // ── Unopened pot (or limpers only) ──
    if (unopened) {
      const openThresh = t(OPEN_THRESH[position]) + Math.min(limpers, 3) * 0.03;
      if (strength >= openThresh) {
        // Occasionally trap with a true premium
        if (strength > 0.93 && fastRandom() < params.slowplayFreq * 0.4 && toCall <= bb) {
          if (toCall === 0) return { action: 'check', thinkTime: 0 };
          return { action: 'call', amount: toCall, thinkTime: 0 };
        }
        // ═══ POT LIMIT OPENS POT (Dan 2026-09-03) ═══ The V7 preflop layer
        // owns this decision live; this legacy path is the v7Preflop:false
        // fallback and ablation route, and it carried the SAME no-limit
        // ladder. Fixing one and not the other would leave a second path
        // producing 2x PLO opens, which is exactly the shape of bug that
        // makes a shipped fix look like it never landed.
        if (vi.isPotLimit) {
          return this.raiseTo(
            this.ploPreflopRaiseTo(gs, player, params, PLO_MIN_OPEN_BB * bb),
            player,
            gs,
            vi
          );
        }
        const sizeBB = (2.2 + fastRandom() * 0.8 + limpers * 1.0) * params.sizingMultiplier;
        return this.raiseTo(sizeBB * bb, player, gs, vi);
      }
      // Never fold for free.
      if (toCall === 0) return { action: 'check', thinkTime: 0 };

      // ═══ NO OPEN-LIMP (Dan 2026-08-30, binding) ═══
      //
      // First in, it is RAISE OR FOLD. Never call.
      //
      // What this replaced, and why. Two branches called here: one limped
      // any hand within 0.12 of the opening threshold 70% of the time, and
      // one limped ANY hand of strength >= 0.3 for up to 1.5bb from ANY
      // position, unconditionally. Neither asked whether anyone had actually
      // limped first, so both open-limped an unopened pot.
      //
      // Measured in production before this changed, over 596 tournament
      // hands in a 25-minute window:
      //
      //     open-limps                                852   (35% of all
      //     open-raises                               214    unraised
      //     open-folds                              1,098    first actions)
      //
      //     limps that then faced a raise             458
      //     of those, FOLDED                          419   (91.5%)
      //
      // Horses limped four times more often than they raised, and then gave
      // the chips up nine times out of ten. Limp-folding is the worst
      // preflop pattern in tournament poker: it forfeits the chance to win
      // the pot uncontested, builds a multiway pot with a hand too weak to
      // continue, and then surrenders.
      //
      // It is worse HERE than at a normal table because these tournaments
      // run a big blind ante. In hand #3761806 the ante was 1,200 on a 150
      // big blind, so the unopened pot already held 1,425 chips when it was
      // 150 to call. That dead money is what an open-raise plays for, and a
      // limp simply hands it to whoever raises behind - which is exactly
      // what happened: six limps, the big blind raised to 1,125, and five of
      // the six folded.
      //
      // LIMPING BEHIND survives, narrowly, because it is a real thing real
      // players do. Two conditions keep it honest:
      //   - somebody must have limped first (limpers >= 1), so this can
      //     never open a pot; and
      //   - the hand must be strong enough to CONTINUE against a raise. The
      //     single-raise branch below calls at roughly 0.52, so anything
      //     weaker would be limping in order to fold. That gate is the one
      //     that kills the 91.5%.
      // Because a hand at or above the opening threshold RAISES, the surviving
      // band is [LIMP_BEHIND_MIN, openThresh) - which is empty in late
      // position and from the blinds until several limpers widen it. Late
      // position isolating limpers instead of joining them is correct.
      const limpBehind =
        limpers >= 1 && strength >= LIMP_BEHIND_MIN && toCall <= bb && fastRandom() < 0.35;
      if (limpBehind) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }

    // ── Facing a single raise ──
    if (raises === 1) {
      const threeBetThresh = t(0.82 - (params.aggression - 1) * 0.08);
      const callThresh = t(0.52) + callers * 0.025 + (position === 'early' ? 0.04 : 0);
      const priceOK = toCall <= Math.max(bb * 12, stack * 0.12);
      const bbDiscount = position === 'bb' ? 0.06 : 0;

      if (strength >= threeBetThresh) {
        // Squeeze bigger when there are callers behind the raiser.
        if (strength > 0.95 && fastRandom() < params.slowplayFreq * 0.5 && callers === 0) {
          return { action: 'call', amount: toCall, thinkTime: 0 }; // trap
        }
        if (vi.isPotLimit) {
          return this.raiseTo(this.ploPreflopRaiseTo(gs, player, params), player, gs, vi);
        }
        const ip = position === 'late';
        const mult = (ip ? 3.0 : 3.8) + callers * 1.0 + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      // Light 3-bet mix from the right hands (suited playables, not pure junk)
      if (
        strength >= t(0.55) &&
        strength < threeBetThresh &&
        callers === 0 &&
        fastRandom() < params.bluffFreq * params.aggression * 0.35
      ) {
        if (vi.isPotLimit) {
          return this.raiseTo(this.ploPreflopRaiseTo(gs, player, params), player, gs, vi);
        }
        const ip = position === 'late';
        const mult = (ip ? 3.0 : 3.8) + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      if (strength >= callThresh - bbDiscount && priceOK) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // Big-blind price-in: closing the action getting a huge price
      if (position === 'bb' && toCall <= bb * 2.5 && strength >= 0.3) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      return { action: 'fold', thinkTime: 0 };
    }

    // ── Facing a 3-bet or bigger ──
    {
      const fourBetThresh = t(0.93 - (params.aggression - 1) * 0.04);
      const callThresh = t(0.78);
      if (strength >= fourBetThresh) {
        if (raises >= 3 || currentBet * 2.3 >= stack * 0.4) {
          return { action: 'all_in', thinkTime: 0 };
        }
        if (vi.isPotLimit) {
          return this.raiseTo(this.ploPreflopRaiseTo(gs, player, params), player, gs, vi);
        }
        const mult = 2.2 + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      if (strength >= callThresh && toCall <= stack * 0.35) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // Getting a monster price closing the action
      if (toCall > 0 && toCall <= pricePot * 0.15 && strength >= 0.45) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // POSTFLOP — equity-driven for every street and every variant
  // ─────────────────────────────────────────────────────────────────────

  private static decidePostflop(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams,
    useMind: boolean = true,
    useIQ: boolean = true,
    useHR: boolean = true,
    useV7: boolean = true,
    opts: HorseDecideOpts = {}
  ): HorseDecision {
    const useSizeReads = opts.v7SizeReads ?? useV7;
    // V12.3: barrel plans live in HorseMind.plans, so they must obey
    // `mind:false` like every other mind read/write. They did not, which meant
    // an ablation claiming to disable the mind still ran coherent multi-street
    // plans — and any caller running synthetic hands wrote plan keys into the
    // live map, whose 8000-key overflow wipes the barrel plan of every hand in
    // progress on every live table.
    const useBarrels = (opts.v7Barrels ?? useV7) && opts.mind !== false;
    const useCounterAdapt = opts.v7CounterAdapt ?? useV7;
    const useAdaptiveMC = opts.v7AdaptiveMC ?? useV7;
    const useV8 = opts.v8 !== false;
    const useHiLo = (opts.v8HiLo ?? useV8) && vi.isHiLo;
    const useDraws = (opts.v8Draws ?? useV8) && vi.isOmaha;
    const useNlhX = (opts.v8Nlh ?? useV8) && !vi.isOmaha;
    const useSizing = (opts.v9Sizing ?? opts.v9) !== false;
    const useTiming = (opts.v9Timing ?? opts.v9) !== false;
    // V10 strategy layer — each ablation flag defaults to the v10 master.
    const useCbet10 = (opts.v10Cbet ?? opts.v10) !== false;
    const useSpr10 = (opts.v10Spr ?? opts.v10) !== false;
    const useRake10 = (opts.v10Rake ?? opts.v10) !== false;
    const useThin10 = (opts.v10ThinValue ?? opts.v10) !== false;
    const { currentBet } = gs;
    const trustedTournament = trustedTournamentContext(gs);
    // PROOF OF RECEIPT: declared once, up front — several stamped blocks run
    // before the equity/risk section.
    const tele15 = telemetryOn(opts);
    /** V17: live non-all-in players acting AFTER hero this street (-1 = unknown). */
    let playersBehind17 = -1;
    /**
     * ═══ V28 AUDIT FIX — EFFECTIVE-STACK PRICING (2026-08-29) ═══
     *
     * THE LARGEST SINGLE LEAK THE POSTFLOP AUDIT FOUND. `toCall` was the
     * villain's FULL wager even when it dwarfed hero's stack. Facing a 500
     * jam with 50 behind and 100 in the middle, hero can only ever put in 50
     * and the excess comes back uncalled — the truth is "risk 50 to win 200",
     * required equity 25%. The code computed potOdds = 500/1100 = 45% and
     * then added commit premiums on top: horses folded CORRECT calls against
     * any opponent who covered them, worst on short stacks and tournament
     * bubbles. Every big-bet read (potFrac tells, overbet polarity, V16 tell,
     * catch-block, the V20 cap) misfired off the same inflated number, and
     * spr collapsed BECAUSE the opponent overbet, declaring hero committed on
     * the wrong premise.
     *
     * The preflop engine already did this right (HorsePreflop effCall);
     * postflop simply never did. `toCall` below is the EFFECTIVE call —
     * capped by stack — and `pot` has the uncallable excess stripped, so
     * every ratio downstream (potOdds, betRatio, potFrac, spr) prices the
     * money that can actually change hands. `legalize()` receives the raw
     * game state separately and is unaffected.
     */
    const rawToCall = Math.max(0, currentBet - player.bet);
    const toCall = Math.min(rawToCall, player.stack);
    const uncallableExcess = rawToCall - toCall;
    const pot = Math.max(
      0.01,
      Number.isFinite(gs.contestablePot)
        ? Math.max(0, gs.contestablePot as number)
        : gs.pot - uncallableExcess
    );
    const stack = player.stack;
    const facingBet = toCall > 0;
    const street: HandStage = gs.stage;
    const isRiver = street === 'river';
    const drawsLive = street === 'flop' || street === 'turn' || street === 'pineapple_discard';

    const opponents = gs.players.filter(
      (p) => !p.is_folded && p.seat !== player.seat && !p.is_sitting_out
    );
    const oppCount = Math.max(1, opponents.length);

    // ═══ V3: opponent intelligence ═══
    // Range reads from each live opponent's preflop line this hand, exploit
    // profile from their accumulated tendencies, board texture, blockers.
    let bands: Array<[number, number] | null> | undefined;
    let oppReads: Array<OppPostflopRead | null> | undefined;
    let exploit = { bluffMod: 1, callDownMod: 1, valueThinMod: 1 };
    let wetness = 0.35;
    let blocker = false;
    if (useMind) {
      try {
        // V5: full history feeds street-by-street range narrowing. The
        // hand-reading OFF branch (A/B harnesses) sees preflop lines only.
        const bandHistory = useHR
          ? gs.actionHistory
          : (gs.actionHistory || []).filter((a) => a.stage === 'preflop');
        // V7: size-aware narrowing + counter-adaptation recency blending.
        // V12: parallel postflop reads feed board-contact conditioning.
        if ((opts.v12Ranges ?? opts.v12) !== false && useHR) {
          oppReads = [];
        }
        void 0;
        bands = HorseMind.bandsForOpponents(
          player.seat,
          gs.players,
          bandHistory,
          gs.bigBlind,
          useSizeReads,
          gs.communityCards,
          oppReads
        );
        // V16 SIZE-CONDITIONED SAMPLING is a sampler behavior — disable by
        // stripping the flag the mind attached, so HorseEval needs no opts.
        if ((opts.v16SizeCond ?? true) === false && oppReads) {
          for (const r of oppReads) if (r) r.bigBet = false;
        }
        // V40 is a sampler behaviour too: without the flag the reads carry
        // no street count, no newest-bet size and no raise mark, so the
        // sampler takes the V15 board-contact branch exactly as before.
        if ((opts.v40Omaha ?? true) === false && oppReads) {
          for (const r of oppReads) {
            if (!r) continue;
            delete r.streets;
            delete r.lastFrac;
            delete r.raised;
          }
        }
        if (tele15) {
          if (bands && bands.some((b) => b !== null)) {
            noteFire(vi.isOmaha ? 'banded_mc_omaha' : 'banded_mc_nlh');
          }
          if (oppReads && oppReads.some((r) => r?.bigBet)) noteFire('v16_sizecond_bigbet');
        }
        exploit = HorseMind.tableExploit(player.seat, gs.players, useCounterAdapt);
        const tex = HorseMind.texture(gs.communityCards);
        wetness = tex.wetness;
        blocker = HorseMind.hasBlocker(player.cards, gs.communityCards);
      } catch {
        /* intelligence layer is best-effort — fall back to V2 behavior */
      }
    }

    // Real equity vs the opponents' READ RANGES (V3) — draws priced by runout.
    // V7: ADAPTIVE early exit — when the estimate is already far from every
    // decision threshold, stop sampling and bank the time.
    // V8 plo8: hi-lo decomposition rides along in the same MC loop.
    const hiLoSplit: HiLoSplit | undefined = useHiLo
      ? { hi: 0, lo: 0, scoop: 0, quarter: 0 }
      : undefined;
    /**
     * MULTI-BOARD EQUITY 2026-08-28 (Horses Are Players law): on a
     * double/triple-board bomb hand every board pays an equal share of every
     * pot layer, so the horse's true equity is the AVERAGE of its per-board
     * equities. The fleet used to price board 1 alone and systematically
     * misplayed the other half (or two-thirds) of the pot. The iteration
     * budget is split across boards so a bomb decision costs what a normal
     * decision always has. Texture/blockers/nut-status stay board-1 reads —
     * they steer style, not the money.
     *
     * PLO8 2026-08-28: the hi-lo decomposition is averaged per board too.
     * Passing `undefined` here (the first cut) left the accumulator at all
     * zeros on every multi-board hand, and the strategy below reads it —
     * `scoopy`, the quarter check and the V23 low-only branch all saw "no
     * hi, no lo" and played the hand as if it had no low potential at all.
     * Each board pays an equal share of every pot layer, so the mean of the
     * per-board hi/lo/scoop/quarter probabilities is exactly the right
     * expectation for the money.
     */
    const extraBoards: Card[][] = [];
    if (Array.isArray(gs.communityCards2) && gs.communityCards2.length >= 3) {
      extraBoards.push(gs.communityCards2);
    }
    if (Array.isArray(gs.communityCards3) && gs.communityCards3.length >= 3) {
      extraBoards.push(gs.communityCards3);
    }
    let equity: number;
    /**
     * ═══ V36 BOMB POTS (Dan 2026-09-02) ═══════════════════════════════════
     * "THERE IS PROBABLY ZERO SOLVER, OR LOGIC OR MATH BEHIND ANY OF IT,
     *  ESPECIALLY THE DOUBLE AND TRIPLE BOARD BOMB POTS."
     *
     * There was one thing: the per-board equity average above, which is the
     * exact expected pot share (each board pays 1/N of every layer). Every
     * OTHER read in this function - made-hand category, scare cards, nut
     * status, texture, blockers, the domination penalties - read BOARD ONE
     * and only board one, so on a double board a horse with the nut flush on
     * board two and nothing on board one was "a high card on a two-tone
     * board", and a horse with a lock on board one and air on board two
     * was a 55% medium hand that check-called.
     *
     * Two facts change the strategy, and both are pure arithmetic:
     *
     *  1. A LOCK ON ONE BOARD IS A FREEROLL. With N boards, a hand that
     *     cannot lose board b is guaranteed 1/N of every chip that goes in.
     *     Facing a bet B into a pot P0 with one board of two locked, calling
     *     returns at least (P0 + 2B)/2 = P0/2 + B >= B: folding can never be
     *     right, and raising costs nothing that does not come back. The hand
     *     RAISES for the chance to scoop or to fold out whatever was beating
     *     it on the other board; it never check-calls.
     *  2. A BLUFF MUST FOLD OUT EVERY BOARD. With random ranges and N boards
     *     somebody has connected somewhere on nearly every deal; bluff
     *     volume drops by half on two boards and by two-thirds on three.
     *
     * And the READS follow the money: the style board (category, scare, nut
     * status, texture, blockers, domination) is the board hero is STRONGEST
     * on, not board one by accident of dealing order.
     *
     * Bomb pots are also MULTIWAY by construction (everyone was dealt in), so
     * the Monte Carlo prices up to six live opponents instead of four - a
     * seven-way flop against four sampled hands overstates every equity.
     */
    const bomb36 = gs.bombPot === true;
    const captureOutcomes7 =
      (opts.phase7Utility ?? true) !== false &&
      gs.stateSchemaVersion === 1 &&
      isTournamentMode(gs) &&
      // Phase 7 Round 1 never zips independently sampled boards into a fake
      // joint deal. The existing audited multi-board layer remains authority
      // until one shared-deck sampler is added in the later depth round.
      extraBoards.length === 0 &&
      trustedTournament?.schemaVersion === 1 &&
      trustedTournament.contextStatus === 'complete';
    const deckSize7 = vi.isShortDeck ? 36 : 52;
    const opponentCards7 = Math.max(2, vi.isOmaha ? vi.holeCount : player.cards.length);
    const maxByDeck7 = Math.max(
      1,
      Math.floor((deckSize7 - player.cards.length - 5) / opponentCards7)
    );
    // (five for the 5/6-card Omaha games: their per-iteration evaluation is
    // the most expensive on the platform and a triple-board PLO6 bomb pot
    // runs three of them per decision.)
    const mcOpps = Math.min(
      oppCount,
      captureOutcomes7 ? maxByDeck7 : bomb36 ? (vi.holeCount >= 5 ? 5 : 6) : 4
    );
    const boardEq36: number[] = [];
    const outcomeBoards7: HorseEquityOutcomeCollector[] = [];
    if (extraBoards.length === 0) {
      const outcomes7: HorseEquityOutcomeCollector | undefined = captureOutcomes7
        ? {
            maxSamples: phase7OutcomeBudget(trustedTournament?.playersLeft),
            captureContinuation:
              (opts.phase8Postflop ?? 'shadow') !== 'off' &&
              gs.gameVariant === 'nlh' &&
              !(telemetryOn(opts) && liveHorsePhase8Safety.disabledReason),
            samples: [],
          }
        : undefined;
      equity = simulateEquity(
        player.cards,
        gs.communityCards,
        mcOpps,
        vi,
        vi.iterations,
        bands,
        useAdaptiveMC,
        hiLoSplit,
        oppReads,
        outcomes7,
        player.knownDeadCards
      );
      if (outcomes7) outcomeBoards7.push(outcomes7);
      boardEq36.push(equity);
    } else {
      const boards = [gs.communityCards, ...extraBoards];
      const perBoardIters = Math.max(150, Math.ceil(vi.iterations / boards.length));
      // V40: a bet into a multi-board pot says the bettor is strong on SOME
      // board, not on each of them. The tiered Omaha sampler would read a
      // single pot bet as "two pair or better on THIS board" three times
      // over, so per-board pricing keeps only the legacy contact read.
      const oppReadsPerBoard = oppReads
        ? oppReads.map((r) => (r ? { aggrW: r.aggrW, checked: r.checked, bigBet: r.bigBet } : null))
        : undefined;
      let sum = 0;
      const loAcc: HiLoSplit | undefined = hiLoSplit
        ? { hi: 0, lo: 0, scoop: 0, quarter: 0 }
        : undefined;
      for (const b of boards) {
        // A FRESH accumulator per board — simulateEquity adds into the one it
        // is handed, so reusing a single object across boards would sum four
        // probabilities into fields that must stay in 0..1.
        const perBoardSplit: HiLoSplit | undefined = hiLoSplit
          ? { hi: 0, lo: 0, scoop: 0, quarter: 0 }
          : undefined;
        const outcomes7: HorseEquityOutcomeCollector | undefined = captureOutcomes7
          ? {
              maxSamples: phase7OutcomeBudget(trustedTournament?.playersLeft),
              samples: [],
            }
          : undefined;
        const eb = simulateEquity(
          player.cards,
          b,
          mcOpps,
          vi,
          perBoardIters,
          bands,
          useAdaptiveMC,
          perBoardSplit,
          oppReadsPerBoard,
          outcomes7,
          player.knownDeadCards
        );
        if (outcomes7) outcomeBoards7.push(outcomes7);
        boardEq36.push(eb);
        sum += eb;
        if (loAcc && perBoardSplit) {
          loAcc.hi += perBoardSplit.hi;
          loAcc.lo += perBoardSplit.lo;
          loAcc.scoop += perBoardSplit.scoop;
          loAcc.quarter += perBoardSplit.quarter;
        }
      }
      equity = sum / boards.length;
      if (hiLoSplit && loAcc) {
        hiLoSplit.hi = loAcc.hi / boards.length;
        hiLoSplit.lo = loAcc.lo / boards.length;
        hiLoSplit.scoop = loAcc.scoop / boards.length;
        hiLoSplit.quarter = loAcc.quarter / boards.length;
      }
    }

    if (captureOutcomes7) {
      // Adaptive MC can return at its first 40% checkpoint. Record that
      // conservative lower bound rather than advertising the requested
      // budget as statistical precision the decision may not have consumed.
      const perBoardSamples7 = Math.max(
        1,
        Math.floor(equitySampleSizeOfLastCall() * (useAdaptiveMC ? 0.4 : 1))
      );
      capturePhase7Equity(
        gs,
        player,
        equity,
        perBoardSamples7 * (extraBoards.length + 1),
        bands,
        useMind,
        outcomeBoards7
      );
    }

    // V36: multi-board facts. nBoards36 boards pay equally; a board hero
    // cannot lose (MC >= LOCK_EQ) is a locked share; the style board is the
    // one hero is strongest on.
    const allBoards36: Card[][] = [gs.communityCards, ...extraBoards];
    const nBoards36 = allBoards36.length;
    const multiBoard36 = nBoards36 >= 2;
    const LOCK_EQ36 = 0.93;
    let lockedBoards36 = 0;
    let unlockedSum36 = 0;
    let unlockedN36 = 0;
    let styleIdx36 = 0;
    for (let b = 0; b < boardEq36.length; b++) {
      if (boardEq36[b] >= LOCK_EQ36) lockedBoards36++;
      else {
        unlockedSum36 += boardEq36[b];
        unlockedN36++;
      }
      if (boardEq36[b] > boardEq36[styleIdx36]) styleIdx36 = b;
    }
    const lockShare36 = multiBoard36 ? lockedBoards36 / nBoards36 : 0;
    /** mean equity on the boards hero has NOT locked (1 when all are locked) */
    const unlockedEq36 = unlockedN36 > 0 ? unlockedSum36 / unlockedN36 : 1;
    /** the board every style read below is taken from */
    const board = allBoards36[styleIdx36] ?? gs.communityCards;
    if (useMind && multiBoard36 && styleIdx36 !== 0) {
      try {
        wetness = HorseMind.texture(board).wetness;
        blocker = HorseMind.hasBlocker(player.cards, board);
      } catch {
        /* style reads are best-effort */
      }
    }
    if (tele15 && bomb36) noteFire(multiBoard36 ? 'v36_bomb_multiboard' : 'v36_bomb_single');
    if (tele15 && lockShare36 > 0) noteFire('v36_board_lock');

    // V9 TIMING: how CLOSE is this decision? Distance of the MC equity from
    // the nearest strategy threshold. Razor-thin spots read as difficulty ~1
    // (the horse will tank); clear spots read ~0 (it acts in tempo).
    if (useTiming) {
      let dNear = Infinity;
      for (const t of [0.3, 0.42, 0.52, 0.62, 0.8]) {
        const d = Math.abs(equity - t);
        if (d < dNear) dNear = d;
      }
      difficultyHint = Math.max(0, Math.min(1, 1 - dNear / 0.1));
    }

    // ═══ V37 SATELLITE, POSTFLOP ═══ a locked seat does not play big pots.
    // Cheap calls with a real edge are fine; anything that puts a meaningful
    // share of the stack in needs a near-lock; value is bet only when the
    // hand is nearly unbeatable, and never bluffed. A stack below the line
    // plays on with the urgency expressed through the premium below.
    const sat37 = satelliteRead(
      gs,
      player,
      gs.bigBlind > 0 ? stack / gs.bigBlind : 100,
      (opts.v37Satellite ?? true) !== false
    );
    // Multiway tightening: each extra opponent raises the bar.
    // V7 ICM: tournament survival premium tightens calls and trims bluffs.
    // V8: Omaha equities cluster much closer than NLH equities, so each extra
    // opponent tightens HARDER in PLO — thresholds tuned on NLH gaps overplay
    // Omaha hands multiway.
    const risk = useV7
      ? icmRisk(
          gs,
          gs.bigBlind > 0 ? stack / gs.bigBlind : 100,
          opts.v16Icm !== false,
          opts.v23Endgame !== false
        )
      : 0;
    if (tele15 && useV7 && isTournamentMode(gs)) noteFire(`icm_${lastIcmPath}`);

    // V15: equities cluster tighter still with 5 and 6 hole cards, so the
    // per-opponent multiway tightening scales with hole count.
    const useV15 = opts.v15 !== false;
    const omahaMwStep =
      useV8 && vi.isOmaha ? 0.045 + (useV15 ? Math.max(0, vi.holeCount - 4) * 0.005 : 0) : 0.03;
    let mw = (oppCount - 1) * (useV8 && vi.isOmaha ? omahaMwStep : 0.03) + risk;
    // ═══ V16 HEADS-UP OVERLAY (2026-08-26) ═══
    // HU postflop was 6-max minus the multiway penalty. Real HU play is
    // wider: value thresholds drop, thin calls get easier, bluffs go up —
    // ranges are so wide that medium hands ARE value and folding medium
    // equity to single bets bleeds. Small nudges, league-measured by the
    // hu_v16_overlay matchup.
    const huOn =
      (opts.v16Hu ?? true) !== false &&
      gs.players.filter((p) => !p.is_folded && !p.is_sitting_out).length === 2;
    if (huOn) {
      mw = Math.max(-0.02, mw - 0.015);
      if (tele15) noteFire('v16_hu_overlay');
    }

    // V8 O8 SCOOP/QUARTER AWARENESS — the defining skill of hi-lo poker.
    // A hand that frequently SCOOPS both halves bets and raises harder; a
    // nut-low-only hand headed for a QUARTER in a multiway pot stops putting
    // in chips — every bet it makes comes back 25 cents on the dollar.
    const scoopy = !!hiLoSplit && hiLoSplit.scoop >= 0.3;
    // Quarter danger: either the MC directly observes quarter outcomes, or
    // the hand is ONE-WAY LOW multiway (its whole value is half the pot with
    // tie risk) — the raising hand it is not.
    const quartered =
      !!hiLoSplit &&
      oppCount >= 2 &&
      (hiLoSplit.quarter >= 0.2 || (hiLoSplit.lo > 0.4 && hiLoSplit.hi < 0.18));
    if (scoopy) mw -= 0.04;
    if (quartered) mw += 0.08;
    const spr = pot > 0 ? stack / pot : 10;

    // ═══ V4: street IQ — initiative, position, made class, scare, geometry ═══
    let initiative: 'hero' | 'opp' | 'none' = 'none';
    let ip = false;
    let cat = 0; // made-hand category right now (0 = unknown)
    let scare = NO_SCARE;
    let geomFrac = 0; // geometric stacks-in-by-river sizing for monsters
    if (useIQ) {
      try {
        initiative = readInitiative(gs.actionHistory, player.user_id, street);
        ip = actsLastPostflop(player.seat, gs.dealerSeat, gs.players, opts.v13 !== false);
        // V17: HOW MANY live, non-all-in players act after hero this street.
        // ip collapsed first-of-four and first-of-two into the same read;
        // every extra player behind is another chance a bluff runs into it.
        if ((opts.v17Pos ?? true) !== false && gs.dealerSeat !== undefined) {
          const WRAP17 = 1024;
          const pos17 = (seat: number): number => {
            const dd = seat - gs.dealerSeat!;
            return dd <= 0 ? dd + WRAP17 : dd;
          };
          const heroPos17 = pos17(player.seat);
          playersBehind17 = gs.players.filter(
            (p) =>
              !p.is_folded &&
              !p.is_sitting_out &&
              !p.is_all_in &&
              p.seat !== player.seat &&
              pos17(p.seat) > heroPos17
          ).length;
        }
        // V13: on the pineapple discard street a player still holds THREE
        // cards, but only two ever play. madeCategory concatenates hole+board
        // and takes the best five, so it was scoring a 6-card hand and
        // inflating the category — which mis-fires the vulnerable check, the
        // semi-bluff gates (cat <= 2), the monster gates (cat >= 6) and the
        // one-pair domination penalty all at once. Score the best TWO of the
        // three, which is what the player will actually be left holding.
        cat = bestTwoCardCategory(player.cards, board, vi);
        scare = scareShift(board);
        const streetsLeft = isRiver ? 1 : street === 'turn' ? 2 : 3;
        // Effective stack behind vs the deepest live opponent, capped by hero.
        let effOpp = 0;
        for (const o of opponents) {
          const os = (isFinite(o.stack) ? o.stack : 0) + (isFinite(o.bet) ? o.bet : 0);
          if (os > effOpp) effOpp = os;
        }
        const eff = Math.min(stack + player.bet, effOpp);
        const sprEff = pot > 0 ? Math.max(0, eff / pot) : 0;
        // Solve pot*(1+2g)^streets = pot + 2*eff  ->  even pot-growth per street.
        geomFrac = (Math.pow(1 + 2 * sprEff, 1 / streetsLeft) - 1) / 2;
        geomFrac = Math.max(0.35, Math.min(1.1, geomFrac));
      } catch {
        /* street IQ is best-effort — fall back to V3 behavior */
      }
    }
    // V5: the previous street checked through — the field's ranges are capped
    // and a probe/delayed c-bet prints. Turn only (river probes are thinner).
    const prevChecked =
      useHR && street === 'turn' && HorseMind.streetCheckedThrough(gs.actionHistory, 'flop');
    // V17: the same capped-field read one street later. The V5 probe stopped
    // at the turn ("river probes are thinner") — thinner is a frequency, not
    // a reason to play zero.
    const riverPrevChecked =
      (opts.v17RiverProbe ?? true) !== false &&
      useHR &&
      street === 'river' &&
      HorseMind.streetCheckedThrough(gs.actionHistory, 'turn');

    // ═══ V15 OMAHA NUT DISCIPLINE (Dan 2026-08-26) ═══
    // "I watched a horse call off 800 chips with a 9-high flush in PLO6 —
    //  when you get raised, your opponent always has a bigger flush."
    // The made-hand category stops at "flush"; this knows WHICH flush.
    let nuts15: OmahaNutStatus | null = null;
    if (useV15 && vi.isOmaha && (cat === 5 || cat === 6)) {
      try {
        nuts15 = omahaNutStatus(player.cards, board);
        if (tele15 && nuts15) noteFire('v15_nut_status');
      } catch {
        nuts15 = null;
      }
    }
    /** nut-class for raising purposes: full house+, the nut flush, or the nut
     *  straight — DEMOTED by the board itself (line-by-line sweep, same day):
     *  a nut straight is not the nuts on a three-flush board, and a flush is
     *  not the nuts on a paired board. Raises on those boards are flushes and
     *  boats; the demoted hand check-calls instead of raising, which is the
     *  small-ball line these spots demand. */
    let boardMono15 = false;
    let boardPaired15 = false;
    if (useV15 && vi.isOmaha && nuts15 != null) {
      const suitN = new Map<string, number>();
      const rankN = new Map<string, number>();
      for (const bc of board) {
        suitN.set(bc.suit, (suitN.get(bc.suit) || 0) + 1);
        rankN.set(bc.rank, (rankN.get(bc.rank) || 0) + 1);
      }
      for (const n of suitN.values()) if (n >= 3) boardMono15 = true;
      for (const n of rankN.values()) if (n >= 2) boardPaired15 = true;
    }
    const nutClass15 =
      cat >= 7 ||
      (nuts15 != null &&
        ((cat === 6 && nuts15.higherFlushRanks === 0 && !boardPaired15) ||
          (cat === 5 && nuts15.straightIsNut && !boardMono15)));

    // ═══ V40 OMAHA MADE-HAND CLASS (Dan 2026-09-04) ═══
    // "HORSES ARE PLAYING PLO4, PLO5, PLO6 AND PLO8 LIKE IT'S HOLDEM."
    // V15 knew which flush and which straight. Below that it knew only the
    // category number, and "two pair" covered aces-up on a paired board
    // (one pair, in Omaha) as well as top two on a rainbow brick. This is
    // the classifier for pair / two pair / trips: which two pair, on what
    // board, and whether a pot-sized line beats it.
    const useV40 = (opts.v40Omaha ?? true) !== false;
    let made40: OmahaMadeInfo | null = null;
    if (useV40 && vi.isOmaha && cat >= 1 && cat <= 4) {
      try {
        made40 = omahaMadeClass(player.cards, board, cat);
        if (tele15 && made40) noteFire(`v40_made_${made40.cls}`);
      } catch {
        made40 = null;
      }
    }

    // ═══ V21 NLH NUT DISCIPLINE (Dan 2026-08-27, Phase 2) ═══
    // The NLH mirror of nuts15: which straight, which flush, WHOSE boat.
    // Fed by the review table's worst hands: a T7 straight four-bet into a
    // three-club board, sixes-full re-raising JJ66x into any jack.
    const useV21 = opts.v21River !== false;
    let ns21: NlhNutStatus | null = null;
    if (useV21 && !vi.isOmaha && cat >= 4 && cat <= 7) {
      try {
        ns21 = nlhNutStatus(player.cards, board, vi.isShortDeck);
        if (tele15) noteFire('v21_nut_status');
      } catch {
        ns21 = null;
      }
    }
    /** V21: hands above hero's are ON this board — hero is a bluff-catcher,
     *  not a raising hand, whatever the category number says. */
    const dominated21 =
      ns21 != null &&
      ((cat === 5 && (ns21.flushPossible || ns21.heroStraightTop < ns21.maxStraightTop)) ||
        (cat === 6 && !vi.isShortDeck && ns21.higherFlushRanks >= 1) ||
        (cat === 7 && !vi.isShortDeck && ns21.underfull) ||
        // short deck swaps the ladder: flush is cat 7, full house cat 6
        (vi.isShortDeck && cat === 7 && ns21.higherFlushRanks >= 1) ||
        (vi.isShortDeck && cat === 6 && ns21.underfull));
    // Did hero bet/raise THIS street and then get raised? The strongest
    // possible "they have it" signal, and the exact line Dan flagged.
    let raisedAfterAggr = false;
    // V28 AUDIT FIX: this was gated on useV15, so `v15: false` silently
    // disabled parts of V20 and V21 and ALL of the V23 raise-response plans —
    // every league ablation of "V15 discipline" was measuring four layers at
    // once. The read is a fact about the action, not a V15 feature; it is
    // computed whenever the brain is facing a bet.
    if (facingBet && gs.actionHistory) {
      const hist = gs.actionHistory;
      let heroAggrIdx = -1;
      for (let i = 0; i < hist.length; i++) {
        const a = hist[i];
        if (a.stage !== street) continue;
        if (a.userId === player.user_id && (a.action === 'bet' || a.action === 'raise')) {
          heroAggrIdx = i;
        }
      }
      if (heroAggrIdx >= 0) {
        for (let i = heroAggrIdx + 1; i < hist.length; i++) {
          const a = hist[i];
          if (a.stage !== street || a.userId === player.user_id) continue;
          if (a.action === 'raise' || a.action === 'all_in') {
            raisedAfterAggr = true;
            break;
          }
        }
      }
    }
    // ═══ V20 MULTIWAY PRESSURE READ (2026-08-27) ═══
    // raisedAfterAggr only fires when HERO bet and got raised. The hand Dan
    // watched (T8o, 779 flop, 8 turn) was the other shape: hero CALLED, then
    // faced bet -> check-raise -> all-in -> all-in cold. Nobody in that chain
    // is bluffing into a field. Count the street's opponent aggression and
    // its serious all-ins so the discipline below can price the line, not
    // just the last bet.
    const useV20 = opts.v20Multiway !== false;
    let oppAggr20 = 0; // opponent bet/raise/serious-all-in actions this street
    let seriousAllIns20 = 0; // all-ins big enough to be a range statement
    if (useV20 && facingBet && gs.actionHistory) {
      const potNow20 = Math.max(1e-9, pot);
      for (const a of gs.actionHistory) {
        if (a.stage !== street || a.userId === player.user_id) continue;
        if (a.action === 'bet' || a.action === 'raise') oppAggr20++;
        else if (a.action === 'all_in') {
          // A short call-off says nothing; a full-raise jam (or one worth at
          // least a quarter of the pot / half the price) says everything.
          const serious =
            // V28 AUDIT FIX: was `!== false`, which counted the UNDEFINED
            // flag — HandController leaves it undefined precisely for the
            // short call-off this comment excludes — as serious. One short
            // stack calling all-in in front of the horse set the pressure
            // caps, the commit premium and the scare cap, and the horse
            // over-folded because somebody was priced in, not aggressive.
            a.isFullRaise === true || (a.amount ?? 0) >= Math.max(potNow20 * 0.25, toCall * 0.5);
          if (serious) {
            oppAggr20++;
            seriousAllIns20++;
          }
        }
      }
    }
    // 0 = a single bet (normal). Each raise past the first aggressor, the
    // hero-bet-got-raised line, and a second serious all-in each add one.
    const pressure20 = !useV20
      ? 0
      : Math.min(
          3,
          Math.max(0, oppAggr20 - 1) + (raisedAfterAggr ? 1 : 0) + (seriousAllIns20 >= 2 ? 1 : 0)
        );
    if (tele15 && pressure20 >= 1) noteFire('v20_pressure_read');
    // ═══ V40 BARREL COUNT ═══ pressure20 reads ONE street. The line Dan
    // watched (pot, pot, pot: one bet per street) never registers on it.
    // How many EARLIER postflop streets did the player whose bet hero is
    // facing also bet or raise on? A third barrel is the strongest "they
    // have it" signal in pot-limit Omaha, and it needs its own count.
    let barrels40 = 0;
    if (useV40 && facingBet && gs.actionHistory) {
      let bettor40: string | null = null;
      for (const a of gs.actionHistory) {
        if (a.stage !== street || a.userId === player.user_id) continue;
        if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
          bettor40 = a.userId;
      }
      if (bettor40) {
        const seen40 = new Set<string>();
        for (const a of gs.actionHistory) {
          if (a.stage === 'preflop' || a.stage === street || a.userId !== bettor40) continue;
          if (a.action === 'bet' || a.action === 'raise') seen40.add(a.stage);
          else if (a.action === 'all_in' && a.isFullRaise === true) seen40.add(a.stage);
        }
        barrels40 = seen40.size;
      }
    }
    // ═══ V40 CALLED BARRELS ═══ the betting-side mirror. On how many
    // earlier postflop streets did hero bet and get CALLED? In Omaha a
    // player who calls a pot-sized bet has a hand (V28 already stopped
    // reading a call as a capped line); two called barrels and a non-nut
    // made hand has no third one - the range that is still there beats it.
    let calledBarrels40 = 0;
    if (useV40 && vi.isOmaha && !facingBet && gs.actionHistory) {
      const heroBet40 = new Set<string>();
      const called40 = new Set<string>();
      for (const a of gs.actionHistory) {
        if (a.stage === 'preflop' || a.stage === street) continue;
        if (a.userId === player.user_id) {
          if (a.action === 'bet' || a.action === 'raise') heroBet40.add(a.stage);
        } else if (heroBet40.has(a.stage) && (a.action === 'call' || a.action === 'all_in')) {
          called40.add(a.stage);
        }
      }
      calledBarrels40 = called40.size;
    }

    // V15 SMALL BALL (plo5/plo6): more hole cards squeeze equities together,
    // so the value edge per bet shrinks — sizing shrinks with it. Nut-class
    // hands are exempt (they still build the pot geometrically).
    const ploDamp =
      useV15 && vi.isOmaha && vi.holeCount >= 5 ? (vi.holeCount >= 6 ? 0.78 : 0.86) : 1;

    // Vulnerable made hand: real hand today, wet board, cards to come — bet for
    // protection, never slowplay. (Strong two pair / trips / weak straight.)
    const vulnerable = useIQ && cat >= 3 && cat <= 5 && wetness >= 0.45 && drawsLive;
    // Fresh danger card hero does not beat: straight/flush completed, no
    // blocker, and hero's own hand is below that class.
    const dangered = useIQ && (scare.flush || scare.straight) && cat < 5 && !blocker;

    // V3 texture-driven sizing: small on dry boards, big on wet ones.
    const sizeBase = 0.3 + wetness * 0.35; // 0.30 (dry) .. 0.65 (soaked)

    // V10 RANGE-ADVANTAGE c-bet read: a high-card, dry, unpaired board smashes
    // the preflop/betting aggressor's range (AK, AQ, big pairs) far harder than
    // a caller's, so the aggressor c-bets its WHOLE range at high frequency and
    // small size. Low/connected/paired boards are closer to even and the branch
    // that uses this is already dry-gated, so V10 only adds the range-c-bet
    // upgrade — never c-bets a board it would not have.
    const boardRanks = board.map((cc) => cc.rank);
    const boardHasHigh = boardRanks.some((r) => r === 'A' || r === 'K' || r === 'Q');
    const rankCounts: Record<string, number> = {};
    for (const r of boardRanks) rankCounts[r] = (rankCounts[r] || 0) + 1;
    const pairedBoard = Object.values(rankCounts).some((n) => n >= 2);
    // NLH only: in Omaha equities run close and everyone flops draws, so a
    // high-card dry board does not hand the aggressor a range edge — the A/B
    // showed the range-c-bet upgrade does not translate, so it is gated off.
    const boardFavorsAggressor =
      useCbet10 && useIQ && !vi.isOmaha && boardHasHigh && wetness < 0.4 && !pairedBoard;
    // V3 bluff gating: blockers upgrade bluffs; wet boards without one demote.
    const blockerMod = blocker ? 1.35 : wetness > 0.55 ? 0.7 : 1.0;
    // V4: position scales bluffing — pressure comes cheaper in position.
    // V7: ICM survival pressure trims bluff volume in tournaments.
    const posMod = useIQ ? (ip ? 1.15 : 0.85) : 1.0;
    let bluffScale =
      exploit.bluffMod * blockerMod * posMod * Math.max(0.5, 1 - 2 * risk) * (quartered ? 0.6 : 1);
    if (huOn) bluffScale *= 1.12;
    // V40: an Omaha river bluff into a player who called two barrels is a
    // third barrel with air. The range that called pot twice is not
    // folding; the bluff ladder below all but closes here.
    if (useV40 && vi.isOmaha && isRiver && calledBarrels40 >= 2) {
      bluffScale *= 0.15;
      if (tele15) noteFire('v40_no_third_barrel');
    }
    // V37: the covering stack near the bubble bluffs a notch more — the
    // covered field is folding hands it would call with anywhere else.
    if (!sat37.active) {
      const bp37 = bubblePressure(gs, player, -1, (opts.v37Satellite ?? true) !== false);
      if (bp37 > 0) {
        bluffScale *= 1 + 0.2 * bp37;
        if (tele15) noteFire('v37_bubble_pressure_postflop');
      }
    }
    // V37: a big bounty on hero's own head gets called down wider.
    if ((opts.v24Bounty ?? true) !== false && isTournamentMode(gs)) {
      const own37 = headBountyScale(gs, player.user_id);
      if (own37 > 1.5) {
        bluffScale *= Math.max(0.7, 1 - (own37 - 1.5) * 0.2);
        if (tele15) noteFire('v37_own_head_bounty');
      }
    }
    // V36: a bluff has to fold out EVERY board. Random ranges, N boards:
    // somebody has a piece of one of them on almost every deal.
    if (multiBoard36) {
      bluffScale *= nBoards36 >= 3 ? 0.35 : 0.5;
      if (tele15) noteFire('v36_multiboard_bluff_trim');
    }
    // ═══ V23 RIVER READS (2026-08-28) ═══ heads-up on the river, the one
    // number that prices a bluff is whether THIS player folds rivers. Scale
    // bluff volume by their observed fold-to-river-bet; push thin value the
    // other way (a river folder pays thin value less, a station pays more).
    let thinAdj23 = 0;
    if ((opts.v23Reads ?? true) !== false && useMind && isRiver && oppCount === 1) {
      try {
        const rfr = HorseMind.riverFoldRate(opponents[0].user_id);
        if (rfr !== null) {
          bluffScale *= 1 + Math.max(-0.25, Math.min(0.35, (rfr - 0.45) * 0.8));
          thinAdj23 = Math.max(-0.03, Math.min(0.05, (rfr - 0.45) * 0.1));
          if (tele15) noteFire('v23_river_read');
        }
      } catch {
        /* reads are best-effort */
      }
    }
    // ═══ V23 SPIN OVERLAY (2026-08-28) ═══ 3-max hypers pay aggression:
    // stacks are shallow, levels are three minutes, and blinds eat the
    // passive. League cannot deal spins, so the sizes here are small and the
    // flag exists for ablation.
    //
    // CORRECTED 2026-08-31: this used to open "winner-take-all hypers pay
    // aggression: every chip won is worth every chip lost". That premise is
    // false above 10x, where the tier pays 80/20 or 80/12/8. The overlay is
    // kept ON for every spin anyway, and deliberately: what it prices is the
    // STRUCTURE, which is identical at every tier. The ladder is priced in
    // one place only — icmRisk — and it already reaches this line, because
    // `bluffScale` carries `Math.max(0.5, 1 - 2 * risk)` above. Adding a
    // second tier-aware damper here would count the same ladder twice.
    const spin23 = (opts.v23Spin ?? true) !== false && gs.format === 'spin';
    if (spin23) {
      bluffScale *= 1.12;
      if (tele15) noteFire('v23_spin');
    }
    // ═══ V23 VARIANT POLISH ═══ short deck: straights arrive more often and
    // draws complete more — draws earn a touch more implied credit, while
    // one-pair thin value shrinks (everyone has more).
    const useV23Var = (opts.v23Variants ?? true) !== false;
    if (useV23Var && vi.isShortDeck && cat === 2) thinAdj23 += 0.03;
    // ═══ V18 SELF-IMAGE ═══ the table watched hero's recent line too. A
    // horse coming off a bluff-heavy stretch gets called down - throttle the
    // bluffs until the image cools; a rock's rare bets get instant credit -
    // bluff a touch more. Read from the SAME stats opponents read.
    if ((opts.v18SelfImage ?? true) !== false && useMind) {
      try {
        const img = HorseMind.selfImageOf(player.user_id);
        if (img !== null) {
          if (img >= 0.75) {
            bluffScale *= 0.85;
            if (tele15) noteFire('v18_self_image');
          } else if (img <= 0.35) {
            bluffScale *= 1.1;
            if (tele15) noteFire('v18_self_image');
          }
        }
      } catch {
        /* image is best-effort */
      }
    }
    // ═══ V17 POSITIONAL PRESSURE ═══
    // Bluff volume by players still to act: closing the action bluffs a
    // touch more (nobody left to wake up), one behind is neutral, and each
    // additional live player behind cuts volume hard — a stab into three
    // players who all still act is burning money the ip/oop binary and the
    // flat multiway penalty never fully priced.
    if ((opts.v17Pos ?? true) !== false && playersBehind17 >= 0) {
      const behindMod =
        playersBehind17 === 0
          ? 1.1
          : playersBehind17 === 1
            ? 1.0
            : playersBehind17 === 2
              ? 0.72
              : 0.5;
      if (behindMod !== 1.0) {
        bluffScale *= behindMod;
        if (tele15) noteFire('v17_pos_behind');
      }
    }
    // ═══ V17 SHORT-DECK OVERLAY ═══ 36-card equities cluster: a "strong"
    // hand is less far ahead, so value thresholds rise and every extra
    // opponent tightens harder than the NLH step.
    if ((opts.v17ShortDeck ?? true) !== false && vi.isShortDeck) {
      mw += 0.015 + (oppCount - 1) * 0.012;
      if (tele15) noteFire('v17_short_deck');
    }

    // V8 Omaha draw quality — computed LAZILY (enumeration cost) and only
    // inside the semi-bluff bands. Nut draws fight; dominated flush draws
    // without wrap backup stop stacking off.
    let drawInfoCache: OmahaDrawInfo | null = null;
    const omahaDrawMod = (): number => {
      if (!useDraws || !drawsLive) return 1;
      if (!drawInfoCache) drawInfoCache = omahaDrawQuality(player.cards, board, vi.isHiLo);
      const d = drawInfoCache;
      if (d.nutty) return 1.15;
      if (d.dominatedFlushDraw && d.straightOuts < 6) return 0.35;
      return 0.7;
    };
    // V40: the same lazy read, exposed for the pressure cap and the
    // betting-side small-ball gate (both fire rarely; the cost stays
    // inside the branches that need it).
    const drawInfo40 = (): OmahaDrawInfo | null => {
      if (!vi.isOmaha || !drawsLive) return null;
      if (!drawInfoCache) drawInfoCache = omahaDrawQuality(player.cards, board, vi.isHiLo);
      return drawInfoCache;
    };

    // ═══ V7: barrel planning — multi-street bluffs tell a coherent story ═══
    // When a bluff/semi-bluff bet fires, the horse decides THEN whether it is
    // a planned multi-street line. On later streets the plan is honored:
    // planned barrels continue on safe cards; unplanned stabs give up.
    const handKey = useBarrels ? HorseMind.handKeyOf(gs.actionHistory) : null;
    const barrelPlan = useBarrels ? HorseMind.getPlan(handKey, player.user_id) : undefined;
    /**
     * ═══ V39 THE NEXT CARD, READ AGAINST WHAT THE BET EXPECTED (2026-09-03) ═══
     * The bet on the previous street recorded which cards were good for hero
     * and which were scary (nextCardOutlook). The card that arrived is read
     * against that record: a GOOD card turns the planned barrel into a
     * value-leaning bet (more of them); a SCARE card hero does not block is
     * the give-up; a scare card hero DOES block is the best bluff card in the
     * deck. A blank keeps the plan as written.
     */
    const prevStreet39 = street === 'turn' ? 'flop' : street === 'river' ? 'turn' : null;
    const newCard39 = board.length >= 4 ? board[board.length - 1] : null;
    const outlook39 =
      useBarrels && prevStreet39 && newCard39
        ? HorseMind.outlookOf(
            handKey,
            player.user_id,
            prevStreet39,
            `${newCard39.rank}${newCard39.suit[0]}`
          )
        : undefined;
    if (tele15 && outlook39) noteFire(`v39_outlook_${outlook39}`);
    const planBarrel = (equityNow: number): void => {
      if (!useBarrels || isRiver) return;
      // Only bluffs/semi-bluffs need a plan — value hands bet themselves.
      // TUNED (duplicate-deal ablation): 0.55 planned too many multi-street
      // bluffs into a pool that calls; 0.40 keeps the coherent-story benefit
      // without torching chips on over-frequent second barrels.
      if (equityNow < 0.55) {
        HorseMind.notePlan(handKey, player.user_id, fastRandom() < 0.35);
        // V39: and what the next card would mean, decided now.
        try {
          const o = nextCardOutlook(player.cards, board, vi);
          HorseMind.noteOutlook(handKey, player.user_id, street, o.good, o.scare);
          if (tele15) noteFire('v39_outlook_recorded');
        } catch {
          /* the outlook is best-effort */
        }
      }
    };

    // ═══ V23 RAISE-RESPONSE PLAN (2026-08-28) ═══ every postflop bet decides
    // NOW what a raise back means. betSize/raiseTo record it; the facing-bet
    // path below consults it when raisedAfterAggr — so the bet and the
    // response to the raise are one decision, not two dice rolls. The
    // bet_fold_line/big_fold_river reviews are exactly this incoherence.
    const useV23Plan = (opts.v23Plan ?? true) !== false && opts.mind !== false;
    pendingRaisePlan = !useV23Plan
      ? null
      : equity >= 0.62 || cat >= 5
        ? 'commit'
        : equity >= 0.33
          ? 'callOnce'
          : 'foldToRaise';

    const useV11 = opts.v11 !== false;
    // V10 RAKE: below the cap the pot we stand to win is taxed ~10%, so price
    // marginal calls against the raked pot, not the raw one. Above the cap
    // (large pots) the drag is zero and this reduces to honest pot odds.
    // V11: tournaments rake the buy-in, not the pot — pot odds are honest.
    // V34: computed here, above the solver consult, so V32 prices the same
    // raked pot the heuristic call line does.
    const rakeMarg =
      useRake10 && !isTournamentMode(gs)
        ? rakeDrag(
            pot,
            gs.bigBlind,
            gs.rakeConfig,
            gs.players.filter((candidate) => !candidate.is_sitting_out).length
          )
        : 0;

    // V31 CERTIFIED DIRECT POLICY. Node role, response semantics, both seats,
    // objective, stack depth, board texture and holding are all part of the
    // lookup key. An open policy can never answer a response decision, and a
    // chip-EV tournament policy can never masquerade as ICM. The compact
    // loader has already rejected any row without a complete active seal.
    if (
      (opts.v31GtoSuitAware ?? true) !== false &&
      (street === 'flop' || street === 'turn' || street === 'river') &&
      player.cards.length === 2 &&
      vi.holeCount === 2 &&
      !vi.isFixedLimit &&
      !vi.isOmaha &&
      !vi.isShortDeck &&
      opponents.length === 1 &&
      // The certified V31 context has no straddle axis. A straddle-enabled
      // hand can have a different root pot, preflop ranges, action order, and
      // SPR, so a standard-pot cell is not evidence for it. V18/heuristics
      // retain ownership until a separately keyed straddle corpus exists.
      gs.straddleActive !== true &&
      gs.bombPot !== true &&
      !(gs.communityCards2 && gs.communityCards2.length > 0)
    ) {
      const opponent31 = opponents[0];
      const heroSeat31 = gtoV31Position({
        seat: player.seat,
        dealerSeat: gs.dealerSeat,
        players: gs.players,
      });
      const opponentSeat31 = gtoV31Position({
        seat: opponent31.seat,
        dealerSeat: gs.dealerSeat,
        players: gs.players,
      });
      const context31 = classifyGtoDecisionContext({
        street,
        hero: player,
        opponents,
        actionHistory: gs.actionHistory,
        currentBet: gs.currentBet,
        pot: gs.pot,
      });
      let family31: GtoV31GameFamily | null = null;
      let objective31: GtoV31Objective | null = null;
      if (!isTournamentMode(gs)) {
        family31 = 'cash';
        objective31 = 'cash_ev';
      } else if (gs.format === 'spin') {
        family31 = 'spin';
        objective31 = (trustedTournament?.spotsPaid ?? 1) <= 1 ? 'chip_ev' : 'icm';
      } else if (
        Array.isArray(trustedTournament?.stacks) &&
        trustedTournament.stacks.length >= 2 &&
        Array.isArray(trustedTournament?.payoutPct) &&
        trustedTournament.payoutPct.length >= 1 &&
        !((trustedTournament?.playersLeft ?? 0) <= 2 && (trustedTournament?.spotsPaid ?? 1) <= 1)
      ) {
        family31 = 'tourney_icm';
        objective31 = 'icm';
      } else {
        family31 = 'tourney_ev';
        objective31 = 'chip_ev';
      }
      const utility31 =
        family31 && objective31
          ? gtoV31UtilityContext({
              family: family31,
              objective: objective31,
              tournament: trustedTournament,
            })
          : null;
      const potType31 = gtoV31PotType(gs.actionHistory);
      const hand31 = gtoHandClass(player.cards[0], player.cards[1]);

      const opponentRootStack31 = gtoV31FlopRootStack({
        street,
        player: opponent31,
        actionHistory: gs.actionHistory,
      });
      const heroRootStack31 = gtoV31FlopRootStack({
        street,
        player,
        actionHistory: gs.actionHistory,
      });
      const effective31 =
        opponentRootStack31 !== null && heroRootStack31 !== null
          ? Math.min(heroRootStack31, opponentRootStack31)
          : null;
      const stackBB31 = effective31 !== null && gs.bigBlind > 0 ? effective31 / gs.bigBlind : null;
      const tooDeep31 =
        stackBB31 !== null &&
        (opts.v33DepthCeiling ?? true) !== false &&
        beyondGtoDepthCeiling(stackBB31);
      if (tooDeep31 && tele15) noteFire('gto_skip_too_deep');

      const direct31 =
        context31 &&
        family31 &&
        objective31 &&
        utility31 &&
        heroSeat31 &&
        opponentSeat31 &&
        stackBB31 !== null &&
        heroSeat31.tableSize === opponentSeat31.tableSize &&
        gtoV31HasHeadsUpPostflopLine(gs.actionHistory, player.seat, opponent31.seat) &&
        !tooDeep31
          ? gtoStreetAdviceV31({
              street,
              family: family31,
              objective: objective31,
              utilityContext: utility31,
              tableSize: heroSeat31.tableSize,
              potType: potType31,
              heroPosition: heroSeat31.position,
              opponentPosition: opponentSeat31.position,
              stackBB: stackBB31,
              board: gs.communityCards,
              hand: hand31,
              holeCards: player.cards,
              nodeRole: context31.nodeRole,
              facingKind: context31.facingKind,
              facingSizeBucket: context31.facingSizeBucket,
              datasetChecksum: opts.gtoV31DatasetChecksum,
            })
          : null;
      if (direct31?.hit && stackBB31 !== null) {
        if (tele15 && !cellDepthIsPrimary(direct31.cell, stackBB31, direct31.depthBucket)) {
          noteFire('gto_depth_fallback');
        }
        const actionId31 = rollMix(direct31.mix, fastRandom);
        const action31 = actionId31 ? direct31.actions[actionId31] : null;
        if (action31 && actionId31) {
          let intended31: HorseDecision | null = null;
          if (action31.family === 'check') {
            intended31 = { action: 'check', thinkTime: 0 };
          }
          if (action31.family === 'fold') {
            intended31 = { action: 'fold', thinkTime: 0 };
          }
          if (action31.family === 'call') {
            intended31 = { action: 'call', amount: toCall, thinkTime: 0 };
          }
          if (action31.family === 'all_in') {
            intended31 = { action: 'all_in', thinkTime: 0 };
          }
          if (
            action31.family === 'bet' &&
            action31.size_unit === 'pot_fraction' &&
            action31.size_value
          ) {
            intended31 = { action: 'bet', amount: pot * action31.size_value, thinkTime: 0 };
          }
          if (
            action31.family === 'raise' &&
            action31.size_unit === 'pot_after_call_fraction' &&
            action31.size_value
          ) {
            intended31 = {
              action: 'raise',
              amount: currentBet + (pot + toCall) * action31.size_value,
              thinkTime: 0,
            };
          }
          if (intended31) {
            const final31 = this.legalize(intended31, player, gs, vi);
            const sampledAmount31 = intended31.amount ?? null;
            const finalAmount31 = final31.amount ?? null;
            const executedAsIntended31 = gtoV31ExecutionMatches({
              sampledFamily: action31.family,
              sampledAmount: sampledAmount31,
              finalAction: final31.action,
              finalAmount: finalAmount31,
              bigBlind: gs.bigBlind,
            });
            if (
              opts.onGtoV31Decision &&
              hand31 &&
              context31 &&
              family31 &&
              objective31 &&
              utility31 &&
              heroSeat31 &&
              opponentSeat31
            ) {
              opts.onGtoV31Decision({
                datasetId: direct31.sourceSeal.dataset_id,
                datasetChecksum: direct31.sourceSeal.dataset_checksum,
                decisionState: {
                  schemaVersion: 1,
                  street,
                  gameVariant: 'nlh',
                  gameFamily: family31,
                  objective: objective31,
                  utilityContext: utility31,
                  format: gs.format ?? (isTournamentMode(gs) ? 'mtt' : 'cash'),
                  tableSize: heroSeat31.tableSize,
                  potType: potType31,
                  heroPosition: heroSeat31.position,
                  opponentPosition: opponentSeat31.position,
                  stackBb: stackBB31,
                  depthBucket: direct31.depthBucket,
                  textureClass: direct31.textureClass,
                  nodeRole: direct31.nodeRole,
                  facingKind: context31.facingKind,
                  facingSizeBucket: context31.facingSizeBucket,
                  hand: hand31,
                  handKey: direct31.handKey,
                  cell: direct31.cell,
                  board: structuredClone(gs.communityCards),
                  holeCards: structuredClone(player.cards),
                  pot,
                  currentBet,
                  toCall,
                  bigBlind: gs.bigBlind,
                },
                nodeRole: direct31.nodeRole,
                cell: direct31.cell,
                handKey: direct31.handKey,
                actionId: actionId31,
                sampledActionFamily: action31.family,
                sampledAmount: sampledAmount31,
                finalAction: final31.action,
                finalAmount: finalAmount31,
                executedAsIntended: executedAsIntended31,
                referenceDistribution: structuredClone(direct31.mix),
                policyEvBb: direct31.policyEvBb,
                actionEvsBb: structuredClone(direct31.actionEvsBb),
                sourceSeal: structuredClone(direct31.sourceSeal),
              });
            }
            if (tele15) {
              noteFire(
                executedAsIntended31
                  ? `v31_certified_${direct31.nodeRole}`
                  : 'v31_certified_execution_mismatch'
              );
            }
            return final31;
          }
        }
        if (tele15) noteFire('v31_certified_unusable_action');
      } else if (direct31 && !direct31.hit && stackBB31 !== null && tele15) {
        noteFire(`v31_certified_miss_${direct31.miss}`);
        noteGtoMiss('v31', street, stackBB31);
      } else if (tele15 && isTournamentMode(gs) && (!objective31 || !utility31)) {
        noteFire('v31_certified_skip_unknown_tournament_utility');
      } else if (tele15 && (!heroSeat31 || !opponentSeat31)) {
        noteFire('v31_certified_skip_unknown_position');
      } else if (tele15 && stackBB31 === null) {
        noteFire('v31_certified_skip_unknown_root_stack');
      } else if (
        tele15 &&
        !gtoV31HasHeadsUpPostflopLine(gs.actionHistory, player.seat, opponent31.seat)
      ) {
        noteFire('v31_certified_skip_multiway_history');
      }
    }

    // ═══ V37 SATELLITE, POSTFLOP FALLBACK ═══ Certified exact satellite ICM
    // gets first refusal above.  The survival heuristic remains the fail-
    // closed answer when no exact candidate/active cell can answer (or when
    // the game is ineligible), but it must never make the evaluator's
    // satellite component structurally incapable of executing the candidate.
    if (sat37.locked) {
      if (tele15) noteFire('v37_sat_locked_postflop');
      if (facingBet) {
        const odds37 = toCall / Math.max(1e-9, pot + toCall);
        const cheap = toCall <= stack * 0.08;
        if (equity >= 0.9) return { action: 'call', amount: toCall, thinkTime: 0 };
        if (cheap && equity >= odds37 + 0.1)
          return { action: 'call', amount: toCall, thinkTime: 0 };
        return { action: 'fold', thinkTime: 0 };
      }
      if (equity >= 0.9 && !isRiver) {
        return this.betSize(pot, 0.5 + fastRandom() * 0.2, player, gs, vi, params, useSizing);
      }
      if (equity >= 0.85 && isRiver) {
        return this.betSize(pot, 0.4 + fastRandom() * 0.2, player, gs, vi, params, useSizing);
      }
      return { action: 'check', thinkTime: 0 };
    }

    /** V34: the solver said CALL with a drawing hand; the semi-bluff raise
     *  gates below get first refusal, and the call is guaranteed after them. */
    let solverCall32 = false;
    // ═══ V32 FACING A BET — the solver's own betting range (2026-08-30) ═══
    // Phase 2 of 7. V29/V30/V31 answer only with the LEAD; this is the other
    // half. The bettor's open-node cell gives P(bet at this size | holding)
    // for every holding — which IS the betting range. Hero's equity against
    // that range vs pot odds is the fold/call line; hands above the strong
    // threshold PASS (null) so the aggression layers keep owning raises.
    // Gate mirrors the open consult exactly: heads-up hold'em, one board.
    if (
      (opts.v32FacingDefense ?? true) !== false &&
      facingBet &&
      // NOT `initiative === 'opp'`: readInitiative reads EARLIER streets only,
      // so a villain betting THIS street after the action checked to them
      // reads 'none' — and that spontaneous lead is exactly the open-node bet
      // the cells model. Only a bet made INTO hero's own lead (hero raised,
      // villain donks) is excluded: the cell for that node does not exist,
      // and pretending the open-node range covers it would price the donk
      // range as an opening range.
      initiative !== 'hero' &&
      (street === 'flop' || street === 'turn' || street === 'river') &&
      player.cards.length === 2 &&
      // V35: the cells are HOLD'EM cells — two dealt cards, no-limit. After
      // the pineapple discard a hand holds two cards too, but every range at
      // the table was the best two of three, and fixed limit has no bet size
      // to read; both used to pass this gate and were answered from the
      // wrong game.
      vi.holeCount === 2 &&
      !vi.isFixedLimit &&
      !vi.isOmaha &&
      !vi.isShortDeck &&
      // NOT oppCount: `Math.max(1, opponents.length)` reads 1 even when the
      // array is EMPTY, and the bettor is indexed out of it below.
      opponents.length === 1 &&
      // Hero has put nothing in voluntarily this street: the wager faced is
      // a BET, not a raise of hero's own bet. A check-raise's range comes
      // from a raise node the warehouse does not hold — pricing it with the
      // open-bet cell would be the donk mistake with the seats swapped.
      player.bet === 0 &&
      // V36: no solver range describes a bomb pot — every hand at the table
      // is random, and the cells were solved for single-raised-pot ranges.
      gs.bombPot !== true &&
      !(gs.communityCards2 && gs.communityCards2.length > 0)
    ) {
      const bettor = opponents[0];
      const bettorPos32 = classifyPosition(
        bettor.seat,
        gs.dealerSeat,
        gs.players,
        opts.v13 !== false
      );
      const chartPos32 =
        bettorPos32 === 'sb'
          ? 'SB'
          : bettorPos32 === 'bb'
            ? 'BB'
            : bettorPos32 === 'early'
              ? 'UTG'
              : bettorPos32 === 'middle'
                ? 'MP'
                : bettor.seat === gs.dealerSeat
                  ? 'BTN'
                  : 'CO';
      const family32: 'cash' | 'spin' | 'tourney_icm' = !isTournamentMode(gs)
        ? 'cash'
        : gs.format === 'spin'
          ? 'spin'
          : 'tourney_icm';
      // Effective stack, same reasoning as stackBB29: the cell is keyed by
      // the shorter stack, and here the BETTOR's wager is already out.
      const bettorTotal32 =
        (isFinite(bettor.stack) ? bettor.stack : 0) + (isFinite(bettor.bet) ? bettor.bet : 0);
      const heroTotal32 = player.stack + (isFinite(player.bet) ? player.bet : 0);
      const effStack32 = bettorTotal32 > 0 ? Math.min(heroTotal32, bettorTotal32) : heroTotal32;
      const stackBB32 = gs.bigBlind > 0 ? effStack32 / gs.bigBlind : 100;
      // Bucket by the size the bettor CHOSE (raw), price by what hero pays
      // (effective). A jam of three pots into a short stack is still a
      // bet_big for range purposes even when hero's call is small.
      const bettorWager32 = isFinite(bettor.bet) ? Math.max(0, bettor.bet) : 0;
      const rawPotBefore32 = gs.pot - bettorWager32;
      /*
       * DEPTH CEILING (2026-09-01), same reasoning as the open-node consult:
       * the facing export is keyed by the same depth buckets, which stop at
       * 150bb. Above the ceiling the answer would be extrapolated rather than
       * looked up, so the layer declines and the heuristics play the spot.
       */
      const tooDeep32 =
        (opts.v33DepthCeiling ?? true) !== false && beyondGtoDepthCeiling(stackBB32);
      if (tooDeep32 && telemetryOn(opts)) noteFire('gto_skip_too_deep');

      // V34: a drawing hand — no pair yet, but real equity from the runout.
      // It realizes a little better than its raw number (implied odds, and
      // it is the hand that keeps improving), and it is the hand the
      // semi-bluff raise gates below were written for.
      const drawy32 =
        cat <= 1 && drawsLive && equity >= (street === 'flop' ? 0.3 : 0.2) && equity < 0.55;
      const realization32 = realizationFactor({
        street,
        inPosition: ip,
        drawy: drawy32,
      });
      const defense = tooDeep32
        ? null
        : gtoFacingDefense({
            street,
            family: family32,
            bettorPosition: chartPos32,
            stackBB: stackBB32,
            board: gs.communityCards,
            heroCards: player.cards,
            pot,
            toCall,
            rawBetFraction: rawPotBefore32 > 0 ? bettorWager32 / rawPotBefore32 : undefined,
            rand: fastRandom,
            realization: realization32,
            rakeMarg,
            // Tournament: the survival premium, scaled by the share of the
            // stack this call risks (V24's rule: ICM prices a bust, and a
            // call worth 3% of a stack cannot bust anybody).
            riskPremium: risk > 0 && stack > 0 ? risk * Math.sqrt(Math.min(1, toCall / stack)) : 0,
          });
      if (defense) {
        if (defense.action === 'pass_strong') {
          if (telemetryOn(opts)) noteFire('v32_defend_pass_strong');
          // fall through: the aggression layers play this hand
        } else if (defense.action === 'call') {
          if (telemetryOn(opts)) noteFire('v32_defend_call');
          // V34: the layer only ever answered fold-or-call, so while a cell
          // existed the fleet never once check-raised a flush draw or
          // re-raised a combo draw heads-up in hold'em: every semi-bluff
          // raise line below was unreachable. A solver call with a DRAW now
          // falls through with the call guaranteed - the raise gates roll
          // first, and if they pass, the call stands. Made hands still
          // return here: a raise with those is the aggression layers' job
          // and they are consulted at pass_strong.
          if (drawy32 && !isRiver) {
            solverCall32 = true;
            if (telemetryOn(opts)) noteFire('v34_defend_draw_passthrough');
          } else {
            return { action: 'call', amount: toCall, thinkTime: 0 };
          }
        } else {
          if (telemetryOn(opts)) noteFire('v32_defend_fold');
          return { action: 'fold', thinkTime: 0 };
        }
      } else if (!tooDeep32 && telemetryOn(opts)) {
        // A genuine miss - the gate was passed, the warehouse was asked, and
        // it had no range. A skip for depth is NOT a miss and must not be
        // counted as one, or the coverage number it feeds becomes fiction.
        noteFire('v32_defend_no_range');
        noteGtoMiss('v32', street, stackBB32);
      }
    }

    // ═══ Not facing a bet ═══
    if (!facingBet) {
      // ═══ V36 FREEROLL BET ═══ a locked board and an unlocked one: every
      // chip that goes in comes back at least 1/N, and a bet folds out the
      // hands that were beating hero on the other board(s). Bet, and bet
      // big — there is no raise that can hurt this hand. (All boards locked
      // is a plain monster and takes the monster line below.)
      if (multiBoard36 && lockShare36 >= 1 / nBoards36 && lockShare36 < 1 && fastRandom() < 0.9) {
        if (tele15) noteFire('v36_freeroll_bet');
        return this.betSize(
          pot,
          Math.max(0.75, geomFrac > 0 ? geomFrac : 0.75) + fastRandom() * 0.15,
          player,
          gs,
          vi,
          params,
          useSizing
        );
      }
      // ═══ V29/V30 GTO OPEN NODES (Dan 2026-08-29): the betting mix comes
      // from the solver ═══ Heads-up hold'em with the betting lead: the
      // check / bet_small / bet_big mix is the class-mean of the PioSolver
      // warehouse (see GtoPostflop.ts for the aggregation and its stated
      // approximation) — V29 covers the flop, V30 the turn and river. Every
      // solved tree is an OPEN node, so this consult requires hero to hold
      // the lead; donk-lead spots keep the V11 initiative gate and the
      // heuristics, and facing a bet is played by the layers below (the
      // warehouse holds no trustworthy facing data — see GtoPostflop.ts).
      // Empty store or uncharted spot -> null -> everything below unchanged.
      if (
        (street === 'flop'
          ? (opts.v29GtoFlop ?? true) !== false
          : (opts.v30GtoTurnRiver ?? true) !== false) &&
        (street === 'flop' || street === 'turn' || street === 'river') &&
        player.cards.length === 2 &&
        // V35: hold'em cells for hold'em hands only (see the V32 gate).
        vi.holeCount === 2 &&
        !vi.isFixedLimit &&
        !vi.isOmaha &&
        !vi.isShortDeck &&
        oppCount === 1 &&
        initiative === 'hero' &&
        gs.bombPot !== true &&
        !(gs.communityCards2 && gs.communityCards2.length > 0)
      ) {
        const hand29 = gtoHandClass(player.cards[0], player.cards[1]);
        const pos29 = classifyPosition(player.seat, gs.dealerSeat, gs.players, opts.v13 !== false);
        const chartPos29 =
          pos29 === 'sb'
            ? 'SB'
            : pos29 === 'bb'
              ? 'BB'
              : pos29 === 'early'
                ? 'UTG'
                : pos29 === 'middle'
                  ? 'MP'
                  : player.seat === gs.dealerSeat
                    ? 'BTN'
                    : 'CO';
        const family29: 'cash' | 'spin' | 'tourney_icm' = !isTournamentMode(gs)
          ? 'cash'
          : gs.format === 'spin'
            ? 'spin'
            : 'tourney_icm';
        // EFFECTIVE stack (2026-08-31, Phase 3): the cells are keyed by
        // eff_stack_bb — the shorter of the two stacks — because that is the
        // number the solver solved for. Keying on hero's stack alone sent a
        // deep hero against a short villain to a cell solved for money that
        // cannot go in. Known deferred gap from Phase 1, now closed.
        const opp29 = opponents[0];
        const oppTotal29 =
          (isFinite(opp29?.stack) ? opp29.stack : 0) + (isFinite(opp29?.bet) ? opp29.bet : 0);
        const heroTotal29 = player.stack + (isFinite(player.bet) ? player.bet : 0);
        const effStack29 = oppTotal29 > 0 ? Math.min(heroTotal29, oppTotal29) : heroTotal29;
        const stackBB29 = gs.bigBlind > 0 ? effStack29 / gs.bigBlind : 100;

        // Legacy V29/V30 remains a safe open-only fallback while no certified
        // V31 cell matches. It never answers a response node.
        const tooDeep29 =
          (opts.v33DepthCeiling ?? true) !== false && beyondGtoDepthCeiling(stackBB29);
        if (tooDeep29 && telemetryOn(opts)) noteFire('gto_skip_too_deep');

        // The open-node consult reads the same warehouse and the same depth
        // buckets, so the ceiling applies to it identically.
        const advice29 = tooDeep29
          ? null
          : gtoStreetAdvice({
              street,
              family: family29,
              position: chartPos29,
              stackBB: stackBB29,
              board: gs.communityCards,
              hand: hand29,
            });
        if (advice29) {
          if (telemetryOn(opts) && !cellDepthIsPrimary(advice29.cell, stackBB29)) {
            noteFire('gto_depth_fallback');
          }
          const pick = rollMix(advice29.mix, fastRandom);
          if (pick) {
            if (telemetryOn(opts)) {
              noteFire(
                street === 'flop'
                  ? 'v29_gto_flop_open'
                  : street === 'turn'
                    ? 'v30_gto_turn_open'
                    : 'v30_gto_river_open'
              );
            }
            if (pick === 'check') return { action: 'check', thinkTime: 0 };
            if (pick === 'bet_small') {
              // Flop cells derive bet_small from ~third-pot c-bets; the
              // turn/river root vocabulary is the 16%-pot block/probe, so
              // those streets size it as a genuine block bet.
              const frac =
                street === 'flop' ? 0.32 + fastRandom() * 0.04 : 0.24 + fastRandom() * 0.08;
              return this.betSize(pot, frac, player, gs, vi, params, useSizing);
            }
            if (pick === 'bet_big') {
              return this.betSize(
                pot,
                0.7 + fastRandom() * 0.12,
                player,
                gs,
                vi,
                params,
                useSizing
              );
            }
          }
        }
      }
      // ═══ V11 INITIATIVE GATE (Dan 2026-08-22): no more donk leads ═══
      // A player WITHOUT the betting lead, acting BEFORE the prior-street
      // aggressor, checks the overwhelming majority of his range — strong
      // hands included (they check-raise or check-call; the facing-bet logic
      // below already plays those lines). Leading into the aggressor
      // ("donking") is reserved for the ranges solvers actually lead:
      // vulnerable made hands and monsters on DYNAMIC boards, low frequency.
      // In position it never applies — checked to us, the aggressor already
      // declined to bet, so stabbing/value-betting is not a donk.
      if (useV11 && useIQ && initiative === 'opp' && !prevChecked && !ip) {
        const donkLead =
          (vulnerable && wetness >= 0.5 && fastRandom() < 0.2) ||
          (equity >= multiwayValueBar(0.8, oppCount) + mw && wetness >= 0.55 && fastRandom() < 0.3);
        if (!donkLead) return { action: 'check', thinkTime: 0 };
      }
      // Monster: usually bet big, sometimes trap (never trap on wet or
      // freshly-dangered boards). V4: size to get stacks in by the river.
      if (equity >= multiwayValueBar(0.8, oppCount) + mw) {
        if (
          !isRiver &&
          wetness < 0.5 &&
          !scare.any &&
          !vulnerable &&
          fastRandom() < params.slowplayFreq &&
          oppCount <= 2
        ) {
          return { action: 'check', thinkTime: 0 };
        }
        // V12 RIVER OVERBET (G): with a nut-class hand heads-up on the river,
        // the value target is the opponent's whole continuing range — geometric
        // sizing leaves money on the table. Overbet 1.3-1.6x pot at a mixed
        // frequency; the blocker overbet-bluff below keeps it unexploitable.
        if (
          (opts.v12River ?? opts.v12) !== false &&
          isRiver &&
          oppCount === 1 &&
          cat >= 6 &&
          // V28 AUDIT FIX: `cat >= 6` is "any flush or better" — the V21 nut
          // discipline (which flush? whose boat?) was consulted only on the
          // CALLING side, so a nine-high flush on a four-flush river still
          // fired a 1.3-1.6x pot OVERBET here. A board-dominated hand is a
          // bluff-catcher whatever its category number; it does not overbet.
          !dominated21 &&
          !vi.isPotLimit &&
          fastRandom() < 0.35
        ) {
          return this.betSize(pot, 1.3 + fastRandom() * 0.3, player, gs, vi, params, useSizing);
        }
        let monsterFrac =
          geomFrac > 0
            ? Math.max(sizeBase + 0.2, geomFrac) + fastRandom() * 0.1
            : sizeBase + 0.3 + fastRandom() * 0.2;
        // V15: a "monster" by MC equity that is NOT nut-class (a dominated
        // flush multiway reads over 0.8 more often than it should) sizes
        // down in plo5/plo6 — small ball until the hand really is the nuts.
        if (!nutClass15 && vi.isOmaha) monsterFrac *= ploDamp;
        // V40: a pair / two pair / trips hand that reads as a "monster" by
        // MC is reading against the wrong range once its bets get called.
        // Small ball: never pot it on the turn or river, and with two
        // barrels already called the river is a check (the hands still in
        // are the ones that beat it). Sets and top two on a brick keep
        // their sizing (made40.weak is false there).
        if (useV40 && made40 != null && made40.weak) {
          if (isRiver && calledBarrels40 >= 2 && fastRandom() < 0.8) {
            if (tele15) noteFire('v40_no_third_barrel');
            return { action: 'check', thinkTime: 0 };
          }
          if (street !== 'flop' && monsterFrac > 0.5) {
            monsterFrac = 0.5;
            if (tele15) noteFire('v40_small_ball');
          }
        }
        // V28: the NLH mirror. A board-dominated hand (V21) that still reads
        // as a monster by MC sizes down instead of bombing — the calling side
        // already knew this; the betting side did not.
        if (useV21 && dominated21) monsterFrac = Math.min(monsterFrac, 0.5);
        return this.betSize(pot, monsterFrac, player, gs, vi, params, useSizing);
      }
      // Strong value. V4: a vulnerable made hand sizes UP and never checks
      // back; a dangered hand slows down instead of firing into the new nuts.
      if (equity >= multiwayValueBar(0.62, oppCount) + mw) {
        if (dangered && fastRandom() < 0.55) {
          return { action: 'check', thinkTime: 0 };
        }
        // V15: a dominated flush MULTIWAY checks most of the time — the
        // hands that continue against a bet on a three-flush board are
        // exactly the ones that beat it. Check-call is the line Dan asked
        // for; the facing-bet discipline below handles the rest of it.
        if (
          useV15 &&
          vi.isOmaha &&
          nuts15 != null &&
          cat === 6 &&
          nuts15.higherFlushRanks >= 2 &&
          oppCount >= 2 &&
          fastRandom() < 0.6
        ) {
          return { action: 'check', thinkTime: 0 };
        }
        // V40: the same small-ball law one tier down. A weak-class Omaha
        // made hand does not fire a third barrel into a range that called
        // two, and sizes its turn/river value at half pot or less.
        let cap40Frac = Infinity;
        if (useV40 && made40 != null && made40.weak) {
          if (isRiver && calledBarrels40 >= 2 && fastRandom() < 0.85) {
            if (tele15) noteFire('v40_no_third_barrel');
            return { action: 'check', thinkTime: 0 };
          }
          if (street !== 'flop') cap40Frac = 0.5;
        }
        const protection = vulnerable ? 0.1 : 0;
        return this.betSize(
          pot,
          Math.min(cap40Frac, (sizeBase + 0.12 + protection + fastRandom() * 0.15) * ploDamp),
          player,
          gs,
          vi,
          params,
          useSizing
        );
      }
      // V12 RIVER BLOCK BET (G): a medium showdown hand OUT OF POSITION on
      // the river sets its own price — a quarter-pot bet folds out overcards,
      // extracts thin value from worse, and denies the opponent the chance to
      // bomb a check. Heads-up only, never into the prior-street aggressor
      // (the V11 initiative gate above owns that node).
      if (
        (opts.v12River ?? opts.v12) !== false &&
        isRiver &&
        !ip &&
        oppCount === 1 &&
        equity >= 0.45 &&
        equity < 0.62 + mw &&
        initiative !== 'opp' &&
        fastRandom() < 0.4
      ) {
        return this.betSize(pot, 0.27 + fastRandom() * 0.06, player, gs, vi, params, useSizing);
      }
      // Thin value / protection — thinner into stations (valueThinMod > 1).
      // V4: vulnerable made hands always bet-protect; dangered hands check.
      // V5 river polarization: medium made hands stop thin-betting into
      // non-stations on the river — they get called by better and fold out
      // worse. Check back and win at showdown instead.
      if (
        equity >=
        multiwayValueBar(0.52, oppCount) + mw + thinAdj23 - (exploit.valueThinMod - 1) * 0.08
      ) {
        if (dangered) return { action: 'check', thinkTime: 0 };
        // V10: when hero HELD THE INITIATIVE and the river checks to us, the
        // opponent's range is capped (they would have raised their value along
        // the way), so a medium made hand should thin-value MORE, not fold out
        // worse by checking back. Requires positive evidence of a capped line —
        // an unknown/no-history river is NOT treated as capped (that is the V5
        // polarization spot, left intact).
        // NLH only: Omaha river value is already governed by V8 nut-
        // consciousness, and thin-value there over-bets non-nut hands.
        const cappedRiver = useThin10 && isRiver && useHR && initiative === 'hero' && !vi.isOmaha;
        const thinFreq = cappedRiver
          ? 0.72 // capped range checked to us — thin-value harder than the default
          : isRiver && useHR && exploit.valueThinMod <= 1.05 && equity < 0.62 + mw
            ? 0.25
            : 0.65;
        if (vulnerable || fastRandom() < thinFreq) {
          return this.betSize(
            pot,
            (sizeBase + fastRandom() * 0.12) * ploDamp,
            player,
            gs,
            vi,
            params,
            useSizing
          );
        }
        return { action: 'check', thinkTime: 0 };
      }
      // V7 BARREL CONTINUATION: hero fired a bluff/semi-bluff on the prior
      // street with a recorded plan. Planned lines keep firing on safe cards
      // (the story stays coherent); unplanned stabs shut down.
      if (
        useBarrels &&
        initiative === 'hero' &&
        barrelPlan !== undefined &&
        street !== 'flop' &&
        equity < 0.62
      ) {
        // V39: the card that came, against what the bet expected. A good
        // card fires the barrel more (the story became true); a blocked
        // scare card fires it as the bluff it was born for; an unblocked
        // scare card is the give-up the `!dangered` gate already enforces.
        const outlookMul39 =
          outlook39 === 'good' ? 1.4 : outlook39 === 'scare' ? (blocker ? 1.2 : 0.5) : 1;
        if (barrelPlan && !dangered && oppCount <= 2 && (equity >= 0.15 || blocker)) {
          // TUNED (duplicate-deal ablation): continuation frequencies cut
          // (turn 0.75->0.60, river 0.55->0.42) and total-air no-blocker
          // barrels abandoned — the original volume measurably lost.
          if (fastRandom() < (isRiver ? 0.35 : 0.52) * Math.min(1.25, bluffScale) * outlookMul39) {
            return this.betSize(
              pot,
              sizeBase + 0.15 + fastRandom() * 0.1,
              player,
              gs,
              vi,
              params,
              useSizing
            );
          }
        } else if (!barrelPlan && equity < 0.52 && fastRandom() < 0.8) {
          return { action: 'check', thinkTime: 0 }; // one-and-done — give up
        }
      }
      // ═══ V38 THE BET IS ARITHMETIC TOO (solverless games) ═══════════════
      // Below the value bars, hold'em plays the calibrated c-bet / probe /
      // semi-bluff / bluff ladder below (A/B-measured, and the solver layers
      // own the heads-up spots). Omaha, short deck, pineapple and fixed limit
      // have no solver and no such measurement, so from here down they play
      // the EV engine: every candidate size against MDF fold equity for THIS
      // table (each opponent's fold read), the continuing range's equity,
      // realization for the street and seat, rake and the survival premium.
      // The best action by EV, mixed near indifference. A bet from here is a
      // bluff or a semi-bluff, so it registers a barrel plan like every
      // heuristic bluff does.
      if (
        (opts.v38Ev ?? true) !== false &&
        (vi.isOmaha || vi.isShortDeck || vi.holeCount !== 2 || vi.isFixedLimit) &&
        !isRiver
      ) {
        let effOpp38 = 0;
        const models38: EvOpponentModel[] = [];
        for (const o of opponents) {
          const os = (isFinite(o.stack) ? o.stack : 0) + (isFinite(o.bet) ? o.bet : 0);
          if (os > effOpp38) effOpp38 = os;
          let foldMul = 1;
          if (useMind) {
            try {
              foldMul = HorseMind.exploit(o.user_id, useCounterAdapt).bluffMod;
            } catch {
              /* reads are best-effort */
            }
          }
          models38.push({ foldMul });
        }
        const drawy38 = cat <= 1 && drawsLive && equity >= (street === 'flop' ? 0.3 : 0.2);
        const verdict38 = evaluateSpot({
          equity,
          pot,
          toCall: 0,
          stack,
          effectiveStack: Math.min(stack, effOpp38 > 0 ? effOpp38 : stack),
          street: street === 'turn' ? 'turn' : 'flop',
          inPosition: ip,
          opponents: oppCount,
          models: models38,
          realization: realizationFactor({
            street: street === 'turn' ? 'turn' : 'flop',
            inPosition: ip,
            drawy: drawy38,
          }),
          rakeMarg:
            useRake10 && !isTournamentMode(gs)
              ? rakeDrag(
                  pot,
                  gs.bigBlind,
                  gs.rakeConfig,
                  gs.players.filter((candidate) => !candidate.is_sitting_out).length
                )
              : 0,
          riskPremium: risk,
          minBet: Math.max(gs.minRaise || 0, 0.01),
          maxBet: vi.isPotLimit ? pot : stack,
          initiative: initiative === 'hero' || prevChecked,
          // fixed limit has one size; pot limit tops out at the pot
          sizes: vi.isFixedLimit ? [1] : vi.isPotLimit ? [0.33, 0.5, 0.75, 1.0] : undefined,
          rand: fastRandom,
        });
        if (verdict38.pick.kind === 'bet') {
          if (tele15) noteFire('v38_ev_bet');
          planBarrel(equity);
          return this.betSize(pot, verdict38.pick.sizeFrac, player, gs, vi, params, useSizing);
        }
        if (tele15) noteFire('v38_ev_check');
        return { action: 'check', thinkTime: 0 };
      }
      // V4 CONTINUATION BET: the preflop/prior-street aggressor keeps the
      // pressure on favorable boards even without made equity. Small sizing,
      // dry-board + short-handed gated, position-scaled, station-aware.
      // V5 PROBE: when the previous street checked through, everyone's range
      // is capped — attack it even without the betting lead (delayed c-bet /
      // missed-c-bet stab).
      // V10: on a range-advantage board fire the whole range more often at a
      // smaller size (the classic high-freq small c-bet); otherwise keep the
      // V4 dry-board stab.
      // ═══ V17 RIVER DELAYED PROBE ═══ the turn checked through, the field
      // is capped, and nobody has claimed the pot. A small stab wins far more
      // often than equity says — at half the turn-probe frequency, only
      // short-handed, never on a scare card hero cannot represent.
      if (
        riverPrevChecked &&
        oppCount <= 2 &&
        !scare.any &&
        equity >= 0.15 &&
        equity < 0.5 &&
        fastRandom() < 0.28 * Math.min(1.3, bluffScale)
      ) {
        if (tele15) noteFire('v17_river_probe');
        return this.betSize(pot, 0.35 + fastRandom() * 0.1, player, gs, vi, params, useSizing);
      }
      let cbetFreqMult = boardFavorsAggressor ? 1.35 : 1.0;
      // V16 DEEP READS: heads-up, c-bet the player in front of you, not the
      // population average. 0.6 + ftc maps a 75% folder to x1.35 and a 30%
      // station to x0.9, clamped to keep the read a reshaping, not a switch.
      if (useMind && opts.v16Reads !== false && oppCount === 1) {
        try {
          const ftc = HorseMind.foldToCbetOf(opponents[0].user_id);
          if (ftc !== null) {
            cbetFreqMult *= Math.max(0.75, Math.min(1.4, 0.6 + ftc));
            if (tele15) noteFire('v16_reads_cbet');
          }
        } catch {
          /* reads are best-effort */
        }
      }
      const cbetSize = boardFavorsAggressor ? 0.28 + fastRandom() * 0.06 : 0.3 + fastRandom() * 0.1;
      if (
        (initiative === 'hero' || prevChecked) &&
        oppCount <= 2 &&
        wetness <= 0.45 &&
        !scare.any &&
        equity >= 0.18 &&
        equity < 0.52 &&
        !isRiver &&
        fastRandom() <
          (oppCount === 1 ? 0.6 : 0.35) *
            (prevChecked ? 1.15 : 1.0) *
            cbetFreqMult *
            Math.min(1.3, bluffScale)
      ) {
        planBarrel(equity);
        return this.betSize(pot, cbetSize, player, gs, vi, params, useSizing);
      }
      // Semi-bluff with live draws (equity from draws is in the MC number).
      // V4: made hands in this band (two pair on wet boards) prefer showdown
      // lines over bloating — only true draws semi-bluff.
      // V8: Omaha draws are QUALITY-gated — nut draws and wraps fight,
      // dominated flush draws without backup mostly give up.
      if (
        drawsLive &&
        equity >= 0.3 &&
        equity < 0.52 &&
        (cat <= 2 || !useIQ) &&
        // V28: the other unclamped bluff site — see the pure-bluff clamp.
        fastRandom() <
          params.bluffFreq *
            params.aggression *
            Math.min(1.3, bluffScale) *
            (oppCount === 1 ? 1.4 : 0.7) *
            omahaDrawMod()
      ) {
        planBarrel(equity);
        return this.betSize(
          pot,
          (sizeBase + 0.2 + fastRandom() * 0.15) * ploDamp,
          player,
          gs,
          vi,
          params,
          useSizing
        );
      }
      // Pure bluff — mostly heads-up, rarer on the river, blocker-preferred.
      // V4: a fresh scare card WE block is the best bluff trigger in poker.
      // V16 UNBLOCKER: on a river where the front-door flush MISSED (board
      // stuck at exactly two of a suit), a hero holding NONE of that suit
      // does not block the missed draws that make up the fold-out range —
      // the mathematically best bluff candidate. Modest boost, graded on top
      // of the existing nut-blocker logic.
      let unblock16 = 1.0;
      if ((opts.v16Blockers ?? true) !== false && isRiver && board.length >= 5) {
        const suitN16 = new Map<string, number>();
        for (const bc of board) suitN16.set(bc.suit, (suitN16.get(bc.suit) || 0) + 1);
        for (const [suit16, n16] of suitN16) {
          if (n16 === 2 && !player.cards.some((hc) => hc.suit === suit16)) {
            unblock16 = 1.15;
            if (tele15) noteFire('v16_unblocker');
            break;
          }
        }
      }
      const scareBluffBoost = (useIQ && scare.any && blocker ? 1.5 : 1.0) * unblock16;
      // V28 AUDIT FIX: this was one of two bluff sites with NO clamp on the
      // multiplier product. bluffScale alone reaches ~4.6 (exploit x blocker
      // x position x HU x river-read x spin x image x behind), and with the
      // scare boost the roll probability exceeded 1 — a DETERMINISTIC river
      // bluff, in exactly the spot (scare card + blocker) where the
      // opponent's range is strongest against air.
      // The clamp binds bluffScale alone so the scare/unblocker boost keeps
      // its RELATIVE effect (clamping the product collapsed the V16
      // unblocker distinction — both sides hit the ceiling). The product is
      // still bounded: bluffFreq <= ~0.3 x 1.3 x 1.725 x 0.55 < 0.86.
      if (
        equity < 0.3 &&
        oppCount === 1 &&
        fastRandom() <
          params.bluffFreq * Math.min(1.3, bluffScale) * scareBluffBoost * (isRiver ? 0.55 : 0.8)
      ) {
        planBarrel(equity);
        // V12 (G): river bluffs holding a nut blocker occasionally use the
        // SAME overbet size as the nut-class value hands — the pairing is
        // what makes the value overbets unexploitable.
        const overbetBluff =
          (opts.v12River ?? opts.v12) !== false &&
          isRiver &&
          blocker &&
          !vi.isPotLimit &&
          fastRandom() < 0.3;
        return this.betSize(
          pot,
          overbetBluff ? 1.3 + fastRandom() * 0.3 : sizeBase + 0.15 + fastRandom() * 0.2,
          player,
          gs,
          vi,
          params,
          useSizing
        );
      }
      return { action: 'check', thinkTime: 0 };
    }

    // ═══ Facing a bet ═══
    // (V10 rake drag `rakeMarg` is computed above the V32 consult — V34.)

    // ═══ V36 FREEROLL RAISE ═══ hero cannot lose a board, so hero cannot
    // lose money by continuing: with one of N boards locked, calling B into
    // P0 returns at least (P0 + 2B)/N — on two boards that is P0/2 + B >= B
    // for ANY bet; on three boards it is >= B for every bet up to the pot.
    // Inside that range fold is never on the menu; RAISE when the unlocked
    // boards carry a real chance to scoop (or to fold out whatever is beating
    // hero there), sized to put the money in — nothing can come back at it.
    // (A three-board overbet with a single lock falls through to the
    // equity-priced call below, which already carries the locked third.)
    const potFrac36 = toCall > 0 ? toCall / Math.max(1e-9, pot - toCall) : 0;
    if (
      multiBoard36 &&
      lockShare36 >= 1 / nBoards36 &&
      (nBoards36 === 2 || lockShare36 >= 2 / 3 || potFrac36 <= 1)
    ) {
      const raiseFreeroll =
        lockShare36 < 1 ? unlockedEq36 >= 0.2 && fastRandom() < 0.85 : fastRandom() < 0.9;
      if (raiseFreeroll) {
        if (tele15) noteFire('v36_freeroll_raise');
        const raiseToAmt = currentBet + (pot + toCall) * (0.9 + fastRandom() * 0.2);
        return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
      }
      if (tele15) noteFire('v36_freeroll_call');
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // ═══ V29 GTO FLOP DEFENSE — REMOVED 2026-08-29, the same day it
    // shipped. ═══ The consult assumed the warehouse held facing-a-bet
    // solves; it does not. Every solved tree is an open node, and the
    // 'facing' cells were aggregated from deep-tree labels whose exported
    // numbers are EV-magnitude contamination (fold "frequencies" averaging
    // 299 against calls in [0,1]) — rollMix read that as fold-almost-always
    // and the layer over-folded flops against first bets. The cells were
    // purged (migration 20260829213000), setGtoPostflop refuses facing rows
    // outright, and the heuristic facing-a-bet layers below decide, as they
    // did before V29. Do NOT rebuild this consult from gto_postflop_compact
    // unless genuinely facing-node solves have been added to the warehouse
    // and verified hand-by-hand (per-hand strategies summing to 1).
    // V28 AUDIT FIX: rake is a percentage of the WHOLE pot including hero's
    // call, so break-even equity is toCall / ((pot + toCall) * (1 - r)). The
    // old denominator pot*(1-r) + toCall applied the drag at ~60% of its true
    // size — horses called marginally too wide in small raked cash pots, the
    // opposite of the layer's stated intent. (gs.pot already includes the
    // outstanding bet; `pot` here is that minus any uncallable excess.)
    const potOdds = toCall / ((pot + toCall) * (1 - rakeMarg));
    // ═══ THE BET-RATIO SCALE, STATED ONCE AND FOR ALL (2026-08-27) ═══
    // `gs.pot` INCLUDES the bet hero is facing (HandController adds to
    // state.pot the moment the wager is posted). So `toCall / pot` is
    // bet/(pot+bet) — it approaches 0.5 for a POT-SIZED bet and can only
    // exceed 0.75 when the bet is THREE TIMES the pot. Every threshold in
    // this file written as if it were bet/pot has therefore been either far
    // looser than intended or literally unreachable. The 2026-08-23 handoff
    // already recorded one casualty ("the overbet-polarity branch had never
    // executed once"); telemetry now proves three more, at zero fires each
    // across 700,000 live decisions: v16_reads_tell, v17_catch_block and the
    // >1.2 overbet respect line.
    //
    // Both scales now exist explicitly, so nothing has to be inferred again:
    //   betRatio — legacy bet/(pot+bet). Untouched, because five older
    //              thresholds are calibrated against it and rescaling them is
    //              a STRATEGY change (that is what the v16Ratio experiment is
    //              for). Their behaviour is unchanged by this commit.
    //   potFrac  — the honest "fraction of the pot" a poker player means:
    //              bet / (pot before the bet). A pot-sized bet is 1.0, a
    //              half-pot 0.5, a 1.5x overbet 1.5.
    const betRatio = pot > 0 ? toCall / pot : 1;
    const potBeforeBet = Math.max(pot - toCall, 1e-9);
    const potFrac = toCall > 0 ? toCall / potBeforeBet : 0;

    // ═══ V11 BOARD DOMINATION DISCIPLINE (the "QQ on AKx" leak) ═══
    // The MC prices opponents by their PREFLOP range only — it cannot see
    // that a player firing big on an A/K-high board has connected with it.
    // A one-pair hand whose pair sits UNDER board overcards (an underpair,
    // or second/third pair) is exactly the hand class big bets dominate, so
    // it pays an explicit equity premium that grows with each overcard and
    // with bet size. Top pair (zero overcards above it) pays nothing.
    let dominationPenalty = 0;
    if (useV11 && useIQ && cat === 2 && !vi.isOmaha && betRatio >= 0.45) {
      const pr = onePairRank(player.cards, board);
      if (pr > 0) {
        let over = 0;
        for (const r of Object.keys(rankCounts) as Array<keyof typeof RANK_VALUES>) {
          if ((RANK_VALUES[r] ?? 0) > pr) over++;
        }
        if (over > 0) {
          dominationPenalty = 0.07 * Math.min(2, over) * (potFrac >= 0.8 ? 1.4 : 1);
        }
      }
    }
    // ═══ V20 WEAK TWO PAIR ON A PAIRED BOARD (the T8o-on-7798 leak) ═══
    // "Two pair" where the board supplies one of the pairs is one pair plus
    // community cards: every trips, every bigger pocket pair turned two-pair,
    // and every boat in the raising range dominates it. It pays the same kind
    // of explicit premium the V11 underpair pays — the MC cannot see that a
    // check-raise on a paired board IS trips most of the time.
    if (
      useV20 &&
      useIQ &&
      !vi.isOmaha &&
      cat === 3 &&
      pairedBoard &&
      (pressure20 >= 1 || potFrac >= 0.45)
    ) {
      const holeRanks20 = player.cards.map((c) => c.rank);
      const boardPairNotHeld = Object.entries(rankCounts).some(
        ([r, n]) => n >= 2 && !holeRanks20.includes(r as Card['rank'])
      );
      if (boardPairNotHeld) {
        dominationPenalty += 0.05 + (potFrac >= 0.8 ? 0.03 : 0) + Math.min(2, pressure20) * 0.02;
        if (tele15) noteFire('v20_weak2p_demote');
      }
    }
    // ═══ V15 OMAHA DOMINATION (the "small flush pays off" leak) ═══
    // The MC prices PLO opponents by preflop range; it cannot see that a big
    // bet or a raise on a three-flush board IS a bigger flush most of the
    // time. A non-nut flush (or non-nut straight) facing serious aggression
    // pays an explicit equity premium — the Omaha mirror of the V11 QQ-on-AKx
    // fix above, scaled by how many bigger flushes are live, by bet size, by
    // the raise-after-we-bet line, and by the multiway raiser's extra
    // nuttedness. Feeds the commit branch, the call margin, and the value-
    // raise bar below, exactly as the NLH penalty does.
    if (useV15 && vi.isOmaha && nuts15 != null && (betRatio >= 0.5 || raisedAfterAggr)) {
      let pen = 0;
      if (cat === 6) {
        const hf = nuts15.higherFlushRanks;
        pen = hf >= 4 ? 0.14 : hf >= 2 ? 0.1 : hf === 1 ? 0.05 : 0;
      } else if (cat === 5 && !nuts15.straightIsNut) {
        pen = 0.07;
      }
      if (pen > 0) {
        if (betRatio >= 0.9) pen *= 1.35;
        if (raisedAfterAggr) pen *= 1.3;
        if (oppCount >= 2) pen *= 1.15;
        dominationPenalty += Math.min(pen, 0.26);
      }
    }
    // ═══ V15 EQUITY CAP — a subtraction cannot fix a 50-point lie ═══
    // Against a RANDOM plo6 hand a nine-high flush on a three-flush river
    // reads ~80% — the MC has no way to know the raiser's range is bigger
    // flushes and boats, where its true equity is close to zero. When the
    // read is structural (we bet, they raised; or a big river bet arrives),
    // the equity USED for the decision is capped by how dominated the hand
    // is. Nut hands and full houses are untouched; before the river a
    // dominated flush keeps a little extra (it can still improve or be
    // splitting more often).
    let eq15 = equity;
    if (useV15 && vi.isOmaha && nuts15 != null && !nutClass15 && (cat === 5 || cat === 6)) {
      let cap = Infinity;
      const hf = cat === 6 ? nuts15.higherFlushRanks : 0;
      if (raisedAfterAggr) {
        if (cat === 6) cap = hf >= 4 ? 0.25 : hf >= 2 ? 0.35 : 0.55;
        else cap = 0.4; // dominated straight, raised
      } else if (isRiver && potFrac >= 0.8) {
        // Big river bet into us: "check-calling, or check-folding to big
        // bets" — the bigger the bet, the more nutted the range.
        if (tele15 && isRiver && potFrac >= 0.8) noteFire('v19_river_bigbet_cap');
        if (cat === 6 && hf >= 2) cap = potFrac >= 1.2 ? 0.32 : 0.42;
        else if (cat === 5) cap = potFrac >= 1.2 ? 0.38 : 0.48;
      }
      if (cap !== Infinity) {
        if (!isRiver) cap += 0.1; // redraws + protection before the river
        if (oppCount >= 2) cap -= 0.05; // a raise INTO A FIELD is more nutted
        eq15 = Math.min(equity, Math.max(0.05, cap));
        if (tele15 && eq15 < equity) noteFire('v15_eq_capped');
      }
    }

    // ═══ V40 OMAHA PRESSURE CAP (Dan 2026-09-04) ═══
    // The V15 cap stopped at straights and flushes; V20's pressure cap was
    // NLH-only. So an Omaha pair, two pair or trips facing a pot-sized line
    // was priced by the Monte Carlo alone, and the Monte Carlo (before the
    // V40 sampler) priced that line against the preflop band. Aces-up read
    // 41% on 4-5-7-5-J against a pot-pot-pot bettor; a pot bet needs 33%;
    // the horse called three streets. The cap is the class's ceiling
    // against a range that bets like this, lowered by every extra signal
    // (an earlier barrel, a pot-sized bet, a raise, a field) and lifted a
    // little before the river for the redraws. Sets on dry boards and top
    // two on a brick are not capped: folding range-tops to pressure is the
    // worse leak.
    if (useV40 && vi.isOmaha && made40 != null && made40.weak) {
      const heat40 =
        barrels40 +
        (potFrac >= 0.85 ? 1 : 0) +
        pressure20 +
        (raisedAfterAggr ? 1 : 0) +
        (oppCount >= 2 ? 1 : 0);
      if (heat40 >= 1 || potFrac >= 0.6) {
        let cap40: number;
        switch (made40.cls) {
          case 'air':
          case 'pair':
            cap40 = 0.28;
            break;
          case 'board2p':
            cap40 = 0.3;
            break;
          case 'low2p':
            cap40 = made40.boardPaired ? 0.32 : 0.36;
            break;
          case 'top2p':
            // Top two on a paired board is two pair against trips and
            // boats; on an unpaired board it is the class that stacks off
            // only into straights and flushes.
            cap40 = made40.boardPaired ? 0.34 : 0.5;
            break;
          case 'weaktrips':
            cap40 = 0.5;
            break;
          case 'set':
            cap40 = 0.62;
            break;
          default:
            cap40 = Infinity;
        }
        if (cap40 !== Infinity) {
          cap40 -= 0.05 * Math.max(0, Math.min(4, heat40) - 1);
          if (!isRiver) cap40 += street === 'flop' ? 0.1 : 0.04;
          // A nut draw alongside the made hand is real equity the cap
          // must not erase (top two with the nut flush draw stacks off).
          if (!isRiver && drawInfo40()?.nutty === true) cap40 += 0.12;
          const before40 = eq15;
          eq15 = Math.min(eq15, Math.max(0.08, cap40));
          if (tele15 && eq15 < before40) noteFire('v40_omaha_pressure_cap');
        }
      }
    }

    // ═══ V20 NLH-FAMILY EQUITY CAP — the V15 cap, ported off Omaha ═══
    // The MC prices opponents by ranges that cannot see a check-raise or a
    // cold all-in chain. On the 7798 board Dan watched, T8o's two pair read
    // high against sampled ranges while the LINE (bet, check-raise, all-in,
    // all-in) said trips-or-better everywhere. When the structural pressure
    // is on, the equity USED for the decision is capped by hand class.
    // Sets, straights and better are untouched — folding range-top hands to
    // pressure is a worse leak than the one this fixes.
    if (useV20 && !vi.isOmaha && pressure20 >= 1 && cat >= 1 && cat <= 4) {
      const isSet20 =
        cat === 4 && player.cards.length === 2 && player.cards[0].rank === player.cards[1].rank;
      if (!isSet20) {
        const weakTrips = cat === 4; // trips via the board's pair
        let cap20 = Infinity;
        if (pressure20 >= 3) cap20 = weakTrips ? 0.42 : cat === 3 ? 0.34 : 0.3;
        else if (pressure20 === 2) cap20 = weakTrips ? 0.5 : cat === 3 ? 0.44 : 0.4;
        else if (potFrac >= 0.6 || seriousAllIns20 >= 1)
          cap20 = weakTrips ? 0.62 : cat === 3 ? 0.56 : 0.52;
        if (cap20 !== Infinity) {
          if (!isRiver) cap20 += 0.08; // outs to boats/better two pair remain
          eq15 = Math.min(eq15, Math.max(0.05, cap20));
          if (tele15 && eq15 < equity) noteFire('v20_pressure_cap');
        }
      }
    }
    // ═══ V21 CAP FOR BOARD-DOMINATED "BIG" HANDS ═══ the V20 cap stopped at
    // cat 4 because straights and better looked like range-tops. The review
    // table says otherwise when the BOARD demotes them: a straight on a
    // three-flush board, a non-nut flush, the bottom boat. Under the same
    // structural pressure, those cap too — nut versions are untouched.
    if (
      useV21 &&
      !vi.isOmaha &&
      dominated21 &&
      ns21 != null &&
      (pressure20 >= 1 || (isRiver && potFrac >= 0.8))
    ) {
      let cap21 = Infinity;
      const heavy = pressure20 >= 2;
      if (cat === 5 && ns21.flushPossible) {
        // straight into a possible flush: the raiser HAS it most of the time
        cap21 = heavy ? 0.35 : ns21.fourFlushBoard ? 0.4 : 0.5;
      } else if (cat === 5) {
        // a bigger straight is live
        cap21 = heavy ? 0.4 : 0.55;
      } else if (ns21.higherFlushRanks >= 1 && (cat === 6 || (vi.isShortDeck && cat === 7))) {
        const hf = ns21.higherFlushRanks;
        cap21 = heavy ? (hf >= 3 ? 0.32 : 0.42) : hf >= 3 ? 0.45 : 0.55;
        if (ns21.fourFlushBoard) cap21 -= 0.07; // one-card flushes everywhere
      } else if (ns21.underfull) {
        // the bottom boat: any single card of the higher board pair beats it
        cap21 = heavy ? 0.4 : 0.55;
      }
      if (cap21 !== Infinity) {
        if (!isRiver) cap21 += 0.08;
        eq15 = Math.min(eq15, Math.max(0.05, cap21));
        if (tele15 && eq15 < equity) noteFire('v21_dominated_cap');
      }
    }
    // ═══ V21 SCARE-RUNOUT CAP ═══ the river completed a flush or straight
    // hero cannot beat and does not block, and a serious all-in (or a
    // near-pot bet) arrived ON it. The MC still prices the jammer by a range
    // from before the runout — two-pair-and-below reads 70% against ranges
    // that in reality just made their hand. (The A4-on-three-diamonds jam
    // call from the review table.) The premium alone cannot fix a 25-point
    // lie; the cap can.
    if (
      useV21 &&
      !vi.isOmaha &&
      isRiver &&
      dangered &&
      cat <= 3 &&
      (seriousAllIns20 >= 1 || potFrac >= 0.9)
    ) {
      if (eq15 > 0.45) {
        eq15 = 0.45;
        if (tele15) noteFire('v21_scare_cap');
      }
    }

    // The Phase 7 utility model must inherit every structural safety cap
    // (notably the multiway T8o and dominated-Omaha repairs), not resurrect
    // the raw random-range estimate after those layers have rejected it.
    if (phase7EquityEvidence) {
      const bounded7 = clamp01(eq15);
      phase7EquityEvidence.equity = bounded7;
      phase7EquityEvidence.standardError =
        phase7EquityEvidence.sampleSize > 0
          ? Math.sqrt((bounded7 * (1 - bounded7)) / phase7EquityEvidence.sampleSize)
          : 0;
    }

    if (isOmahaPolicyVariant(gs.gameVariant) && eq15 < equity) {
      phase11DecisionEquityCeiling = clamp01(eq15);
    }

    if (isRemainingPolicyVariant(gs.gameVariant) && eq15 < equity) {
      phase12DecisionEquityCeiling = clamp01(eq15);
    }

    if (gs.gameVariant === 'plo4') {
      const sampleCount = Math.max(
        1,
        Math.floor(equitySampleSizeOfLastCall() * (useAdaptiveMC ? 0.4 : 1))
      );
      const value = clamp01(eq15);
      phase10EquityEvidence = {
        equity: value,
        samples: sampleCount,
        standardError: Math.sqrt((value * (1 - value)) / sampleCount),
      };
    }

    // ═══ V23 PLAN CONSULT ═══ hero bet this street and got raised: the
    // answer was decided at bet time. foldToRaise folds (unless the price is
    // trivially too good); callOnce may continue but never escalates.
    let planCallOnly23 = false;
    if (useV23Plan && raisedAfterAggr) {
      const plan23 = HorseMind.getRaisePlan(
        HorseMind.handKeyOf(gs.actionHistory),
        player.user_id,
        street
      );
      // V28: the postflop mirror of the V25 commitment law — a stack that
      // already put ~30% of itself in this hand does not raise-FOLD at any
      // reasonable price. investedShare is hero's total commitment this hand
      // over what he started it with.
      const invested28 = Math.max(
        0,
        Number((player as { totalInvested?: number }).totalInvested ?? 0)
      );
      const investedShare28 = invested28 > 0 ? invested28 / (stack + invested28) : 0;
      if (plan23 === 'foldToRaise' && potOdds >= 0.15 && investedShare28 < 0.3) {
        if (tele15) noteFire('v23_plan_fold');
        return { action: 'fold', thinkTime: 0 };
      }
      if (plan23 === 'callOnce') {
        planCallOnly23 = true;
        if (tele15) noteFire('v23_plan_callonce');
      }
    }

    // Low-SPR commitment: with the money effectively in, play equity directly.
    // V28: money hero already put in THIS HAND commits him too — a horse that
    // raised 30% of its stack on the turn was previously judged by SPR alone
    // and could still raise-fold. (spr itself is now computed off the
    // effective pot, so a covering overbet no longer manufactures commitment.)
    const investedNow = Math.max(
      0,
      Number((player as { totalInvested?: number }).totalInvested ?? 0)
    );
    const committed =
      spr < 1.2 ||
      toCall >= stack ||
      (investedNow > 0 && investedNow / (stack + investedNow) >= 0.3);
    if (committed) {
      // V20: the flat-call bar here was potOdds + 0.02 regardless of how many
      // players were in or how many of them were ALL IN — the exact door the
      // T8o call-off walked through. The bar now carries half the multiway
      // tightening plus a premium per serious all-in in front.
      const commit20 = !useV20
        ? 0
        : Math.min(
            0.12,
            Math.max(0, mw) * 0.5 + seriousAllIns20 * 0.04 + (pressure20 >= 2 ? 0.03 : 0)
          );
      if (tele15 && commit20 > 0.04) noteFire('v20_commit_bar');
      // V21 SCARE RUNOUT: the committed branch ignored `dangered` entirely —
      // a fresh flush/straight completion hero does not beat (and cannot
      // block) got the same call bar as a blank. The A4-two-pair-calls-a-jam
      // -on-a-three-diamond-river hand from the review table pays this.
      const scare21 = useV21 && dangered ? 0.05 : 0;
      if (tele15 && scare21 > 0) noteFire('v21_scare_commit');
      // ═══ V23 PKO BOUNTY PRICING (2026-08-28) ═══ calling off against an
      // all-in hero COVERS pays the bounty on top of the pot — the required
      // equity drops by a share of the bounty factor. Only when hero truly
      // covers: an uncovered call risks hero's own bounty instead.
      let bounty23 = 0;
      if (
        (opts.v23Endgame ?? true) !== false &&
        isTournamentMode(gs) &&
        (trustedTournament?.bountyFactor ?? 0) >= 0.1 &&
        seriousAllIns20 >= 1
      ) {
        let biggestAllIn = 0;
        let allInId: string | undefined;
        for (const o of opponents) {
          if (o.is_all_in && isFinite(o.bet) && o.bet > biggestAllIn) {
            biggestAllIn = o.bet;
            allInId = o.user_id;
          }
        }
        if (biggestAllIn > 0 && stack + player.bet >= biggestAllIn) {
          // V37: the same bust the preflop pull prices — the live inventory
          // (top chest still in, or pulled) and THIS player's head.
          const scale37 =
            prizeLandscapeScale(gs, (opts.v26Prizes ?? true) !== false) *
            headBountyScale(gs, allInId);
          bounty23 = Math.min(0.08, (trustedTournament?.bountyFactor ?? 0) * 0.12 * scale37);
          if (tele15) noteFire('v23_bounty_call');
          if (tele15 && scale37 !== 1) noteFire('v37_bounty_call_scaled');
        }
      }
      const required = potOdds + 0.02 + dominationPenalty * 0.5 + commit20 + scare21 - bounty23;
      if (eq15 >= Math.max(required, 0.42 + mw + dominationPenalty * 0.5)) {
        // V15: a dominated flush/straight that still clears the (penalized)
        // bar CALLS rather than jams — shoving it has zero fold equity
        // against the range that just raised, and the raise-shove line with
        // a nine-high flush is the exact hand Dan watched. Sets and boats
        // keep the jam.
        // V21: a board-dominated NLH hand that still clears the bar CALLS
        // rather than jams — the same zero-fold-equity logic as Omaha's.
        // V28 AUDIT FIX: the committed branch ran BEFORE every plan consult
        // consumer and could jam over a `callOnce` plan — a bet that declared
        // "if raised, call once and never escalate" answered the raise with a
        // shove. The plan the bet made is honored here too.
        const preferFlat15 =
          (useV15 && vi.isOmaha && nuts15 != null && !nutClass15) ||
          (useV21 && dominated21) ||
          planCallOnly23;
        return toCall >= stack || preferFlat15
          ? { action: 'call', amount: toCall, thinkTime: 0 }
          : { action: 'all_in', thinkTime: 0 };
      }
      // V34: a solver-approved draw call is honored here too — the committed
      // bar must never fold a hand the solver's own range priced as a call.
      if (eq15 >= required || solverCall32) return { action: 'call', amount: toCall, thinkTime: 0 };
      return {
        action: 'fold',
        thinkTime: 0,
        ...(useV20 && pressure20 >= 2
          ? { continuationGuard: 'multiway_commitment_floor' as const }
          : dominated21 || (vi.isOmaha && made40?.weak && eq15 < equity)
            ? { continuationGuard: 'dominated_commitment_floor' as const }
            : {}),
      };
    }

    // Raise for value. V4: out of position lean harder on the check-raise
    // (denies equity + realizes fold equity); on a fresh scare card we do not
    // beat, downgrade the raise to a call.
    // V10 SPR / pot control: at an awkward mid SPR (2-4) medium made hands
    // stack off into trouble, so raise the bar and flat instead; at a low SPR
    // (<1.5) strong-not-nut hands should commit, so lower it. Nut hands clear
    // every bar regardless.
    const sprAdj = useSpr10 ? (spr >= 2 && spr <= 4 ? 0.03 : spr < 1.5 ? -0.03 : 0) : 0;
    // V11: a dominated one-pair hand is a bluff-catcher AT BEST — it never
    // raises for value, and the domination premium gates the raise band too
    // (QQ on AKx was sailing straight into this branch off inflated
    // no-reads equity and calling/raising the barrel off).
    const valueRaiseThresh =
      0.68 + mw + (isRiver ? 0.04 : 0) + sprAdj + dominationPenalty + (spin23 ? -0.02 : 0);
    if (eq15 >= valueRaiseThresh) {
      // V8 O8: never raise into a likely quarter — flat and see the split.
      if (quartered) return { action: 'call', amount: toCall, thinkTime: 0 };
      // V8 PLO: raising the river without a nut-class hand is the classic
      // Omaha punt — big made hands below flush strength flat unless the MC
      // says they are near-locks.
      if (useDraws && isRiver && cat < 6 && equity < 0.85) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // V15: the V8 gate above let ANY flush through ("cat < 6") and only
      // guarded the river. A dominated flush or straight now never raises on
      // any street unless the penalized equity still reads as a near-lock —
      // it check-calls, which is the small-ball line these variants demand.
      if (
        useV15 &&
        vi.isOmaha &&
        (cat === 5 || cat === 6) &&
        !nutClass15 &&
        eq15 - dominationPenalty < 0.85
      ) {
        if (tele15) noteFire('v15_raise_gate');
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // ═══ V21 RIVER RAISE-WAR GOVERNOR ═══ once hero's river aggression
      // has been raised, only the effective nuts keeps raising. Every 500bb
      // river war in the review table was a board-dominated hand re-raising:
      // the T7 straight four-betting a three-club board, sixes-full
      // re-raising JJ66x. A dominated hand that clears the bar CALLS; the
      // capped equity above decides call-vs-fold, never a re-raise.
      // A pocket set on a board with no possible flush or straight stays a
      // raising hand; everything below it — and a set on a board where
      // bigger hands are live — does not.
      const set21 =
        cat === 4 && player.cards.length === 2 && player.cards[0].rank === player.cards[1].rank;
      const dryTop21 = ns21 != null && !ns21.flushPossible && ns21.maxStraightTop === 0;
      if (
        planCallOnly23 ||
        (useV21 &&
          !vi.isOmaha &&
          (dominated21 || (raisedAfterAggr && (cat <= 3 || (cat === 4 && !(set21 && dryTop21))))))
      ) {
        if (planCallOnly23 || isRiver || raisedAfterAggr || pressure20 >= 2) {
          if (tele15) noteFire('v21_war_gate');
          return { action: 'call', amount: toCall, thinkTime: 0 };
        }
      }
      const oopBoost = useIQ && !ip ? params.checkRaiseFreq * 0.6 : 0;
      if (
        !(dangered && cat < 6) &&
        fastRandom() < 0.55 * params.aggression + params.checkRaiseFreq + oopBoost
      ) {
        // V18 EXPLOIT SIZING: on the river, a station (valueThinMod > 1)
        // pays a bigger raise; a nit calls only what a smaller one asks.
        let sizeF = 0.7 + fastRandom() * 0.4;
        if ((opts.v18ExploitSize ?? true) !== false && isRiver) {
          sizeF *= 1 + (exploit.valueThinMod - 1) * 0.5;
          if (tele15 && Math.abs(exploit.valueThinMod - 1) > 0.03) {
            noteFire('v18_exploit_size');
          }
        }
        const raiseToAmt = currentBet + (pot + toCall) * sizeF;
        return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
      }
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Semi-bluff raise with big draws (flop/turn only, not into a crowd,
    // gated by the target's fold tendency + our blockers). V4: pure draws
    // only — made hands in the band call instead of bloating the pot.
    // V8: Omaha raise semi-bluffs demand draw QUALITY too.
    if (
      !planCallOnly23 &&
      drawsLive &&
      equity >= 0.33 &&
      equity < 0.52 &&
      (cat <= 2 || !useIQ) &&
      oppCount <= 2 &&
      // Was `betRatio <= 0.85` — ALWAYS TRUE on the legacy scale (it maxes
      // near 0.5), so this gate never once stopped a semi-bluff raise, not
      // even into a three-times-pot bet. On the honest scale it means what
      // it says: do not raise as a semi-bluff into a bet bigger than 0.85x
      // the pot.
      potFrac <= 0.85 &&
      fastRandom() < params.bluffFreq * params.aggression * bluffScale * 0.5 * omahaDrawMod()
    ) {
      // V13: register the barrel plan. planBarrel was called on all three BET
      // paths and none of the RAISE paths, so a flop semi-bluff raise arrived
      // at the turn with no plan, skipped the barrel block entirely and
      // re-rolled the dice — the exact incoherence the V7 plan layer exists
      // to remove, on the lines where a coherent story matters most.
      planBarrel(equity);
      const raiseToAmt = currentBet + (pot + toCall) * (0.8 + fastRandom() * 0.3);
      return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
    }

    // V8 NLH: OOP check-raise bluff on a fresh scare card WE block — the
    // strongest bluff-raise trigger in holdem. Heads-up, modest bet only.
    // V16 RATIO (flagged OFF, league-measured): the 0.6 gate reads as
    // bet/(pot+bet) intent — on the bet/pot scale the equivalent is 1.5.
    if (
      !planCallOnly23 &&
      useNlhX &&
      !ip &&
      scare.any &&
      blocker &&
      equity >= 0.2 &&
      equity < 0.42 &&
      oppCount === 1 &&
      betRatio <= (opts.v16Ratio === true ? 1.5 : 0.6) &&
      fastRandom() < params.bluffFreq * params.aggression * 0.25 * Math.min(1.2, bluffScale)
    ) {
      // V13: same as above — a check-raise bluff is the start of a story.
      planBarrel(equity);
      const raiseToAmt = currentBet + (pot + toCall) * (0.85 + fastRandom() * 0.25);
      return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
    }
    // V8 NLH: river blocker raise-bluff — polarizing raise with air that
    // blocks the nuts. Low frequency; makes the value raises unexploitable.
    if (
      !planCallOnly23 &&
      // V28 AUDIT FIX: this branch could RE-RAISE a river raise with air —
      // the V21 war gate ("once hero's river aggression is raised, only the
      // effective nuts keeps raising") lives inside the value branch and
      // never reached here, so the 500bb river bluff wars came from THIS
      // side. Hero's raised river aggression closes the bluff-raise too.
      !raisedAfterAggr &&
      useNlhX &&
      isRiver &&
      oppCount === 1 &&
      blocker &&
      equity < 0.3 &&
      // Was `betRatio <= 0.75` — also always true, so river blocker
      // raise-bluffs fired into any sizing at all.
      potFrac <= 0.75 &&
      fastRandom() < params.bluffFreq * 0.35 * Math.min(1.2, bluffScale)
    ) {
      const raiseToAmt = currentBet + (pot + toCall) * (1.0 + fastRandom() * 0.3);
      return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
    }

    // V34: every raise gate above has had its roll. The solver's range said
    // this draw is a call at this price, and that answer outranks the
    // heuristic price test below (which prices the same call against a
    // preflop-band range rather than the range that actually bet).
    if (solverCall32) return { action: 'call', amount: toCall, thinkTime: 0 };

    // Call when the price is right. Margin scales with bet size; draws get a
    // small implied-odds allowance before the river. V3: a maniac's bets need
    // less respect (callDownMod > 1); a passive player's bets need more.
    // V4: bets fired ON a fresh scare card into a hand that does not beat the
    // new class get extra respect; in-position calls realize equity better.
    // V11: a dominated pair has REVERSE implied odds (improving to a set can
    // still lose to a higher set / straight the same range makes) — it gets
    // no implied-odds allowance.
    // V23 VARIANTS: a plo8 draw whose value is ONE-WAY LOW is drawing at half
    // the pot with quarter risk — it gets no implied credit at all; short
    // deck draws complete more often and earn a bit extra.
    const loOnly23 =
      useV23Var && useHiLo && !!hiLoSplit && hiLoSplit.hi < 0.15 && hiLoSplit.lo > 0.3;
    const impliedBonus =
      drawsLive && equity >= 0.25 && dominationPenalty === 0 && !loOnly23
        ? 0.04 + (useV23Var && vi.isShortDeck ? 0.02 : 0)
        : 0;
    // V35: fixed limit calls lighter — the pot always lays the price.
    let respect = 2 - exploit.callDownMod + (params.callRespect ?? 0); // maniac 0.8, neutral 1, passive 1.15
    if (dangered) respect += 0.15;
    // V12 ANTI-EXPLOIT: when the CURRENT street's bettor has been hunting
    // this horse specifically, their bets carry less real strength than the
    // line suggests — call down lighter until the hunt stops paying.
    if (useMind && opts.v12 !== false) {
      try {
        const hist = gs.actionHistory || [];
        let bettorId: string | null = null;
        for (const a of hist) {
          if (a.stage !== street) continue;
          if (
            a.userId !== player.user_id &&
            (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
          ) {
            bettorId = a.userId;
          }
        }
        if (bettorId) {
          const hunted = HorseMind.targetingOf(player.user_id, bettorId);
          if (hunted > 0) respect -= 0.25 * hunted;
          // V16 DEEP READS: a big river bet from a player whose big bets
          // have SHOWN DOWN as value gets real respect; one who bombs with
          // air gets called down. Only on the river, only on big sizings —
          // exactly where the tell was observed.
          if (opts.v16Reads !== false && isRiver && potFrac >= 0.75) {
            const tell = HorseMind.bigBetValueTendency(bettorId);
            if (tell !== null) {
              if (tell >= 0.75) respect += 0.12;
              else if (tell <= 0.4) respect -= 0.1;
              if (telemetryOn(opts)) noteFire('v16_reads_tell');
            }
          }
          // ═══ V43 TEMPO (2026-09-05) ═══ the action log has carried a
          // timestamp on every record since the engine was written, and no
          // read ever looked at it. How fast THIS bet was made, against what
          // this player's bets at that tempo have shown down as. Same gate
          // as the V16 tell: river, big sizing, a real sample. A human's
          // snap-bet is the oldest tell in the game; a horse's tempo is
          // randomised (V14), so the read learns nothing from the fleet and
          // everything from a person.
          if ((opts.v43Tempo ?? true) !== false && isRiver && potFrac >= 0.75) {
            let betTs: number | null = null;
            let prevTs: number | null = null;
            for (const a of hist) {
              const ts =
                typeof a.timestamp === 'number' && isFinite(a.timestamp) ? a.timestamp : null;
              if (
                a.stage === street &&
                a.userId === bettorId &&
                (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
              ) {
                betTs = ts;
                break;
              }
              if (ts !== null) prevTs = ts;
            }
            const gap = betTs !== null && prevTs !== null ? betTs - prevTs : null;
            if (gap !== null && gap >= 0) {
              const tendency =
                gap <= SNAP_MS
                  ? HorseMind.snapBetValueTendency(bettorId)
                  : gap >= TANK_MS
                    ? HorseMind.tankBetValueTendency(bettorId)
                    : null;
              if (tendency !== null) {
                if (tendency >= 0.75) respect += 0.08;
                else if (tendency <= 0.4) respect -= 0.08;
                if (telemetryOn(opts)) noteFire('v43_tempo_read');
              }
            }
          }
        }
      } catch {
        /* targeting is best-effort */
      }
    }
    // V7 overbet polarity: an overbet is nuts-or-bluffs. Medium hands without
    // a nut blocker fold more; holding the blocker shifts toward the catch.
    // Was `betRatio > 1.2` — unreachable, and the handoff's documented
    // never-executed branch. On the honest scale 1.2 means a 1.2x-pot
    // overbet, which is exactly what the comment above always described.
    if (useSizeReads && potFrac > 1.2) {
      respect += blocker ? -0.05 : 0.08;
      if (tele15) noteFire('v19_overbet_polarity');
    }
    // ═══ V17 CALL-SIDE BLOCKER ═══ facing a big river bet on a board whose
    // front-door flush draw MISSED, a hero holding two-plus cards of that
    // suit holds the bluffs himself — the bettor's range just lost most of
    // its air. Fold more. (The mirror of the V16 unblocker bluff.)
    if ((opts.v17CatchBlock ?? true) !== false && isRiver && potFrac >= 0.75 && board.length >= 5) {
      const suitN17 = new Map<string, number>();
      for (const bc of board) suitN17.set(bc.suit, (suitN17.get(bc.suit) || 0) + 1);
      for (const [suit17, n17] of suitN17) {
        if (n17 === 2 && player.cards.filter((hc) => hc.suit === suit17).length >= 2) {
          respect += 0.08;
          if (telemetryOn(opts)) noteFire('v17_catch_block');
          break;
        }
      }
    }
    // V12 (G): the same blocker logic extends into the big-bet band (0.8-1.2
    // pot) on the river — large river bets are already polarized enough that
    // the blocker meaningfully changes the catch.
    // Was betRatio 0.8..1.2: the top of that band is unreachable and the
    // bottom needed a 4x-pot bet. On the honest scale this is the big-bet
    // band the comment describes.
    if ((opts.v12River ?? opts.v12) !== false && isRiver && potFrac >= 0.8 && potFrac <= 1.6) {
      respect += blocker ? -0.04 : 0.04;
    }
    // (V10 explored a river blocker-aware bluff-catch adjustment here; the
    // duplicate-deal A/B showed it LEAKED in both directions — the V4/V7 river
    // logic is already well-calibrated — so it was dropped, not shipped.)
    // V8: OOP calls tighten further multiway — equity realization out of
    // position degrades with every extra live opponent.
    const posEdge = useIQ ? (ip ? -0.012 : 0.008 * (useNlhX ? 1 + 0.3 * (oppCount - 1) : 1)) : 0;
    const sizingPenalty =
      (Math.min(0.06, betRatio * 0.04) + mw * 0.5) * respect + (loOnly23 ? 0.03 : 0);
    /**
     * ═══ V38 THE CALL IS ARITHMETIC, NOT A FLAT LINE (Dan 2026-09-03) ═══
     *
     * "The heuristic river call line folds ~67% to a 75% bet heads-up (a
     *  solver ~50-55%) ... THIS NEEDS TO BE SOLVER BASED, IT SHOULDN'T BE A
     *  FLAT LINE VARIABLE."
     *
     * The line below this comment was `potOdds + 0.03 x respect + a sizing
     * penalty + a position edge + the domination penalty`: four constants
     * stacked on the pot odds. On the river none of them belongs there. A
     * river call closes the hand, so realization is exactly 1 and the only
     * question is whether equity against the range that bet clears the
     * raked pot odds (plus the survival premium in a tournament). Everything
     * the constants were standing in for - the villain's line, their sizing,
     * their tendencies, hero's domination on the board - already reached
     * this decision through the equity: the range read narrowed the sample,
     * the V15/V20/V21 caps cut it where the line says the range is stronger,
     * and `respect` carries the exploit reads. So on the river those reads
     * are applied to the EQUITY (respect above 1 is "their bets are stronger
     * than the read", a few points off), and the call is the MDF call:
     * equity >= required, mixed inside 1.5 points of indifference.
     *
     * For the games with no solver export the same engine decides EVERY
     * postflop fold/call: realized equity (street, position, draws) against
     * the raked pot odds, the survival premium charged by the share of stack
     * at risk. Hold'em before the river keeps the calibrated heuristic line -
     * V32 owns the heads-up spots it can read, and the line is A/B-measured
     * where it cannot.
     */
    const useEv38 = (opts.v38Ev ?? true) !== false;
    const solverless38 = vi.isOmaha || vi.isShortDeck || vi.holeCount !== 2 || vi.isFixedLimit;
    if (useEv38 && (isRiver || solverless38) && !solverCall32) {
      // the exploit reads, as an equity shift instead of a margin
      const readShift38 = -(respect - 1) * 0.08;
      const eqRead38 = clamp01(
        eq15 + impliedBonus + readShift38 - dominationPenalty - (loOnly23 ? 0.03 : 0)
      );
      const risk38 = risk > 0 && stack > 0 ? risk : 0;
      if (isRiver) {
        const v = riverCallVerdict({
          equity: eqRead38,
          pot,
          toCall,
          stack,
          rakeMarg,
          riskPremium: risk38,
          rand: fastRandom,
        });
        if (tele15) noteFire(v.call ? 'v38_river_call' : 'v38_river_fold');
        if (v.call) return { action: 'call', amount: toCall, thinkTime: 0 };
        return { action: 'fold', thinkTime: 0 };
      }
      // Flop / turn in a solverless game: realized equity vs the raked price.
      const drawy38 = cat <= 1 && drawsLive && equity >= (street === 'flop' ? 0.3 : 0.2);
      const realization38 = realizationFactor({
        street: street === 'turn' ? 'turn' : 'flop',
        inPosition: ip,
        drawy: drawy38,
      });
      const verdict38 = evaluateSpot({
        equity: eqRead38,
        pot,
        toCall,
        stack,
        effectiveStack: stack,
        street: street === 'turn' ? 'turn' : 'flop',
        inPosition: ip,
        opponents: oppCount,
        realization: realization38,
        rakeMarg,
        riskPremium: risk38,
        minBet: Math.max(gs.minRaise || 0, 0.01),
        maxBet: 0, // fold/call only here: the raise gates above already rolled
        sizes: [],
        rand: fastRandom,
      });
      const callEv = verdict38.candidates.find((a) => a.kind === 'call');
      if (callEv && callEv.ev >= 0) {
        if (tele15) noteFire('v38_ev_call');
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      if (tele15) noteFire('v38_ev_fold');
      return { action: 'fold', thinkTime: 0 };
    }
    if (
      eq15 + impliedBonus >=
      potOdds + 0.03 * respect + sizingPenalty + posEdge + dominationPenalty
    ) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Disciplined bluff-catch vs small bets heads-up on the river — more
    // often against aggressive opposition, less against passives. V4: when
    // the river completed the draws and we hold no blocker, catch less.
    const catchScale = dangered ? 0.12 : 0.25;
    // V16 RATIO (flagged OFF): 0.4 as bet/(pot+bet) = 0.667 as bet/pot.
    if (
      isRiver &&
      oppCount === 1 &&
      betRatio <= (opts.v16Ratio === true ? 0.667 : 0.4) &&
      eq15 >= potOdds - 0.04 &&
      fastRandom() < catchScale * exploit.callDownMod
    ) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    return { action: 'fold', thinkTime: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────
  // PINEAPPLE DISCARD — pick the discard that maximizes equity
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Choose which of the 3 hole cards to discard (returns the card INDEX).
   * Evaluates the equity of each 2-card keep against the current board.
   * V9: 400 iterations per keep (was 160) — the discard happens once per hand,
   * so the extra precision is effectively free and tightens marginal keeps.
   */
  static decideDiscard(cards: Card[], communityCards: Card[], gameVariant: string): number {
    /* One chooser, shared with the engine's own auto-resolve. It used to live
       here alone, and HandController answered the same question with a worse
       rule - see pineappleDiscardChoice.ts. CLAUDE.md 10.5: a horse and a human
       are treated identically, which cannot be true of a decision made by two
       different pieces of code. */
    return bestPineappleDiscard(cards, communityCards, gameVariant);
  }

  // ─────────────────────────────────────────────────────────────────────
  // SIZING + LEGALIZATION HELPERS
  // ─────────────────────────────────────────────────────────────────────

  /** Build a bet decision sized as a fraction of pot, clamped to legal bounds.
   *  V9: fractions snap to human size FAMILIES (third/half/two-thirds/
   *  three-quarters/pot/overbet) unless the caller disables it — continuous
   *  uniform sizing was the last mechanical tell in the bet line. */
  private static betSize(
    pot: number,
    fraction: number,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams,
    snap: boolean = true
  ): HorseDecision {
    const frac = snap ? snapFraction(fraction, params.familyBias ?? 0.5) : fraction;
    // V23: a chip is actually going in — record the raise-response plan.
    if (pendingRaisePlan && gs.stage !== 'preflop') {
      HorseMind.noteRaisePlan(
        HorseMind.handKeyOf(gs.actionHistory),
        player.user_id,
        gs.stage,
        pendingRaisePlan
      );
      pendingRaisePlan = null;
    }
    return this.legalize(
      { action: 'bet', amount: pot * frac * params.sizingMultiplier, thinkTime: 0 },
      player,
      gs,
      vi
    );
  }

  /**
   * The pot-limit preflop raise-TO for this decision, shaded by the persona's
   * own sizing dial and floored at `floorTo`. Shares `ploRaiseTo` with the V7
   * preflop layer so the two paths cannot drift into sizing PLO differently.
   */
  private static ploPreflopRaiseTo(
    gs: HorseGameStateV2,
    player: SeatPlayer,
    params: StyleParams,
    floorTo = 0
  ): number {
    const currentBet = isFinite(gs.currentBet) ? Math.max(0, gs.currentBet) : 0;
    const toCall = Math.max(0, currentBet - (isFinite(player.bet) ? player.bet : 0));
    const potTo = potLimitRaiseTo(gs.pot, currentBet, toCall);
    return ploRaiseTo(params.sizingMultiplier, potTo, fastRandom, floorTo);
  }

  /** Build a raise decision to an absolute amount, clamped to legal bounds. */
  private static raiseTo(
    target: number,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    const action = gs.currentBet > 0 ? 'raise' : 'bet';
    // V23: same recording as betSize — every postflop raise carries its plan.
    if (pendingRaisePlan && gs.stage !== 'preflop') {
      HorseMind.noteRaisePlan(
        HorseMind.handKeyOf(gs.actionHistory),
        player.user_id,
        gs.stage,
        pendingRaisePlan
      );
      pendingRaisePlan = null;
    }
    return this.legalize({ action, amount: target, thinkTime: 0 }, player, gs, vi);
  }

  /**
   * Final safety pass: whatever the strategy produced, make it LEGAL under the
   * engine's validateAction() rules — including no-limit stack bounds,
   * min-bet / min-raise floors, pot-limit caps (Bible V8 §4.14), and whole-cent
   * amounts (Bible V8 §2.6). Falls back down the ladder raise -> call -> check
   * when a desired action has no legal sizing.
   */
  private static legalize(
    d: HorseDecision,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    const structurallyLegal = this.capPotLimitJam(
      this.legalizeInner(d, player, gs, vi),
      player,
      gs,
      vi
    );
    return enforceAuthoritativeDecision(structurallyLegal, player, gs);
  }

  /**
   * Dan 2026-08-21: "in PLO you can never go all in if the pot is less than the
   * chips you have — the most you can ever bet is pot."
   *
   * That rule shipped in PokerEngine.validateAction, and it made a decision the
   * horses were still perfectly happy to produce ILLEGAL. `legalizeInner` ends
   * with `return d; // fold / check / all_in are always legal here`, which had
   * been true for as long as it had been written and stopped being true the
   * moment the cap landed. Several branches above also short-circuit to
   * `all_in` on their own (a bet at >=92% of stack, a raise at >=95%), so there
   * is no single place inside that function to fix it.
   *
   * This wraps the whole thing instead: whatever comes out, if it is an all-in
   * that exceeds the pot-limit cap, it becomes the largest LEGAL wager — a
   * pot-sized raise — or a call when no raise is legal at all. Shoving a short
   * stack is untouched: an all-in at or under the cap is legal and stays.
   *
   * The betting state is built exactly as `verifyAmount` and
   * `HandController.performAction` build theirs, so the cap the horse respects
   * is the same number the engine will check it against, to the cent.
   */
  private static capPotLimitJam(
    d: HorseDecision,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    if (d.action !== 'all_in' || !vi.isPotLimit) return d;

    const currentBet = isFinite(gs.currentBet) ? Math.max(0, gs.currentBet) : 0;
    const pot = isFinite(gs.pot) ? Math.max(0, gs.pot) : 0;
    const playerBet = isFinite(player.bet) ? Math.max(0, player.bet) : 0;
    const stack = isFinite(player.stack) ? Math.max(0, player.stack) : 0;
    if (stack <= 0) return d;

    const bs = calculateBettingState(
      pot,
      currentBet,
      playerBet,
      gs.bigBlind || 0.02,
      gs.lastRaise ?? gs.minRaise,
      true
    );
    if (bs.maxRaise === undefined) return d;

    const allInTo = playerBet + stack;
    const capTo = currentBet + bs.maxRaise;
    if (allInTo <= capTo + 0.005) return d; // a legal jam — leave it alone

    const toCall = Math.max(0, currentBet - playerBet);
    const legalTo = floorCents(capTo);
    const minTo = ceilCents(currentBet + Math.max(gs.minRaise || 0, 0.01));

    if (legalTo >= minTo) {
      // Betting the pot IS the biggest legal wager here. Route it back through
      // the ordinary sizing path so it picks up chip-step snapping and the
      // engine-parity amount verification.
      return this.legalizeInner(
        { action: currentBet > 0 ? 'raise' : 'bet', amount: legalTo, thinkTime: 0 },
        player,
        gs,
        vi
      );
    }

    // No legal raise sizing exists at all: call what is owed, or check.
    return toCall > 0
      ? { action: 'call', amount: toCents(Math.min(toCall, stack)), thinkTime: 0 }
      : { action: 'check', thinkTime: 0 };
  }

  private static legalizeInner(
    d: HorseDecision,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    const currentBet = isFinite(gs.currentBet) ? Math.max(0, gs.currentBet) : 0;
    const pot = isFinite(gs.pot) ? Math.max(0, gs.pot) : 0;
    const playerBet = isFinite(player.bet) ? Math.max(0, player.bet) : 0;
    const stack = isFinite(player.stack) ? Math.max(0, player.stack) : 0;
    const toCall = Math.max(0, currentBet - playerBet);

    // Normalize impossible action/context combinations.
    if (d.action === 'check' && toCall > 0) d = { action: 'fold', thinkTime: 0 };
    if (d.action === 'fold' && toCall === 0) d = { action: 'check', thinkTime: 0 };
    if (d.action === 'call' && toCall === 0) d = { action: 'check', thinkTime: 0 };
    if (d.action === 'bet' && currentBet > 0)
      d = { action: 'raise', amount: d.amount, thinkTime: 0 };
    if (d.action === 'raise' && currentBet === 0)
      d = { action: 'bet', amount: d.amount, thinkTime: 0 };

    if (d.action === 'call') {
      if (toCall >= stack) return { action: 'all_in', thinkTime: 0 };
      return { action: 'call', amount: toCents(toCall), thinkTime: 0 };
    }

    if (d.action === 'bet') {
      let amt = d.amount ?? gs.minRaise;
      if (!isFinite(amt) || amt <= 0) return { action: 'check', thinkTime: 0 };
      // Engine rule: min bet = minRaise (= max(bigBlind, lastRaise)).
      const minBet = ceilCents(Math.max(gs.minRaise || 0, 0.01));
      // Engine rule (pot-limit): max bet = pot + toCall.
      const maxBet = vi.isPotLimit ? floorCents(pot + toCall) : Infinity;
      if (minBet > maxBet || minBet >= stack) {
        // No legal non-all-in bet exists. A jam is only a legal substitute
        // when the jam itself is inside the pot-limit cap — see the note on
        // the 0.92 shortcut below.
        const jamIsLegal = !vi.isPotLimit || stack <= maxBet + 0.005;
        // V13: dropped the `amt >= stack * 0.9` test. Once minBet >= stack there
        // is no legal sized bet at all, so the jam IS the bet — requiring the
        // intended size to be near the whole stack just threw the aggression
        // away. A horse that chose a small block bet with the nuts on a short
        // stack checked instead of jamming.
        return jamIsLegal ? { action: 'all_in', thinkTime: 0 } : { action: 'check', thinkTime: 0 };
      }
      // Whole dollars in cash games (see chipStep). Clamped inside snapBetSize
      // so rounding can never drop below minBet or above the pot-limit cap.
      amt = snapBetSize(amt, minBet, Math.min(maxBet, stack), chipStep(gs.bigBlind));
      // 2026-08-22: this shortcut had no pot-limit guard, and the raise
      // branch below already had one (`maxRaiseTo <= potLimitTo`). Dan
      // 2026-08-21: "in PLO you can never go all in if the pot is less than
      // the chips you have — the most you can ever bet is pot."
      //
      // capPotLimitJam exists to enforce exactly that, and it works by
      // rewriting an over-cap jam into a pot-sized bet and routing it back
      // through THIS function for snapping and verification. When the pot is
      // 92% or more of the stack, this line then turned that pot-sized bet
      // straight back into an uncapped all-in — outside the wrapper, which
      // had already run. The engine rejected the result:
      //
      //   ILLEGAL plo4/river: all_in undefined — Pot-limit max is 300
      //   (stack=322.2566, pot=300, currentBet=0)
      //
      // A rejected action is the worst outcome a horse can produce, so the
      // jam is only substituted when the jam is itself legal.
      if (amt >= stack * 0.92 && (!vi.isPotLimit || stack <= maxBet + 0.005)) {
        return { action: 'all_in', thinkTime: 0 };
      }
      return this.verifyAmount(
        { action: 'bet', amount: toCents(amt), thinkTime: 0 },
        player,
        gs,
        vi,
        { action: 'check', thinkTime: 0 }
      );
    }

    if (d.action === 'raise') {
      let amt = d.amount ?? 0;
      const fallback = (): HorseDecision =>
        toCall > 0
          ? toCall >= stack
            ? { action: 'all_in', thinkTime: 0 }
            : { action: 'call', amount: toCents(toCall), thinkTime: 0 }
          : { action: 'check', thinkTime: 0 };
      if (!isFinite(amt) || amt <= 0) return fallback();

      // Engine rules: raise-to must satisfy (amount - currentBet) >= minRaise,
      // amount <= playerBet + stack, and pot-limit (amount - currentBet) <= pot + toCall.
      const minRaiseTo = ceilCents(currentBet + Math.max(gs.minRaise || 0, 0.01));
      const maxRaiseTo = playerBet + stack;
      const potLimitTo = vi.isPotLimit ? floorCents(currentBet + pot + toCall) : Infinity;
      const cap = Math.min(maxRaiseTo, potLimitTo);

      if (minRaiseTo > cap) {
        // No legal raise sizing exists. Jam only if the jam is itself a big
        // commitment we intended; otherwise fall back to calling.
        if (amt >= maxRaiseTo && maxRaiseTo <= potLimitTo)
          return { action: 'all_in', thinkTime: 0 };
        return fallback();
      }
      // Whole dollars in cash games (see chipStep), clamped between the legal
      // min raise-to and the pot-limit/stack cap so rounding stays legal.
      amt = snapBetSize(amt, minRaiseTo, cap, chipStep(gs.bigBlind));
      if (amt >= maxRaiseTo * 0.95 && maxRaiseTo <= potLimitTo) {
        return { action: 'all_in', thinkTime: 0 };
      }
      return this.verifyAmount(
        { action: 'raise', amount: toCents(amt), thinkTime: 0 },
        player,
        gs,
        vi,
        fallback()
      );
    }

    // fold / check are always legal here. all_in is legal in no-limit and, in
    // pot-limit, only up to the pot — capPotLimitJam (the wrapper above) is
    // what enforces that, on every branch of this function including the ones
    // that short-circuit to all_in on their own.
    return d;
  }

  /**
   * AUDIT V2: final verification against the ENGINE'S OWN validateAction().
   * IEEE 754 drift in DB-loaded floats (e.g. currentBet + minRaise summing to
   * 13.040000000000001) can make a boundary-exact amount fail the engine's
   * strict comparison. Verify the exact amount; nudge one cent up (min-raise
   * boundaries) then one cent down (pot-limit caps); otherwise fall back to a
   * guaranteed-legal action. A horse action can therefore NEVER be rejected.
   */
  private static verifyAmount(
    d: HorseDecision,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    fallback: HorseDecision
  ): HorseDecision {
    const bs = calculateBettingState(
      gs.pot,
      gs.currentBet,
      player.bet,
      gs.bigBlind || 0.02,
      // Exact parity with HandController.performAction: it passes state.lastRaise.
      gs.lastRaise ?? gs.minRaise,
      vi.isPotLimit
    );
    // Try the exact amount, then nudge by ONE CHIP first (a whole dollar in
    // cash games) so the boundary retry cannot reintroduce the cent amounts
    // Dan asked us to get rid of. The one-cent nudges stay as the last resort
    // before the fallback: an ugly-but-legal action still beats a rejected one,
    // and this path only runs when the exact amount failed validation.
    const step = chipStep(gs.bigBlind);
    const candidates =
      step === 1
        ? [
            d.amount!,
            d.amount! + 1,
            d.amount! - 1,
            toCents(d.amount! + 0.01),
            toCents(d.amount! - 0.01),
          ]
        : [d.amount!, toCents(d.amount! + 0.01), toCents(d.amount! - 0.01)];
    for (const amt of candidates) {
      if (amt <= 0) continue;
      if (validateAction(d.action, amt, player.stack, bs).valid) {
        return { action: d.action, amount: amt, thinkTime: 0 };
      }
    }
    return fallback;
  }

  // ─────────────────────────────────────────────────────────────────────
  // THINK TIME — humanlike pacing, style- and situation-aware
  // ─────────────────────────────────────────────────────────────────────

  /**
   * V14: any think time at or above this is a deliberate TIME BANK burn. The
   * caller translates it into "let the turn clock expire, then act inside the
   * bank the engine auto-grants".
   */
  static readonly THINK_TIMEBANK_SENTINEL = 90_000;

  private static computeThinkTime(
    d: HorseDecision,
    gs: HorseGameStateV2,
    params: StyleParams,
    toCall: number,
    useTiming: boolean = true,
    /** stable per-horse string (the user id) — gives each horse its own tempo */
    tempoSeed: string = ''
  ): number {
    // ── V14 TEMPO (Dan 2026-08-23, binding) ────────────────────────────────
    // "TIMING ON STREETS MUST BE MORE RANDOM. Most horses are making their
    //  decisions at about the same rate on every street. This must be
    //  completely random, from instant, to full 15 seconds or even using time
    //  banks."
    //
    // The old model drew uniformly from a per-style band of roughly 1.1-5.2s
    // and then multiplied. A uniform draw over a narrow band IS the tell: the
    // gaps between actions all felt alike, and the caller's 2200ms floor then
    // collapsed every fast decision onto the SAME NUMBER, so a large share of
    // the fleet acted at exactly 2.2 seconds all night.
    //
    // Humans do not act on a band, they act on a MIXTURE. Most decisions are
    // already made when the action arrives (snap), a good share take a beat,
    // some genuinely tank, and once in a while somebody burns a time bank.
    // Modelling those as four modes with per-horse weighting produces the
    // spread a real table has, where the previous model produced a rhythm.
    const difficulty = difficultyHint;
    difficultyHint = 0;
    if (!useTiming) {
      // Ablation path keeps the old shape so timing never confounds a league
      // measurement.
      const [lo, hi] = params.thinkRange;
      return Math.round(lo + fastRandom() * (hi - lo));
    }

    const simple = d.action === 'check' || d.action === 'fold';
    const aggressive = d.action === 'raise' || d.action === 'all_in';
    // ═══ V24 NO SNAP FOLDS (Dan 2026-08-28, binding) ═══════════════════════
    // "I full potted 8 hands in a row in this PLO PKO tournament and never got
    //  called once preflop, got all snap folds almost every time. Horses need
    //  to NEVER snap fold - they should always take a couple seconds, even if
    //  they already know they are going to fold."
    //
    // MEASURED against the old model: a preflop FOLD scored
    // wSnap = 0.34 + 0.30 (simple) + 0.14 (preflop) = 0.78, multiplied by up
    // to 2.1 for a fast-tempo horse -> a ~74% chance of the SNAP mode. SNAP
    // drew 180-800ms, then `simple && preflop` cut it 20% and the tempo shaper
    // cut it up to another 40%: roughly 180-400ms. Eight of those in a row is
    // what Dan watched, and it is the single loudest tell a table can emit -
    // no human folds to a pot-sized raise in a fifth of a second.
    //
    // FACING A BET IS A DECISION, even when the answer is obvious. A person
    // still has to see the raise, read their four cards, and click. So when
    // there is money to call, the snap mode is not instant any more: it is a
    // human "quick fold" of well over a second, and the floor below holds it
    // there no matter what the tempo multipliers do.
    const facingBet = toCall > 0;
    const stage = gs.stage;
    const pricePot = Number.isFinite(gs.contestablePot)
      ? Math.max(0, gs.contestablePot as number)
      : gs.pot;
    const bigRiverCall = stage === 'river' && toCall > pricePot * 0.5;

    // Per-horse TEMPO, stable for the life of the horse: some people are just
    // fast and some are just deliberate, and that is most of what makes a
    // table feel populated rather than generated. 0 = quickest, 1 = slowest.
    let h = 2166136261;
    for (let i = 0; i < tempoSeed.length; i++) {
      h ^= tempoSeed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // FNV-1a, then take the HIGH bits — a low-bit modulo on similar ids
    // (which horse user ids often are) clusters, and clustered tempo is the
    // very thing this is here to prevent.
    const tempo = (h >>> 11) / 2097152;

    // Mode weights. They shift with the spot: a fold facing no bet is nearly
    // always instant; a big river call almost never is.
    let wSnap = 0.34 + (simple ? 0.3 : 0) + (stage === 'preflop' ? 0.14 : 0);
    const wBeat = 0.52;
    let wTank = 0.12 + (difficulty > 0 ? difficulty * 0.28 : 0) + (aggressive ? 0.05 : 0);
    let wBank = 0.012 + (bigRiverCall ? 0.04 : 0) + (difficulty > 0.6 ? 0.02 : 0);
    if (bigRiverCall) wSnap *= 0.25;
    if (difficulty > 0.5) wSnap *= 0.5;
    // A deliberate horse tanks more and snaps less; a fast one does the
    // reverse. This is what stops every seat sharing one rhythm.
    // Strong, not decorative. A quick horse should visibly be a quick horse
    // across a whole session, and a deliberate one visibly deliberate — that
    // contrast between seats is most of what makes a table read as people.
    wSnap *= 0.4 + (1 - tempo) * 1.7;
    wTank *= 0.35 + tempo * 1.5;
    wBank *= 0.3 + tempo * 1.7;

    const total = wSnap + wBeat + wTank + wBank;
    const roll = fastRandom() * total;
    let think: number;
    if (roll < wSnap) {
      // SNAP: the decision was made before the action arrived. With money to
      // call that still means seeing the bet and acting - never a reflex.
      think = facingBet ? 1150 + fastRandom() * 1450 : 180 + fastRandom() * 620;
    } else if (roll < wSnap + wBeat) {
      // A BEAT: read the board, count the pot, act.
      think = 1100 + fastRandom() * 3400;
    } else if (roll < wSnap + wBeat + wTank) {
      // TANK: a genuinely close spot, or a big bet to size up.
      think = 4600 + fastRandom() * 6200;
    } else {
      // TIME BANK: past the turn clock. The engine auto-activates the bank
      // when the primary timer expires, so this is a real bank burn, not a
      // timeout — the caller keeps it inside the granted bank.
      //
      // Returned IMMEDIATELY: the sentinel is a signal, not a duration, so
      // the shaping multipliers below must never touch it. (They did in the
      // first cut, which pushed the value to ~140k and quietly changed what
      // the caller would decode it as.)
      return Math.round(HorseLogic.THINK_TIMEBANK_SENTINEL + fastRandom() * 6500);
    }

    // Fine-grained shaping WITHIN the chosen mode, so two horses in the same
    // mode still differ.
    think *= 0.6 + tempo * 0.85;
    if (difficulty > 0) think *= 1 + difficulty * 0.35;
    // V24: this 20% discount is for CHECKING a free flop preflop, not for
    // folding to a raise - it was half of how folds reached 180ms.
    if (simple && stage === 'preflop' && !facingBet) think *= 0.8;
    if (aggressive) think *= 1.1;
    // V34: a sitting-out seat is not a player to think about — the same
    // filter every other heads-up read in this file applies.
    const headsUp = gs.players.filter((p) => !p.is_folded && !p.is_sitting_out).length === 2;
    if (headsUp) think *= 0.85;

    // ═══ V24 FLOORS ═══ applied after every multiplier, because the tempo
    // and heads-up shapers are exactly what dragged a 1.2s intention down to
    // a 400ms reflex. Nothing that faces a bet may act inside FACING_FLOOR_MS.
    const FACING_FLOOR_MS = 1250;
    const FREE_FLOOR_MS = 350;

    // ═══ V35 SOFT FLOOR (2026-09-02) — A CLAMP IS A FINGERPRINT ═══════════
    //
    // This was `Math.max(floor, think)`, and that one call was the loudest
    // remaining tell on the platform. MEASURED against the shipped generator,
    // 3,000 samples per spot:
    //
    //   facing a bet, preflop:  14.3% of ALL actions landed on EXACTLY 1250ms
    //   facing a bet, flop:      5.7% on exactly 1250ms
    //   no bet, flop:            6.2% on exactly 350ms
    //
    // The next most common value in each set appeared 0.2% of the time. So one
    // millisecond was ~70x more likely than any other, because a clamp does
    // not slow a fast draw down - it moves every fast draw onto the SAME
    // NUMBER. Nothing else in the model is remotely that visible: a human's
    // reaction time never repeats to the millisecond, so a spike at 1.250s
    // recurring hundreds of times an evening identifies the seat by itself,
    // and it survives every mixture weight and tempo multiplier above.
    //
    // The floors themselves are right and stay exactly where Dan set them
    // (V24, after eight snap folds into pot-sized raises). What changes is
    // what happens to a draw that lands beneath one: instead of being pinned
    // to the floor, it is redistributed just ABOVE it with a short exponential
    // tail. Same guarantee - nothing acts faster than the floor - without the
    // pile-up. The exponential is the maximum-entropy choice for "a bit more
    // than X", which is exactly the claim being made, and its mean is scaled
    // to the floor so the shape holds for both.
    const floor = facingBet ? FACING_FLOOR_MS : FREE_FLOOR_MS;
    if (think >= floor) return Math.round(think);

    // THE JITTER IS DERIVED, NOT DRAWN. An obvious implementation calls
    // `fastRandom()` here — and that would make computeThinkTime consume a
    // DIFFERENT NUMBER of PRNG values depending on which branch it takes.
    // Every seeded ablation test that compares two decisions back to back
    // (GtoPostflop.test.ts's "an empty store changes nothing" is exactly that
    // shape) would then see a shifted stream on the second call and fail for a
    // reason that has nothing to do with what it is testing. Found the hard
    // way: that test went red on the first cut of this fix.
    //
    // `think` is already the product of several fastRandom draws, so its low
    // bits are effectively random. Hashing them yields a well-spread uniform
    // at zero cost to the stream, and keeps the whole function deterministic
    // for a given seed — which is what the league and the self-tuner rely on.
    let jh = (2166136261 ^ Math.floor(think * 1000)) >>> 0;
    jh = Math.imul(jh ^ (jh >>> 15), 2246822507) >>> 0;
    jh = Math.imul(jh ^ (jh >>> 13), 3266489909) >>> 0;
    const u = Math.max(1e-6, 1 - (jh >>> 8) / 16777216);

    // -ln(U) is Exp(1). The 0.18 factor puts the median a little over 12%
    // above the floor and the tail inside roughly +3x that, so a "quick"
    // action still reads as quick.
    return Math.round(floor + -Math.log(u) * floor * 0.18);
  }

  // ─────────────────────────────────────────────────────────────────────
  // LEGACY API — kept for compatibility with existing callers/tests
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Legacy hand-strength score (0..1). Preflop uses the V2 classifiers;
   * postflop uses real Monte Carlo equity vs one opponent.
   */
  static calculateHandStrength(
    holeCards: Card[],
    communityCards: Card[],
    stage: HandStage,
    gameVariant: string = 'nlh'
  ): number {
    if (!holeCards || holeCards.length === 0) return 0;
    const vi = variantInfo(gameVariant);
    if (stage === 'preflop') {
      if (vi.isOmaha && holeCards.length >= 4) return omahaPreflopStrength(holeCards, vi.isHiLo);
      if (holeCards.length === 3) return pineapplePreflopStrength(holeCards, vi.isShortDeck);
      if (holeCards.length !== 2) return 0.3;
      return vi.isShortDeck
        ? shortDeckPreflopStrength(holeCards[0], holeCards[1])
        : holdemPreflopScore(holeCards[0], holeCards[1], false);
    }
    return simulateEquity(holeCards, communityCards, 1, vi, vi.iterations);
  }

  /** Exposed for tests ONLY: internal fast evaluators for cross-validation. */
  static readonly __testables = {
    scoreHoldem,
    scoreOmahaHi,
    scoreOmahaLow,
    straightTop,
    // V4 street IQ internals
    readInitiative,
    actsLastPostflop,
    madeCategory,
    scareShift,
    scoreOmahaHiPartial,
    // V9 humanization internals
    moodOf,
    snapFraction,
    // V10 strategy internals
    rakeDrag,
    // Phase 5 canonical state / legality boundary
    enforceAuthoritativeDecision,
    // V12 tournament internals
    icmRisk,
    // V15 Omaha nut discipline internals
    omahaNutStatus,
  };

  /** Exposed for tests: variant-aware Monte Carlo equity (0..1). */
  static estimateEquity(
    holeCards: Card[],
    communityCards: Card[],
    numOpponents: number,
    gameVariant: string = 'nlh',
    iterations?: number
  ): number {
    const vi = variantInfo(gameVariant);
    if (communityCards.length === 0) {
      return preflopEquity(holeCards, numOpponents, vi, (gameVariant || 'nlh').toLowerCase());
    }
    return simulateEquity(holeCards, communityCards, numOpponents, vi, iterations ?? vi.iterations);
  }

  /**
   * V3, exposed for tests: equity vs specific opponent range bands.
   * One [lo,hi] band (or null for uniform sampling) per opponent.
   */
  static estimateEquityVsBands(
    holeCards: Card[],
    communityCards: Card[],
    bands: Array<[number, number] | null>,
    gameVariant: string = 'nlh',
    iterations?: number
  ): number {
    const vi = variantInfo(gameVariant);
    return simulateEquity(
      holeCards,
      communityCards,
      bands.length,
      vi,
      iterations ?? vi.iterations,
      bands
    );
  }
}
