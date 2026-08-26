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
} from '../types.js';
import { SUITS, RANKS, RANK_VALUES, validateAction, calculateBettingState } from './PokerEngine.js';
// V3 (2026-07-23): real-time opponent intelligence — live stats, range reading,
// exploit adjustments, board texture, blockers. See HorseMind.ts.
import { HorseMind } from './HorseMind.js';
// V7 (2026-07-24): position-pair preflop mastery — 3-bet/4-bet bluffs, blind
// vs blind, squeezes, stack depth, reshoves, ICM. See HorsePreflop.ts.
import { decidePreflopV7, type PreflopPosition } from './HorsePreflop.js';
import { reportError } from '../services/errorReporter.js';
// V7 split: evaluators + Monte Carlo equity + preflop scores live in
// HorseEval.ts (extracted verbatim; zero behavior change).
import {
  fastRandom,
  variantInfo,
  type VariantInfo,
  simulateEquity,
  type HiLoSplit,
  omahaDrawQuality,
  type OmahaDrawInfo,
  omahaNutStatus,
  type OmahaNutStatus,
  preflopEquity,
  holdemPreflopScore,
  omahaPreflopScore,
  pineapplePreflopScore,
  scoreHoldem,
  scoreOmahaHi,
  scoreOmahaHiPartial,
  scoreOmahaLow,
  straightTop,
} from './HorseEval.js';

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
}

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
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && isFinite(v) ? v : undefined;
    mods = {
      aggression: num(obj.aggression),
      tightness: num(obj.tightness),
      bluffFreq: num(obj.bluffFreq ?? obj.bluff_freq),
      sizingMultiplier: num(obj.sizingMultiplier ?? obj.sizing_multiplier),
    };
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
  v13: boolean = true
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
  if (n === 2) return idx === 0 ? 'sb' : 'bb'; // heads-up: dealer is SB
  if (idx === 0) return 'sb';
  if (idx === 1) return 'bb';
  // Remaining players: first third early, last two late, rest middle
  const nonBlind = n - 2;
  const pos = idx - 2; // 0-based among non-blind seats
  if (pos >= nonBlind - 2) return 'late';
  if (pos < Math.ceil(nonBlind / 3)) return 'early';
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
  dealerSeat?: number;
  lastRaise?: number;
  actionHistory?: ActionRecord[];
  /** V7 ICM: explicit tournament context. When absent, tournaments are
   *  self-detected from the big blind (the cash fleet caps at 2.00/5.00, so
   *  bb >= 10 only occurs in tournament play). */
  tournament?: {
    nearBubble?: boolean;
    inMoney?: boolean;
    playersLeft?: number;
    spotsPaid?: number;
    avgStackChips?: number;
    bountyFactor?: number;
  };
  /** V12: table format. Spins are winner-take-all chip-EV (no ICM), HU SNGs
   *  play heads-up ranges, MTTs get the full survival model. */
  format?: 'cash' | 'mtt' | 'spin' | 'hu_sng';
  /** V11 (Dan 2026-08-22): EXPLICIT game mode from the table engine
   *  (tournament_id / game_type). Cash and tournaments are different games;
   *  when this is present it is trusted over every heuristic. */
  gameMode?: 'cash' | 'tournament';
  /** V11: table ante (0/undefined = no ante). Antes widen preflop ranges. */
  ante?: number;
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
 * V7 ICM-lite: the survival premium in tournament play. Chips lost hurt more
 * than chips won help, so every calling threshold rises and bluff volume
 * drops — hardest around the bubble, gone again deep in the money with a big
 * stack. Returns an additive threshold premium (0 for cash games).
 */
function icmRisk(gs: HorseGameStateV2, stackBB: number): number {
  // icmRisk v2 (V12, 2026-08-22): real bubble model from TournamentBrainContext.
  const explicit = gs.tournament;
  if (!isTournamentMode(gs)) return 0;
  // Spins are winner-take-all — pure chip EV, zero survival premium.
  if (gs.format === 'spin' && (explicit?.spotsPaid ?? 1) <= 1) return 0;

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
  return Math.min(risk, 0.12);
}

/** V3/V4/V5 decision options (benchmark/test hooks — production uses defaults). */
export interface HorseDecideOpts {
  /** disable the HorseMind opponent-intelligence layer (default: enabled) */
  mind?: boolean;
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
}

/**
 * V9 MOOD — hourly gear-shifts. Real players run hot and cold across a
 * session: an hour where a guy is visibly opening more, an hour where he
 * tightens up. A hash of (horse, current hour) gives every horse a stable
 * within-the-hour mood that observers can actually pick up on — exactly the
 * kind of exploitable-looking texture humans produce — while staying zero-mean
 * across the fleet and across time.
 */
function moodOf(userId: string): number {
  const key = userId + '|' + Math.floor(Date.now() / 3_600_000);
  let h = 17;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000; // 0..1, stable for the hour
}

/**
 * V9 TIMING — decision-difficulty hint. decidePostflop records how close the
 * MC equity landed to the nearest strategy threshold; computeThinkTime turns
 * closeness into a TANK (humans agonize over close spots and snap the easy
 * ones). Module-level stash is safe: decisions are synchronous and
 * single-threaded, and the consumer resets it every read.
 */
let difficultyHint = 0;

/** V9 SIZING — human bet-size families. Continuous uniform sizing is a subtle
 *  tell: real players think in pot fractions (third, half, two-thirds,
 *  three-quarters, pot, overbet). Snap the computed fraction to the nearest
 *  family with a little jitter; extreme fractions (geometric jams) pass
 *  through untouched. */
const SIZE_FAMILIES = [0.33, 0.5, 0.66, 0.8, 1.0, 1.3];
function snapFraction(frac: number): number {
  if (frac < 0.25 || frac > 1.4) return frac;
  let best = SIZE_FAMILIES[0];
  for (const f of SIZE_FAMILIES) if (Math.abs(frac - f) < Math.abs(frac - best)) best = f;
  return best + (fastRandom() - 0.5) * 0.08;
}

/**
 * V10 RAKE — the room's cash schedule is ~10% with a per-stakes dollar cap and
 * no-flop-no-drop. Only the MARGINAL rake matters to a decision: while the pot
 * is BELOW the cap every chip that ends up in it is taxed ~10%, so marginal
 * calls in small pots need a touch more equity than raw pot odds imply. Once
 * the cap is reached the marginal rake is zero and pot odds are honest again.
 * Returns the marginal rake fraction (0.10 or 0). The cap is approximated at
 * 2.5bb (schedule: $5 cap at 1/2, $7.5 at 2/5) — deliberately conservative.
 */
const RAKE_PCT = 0.1;
function rakeDrag(pot: number, bigBlind: number): number {
  const capChips = Math.max((bigBlind > 0 ? bigBlind : 2) * 2.5, 3);
  return pot > 0 && pot * RAKE_PCT < capChips ? RAKE_PCT : 0;
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
      // V3: ingest the action stream into the opponent-intelligence layer.
      // Wrapped so observation can never take down a decision.
      // V12: benchmark/league decisions pass mind:false — they must never
      // write synthetic hands into the live opponent memory.
      if (opts.mind !== false) {
        try {
          HorseMind.observe(gameState.actionHistory, gameState.players);
        } catch {
          /* observation is best-effort */
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
      const toCall = Math.max(0, (gameState.currentBet || 0) - (player.bet || 0));
      return toCall === 0
        ? { action: 'check', thinkTime: 1500 }
        : { action: 'fold', thinkTime: 1500 };
    }
  }

  private static decideInternal(
    player: SeatPlayer,
    gs: HorseGameStateV2,
    styleName: HorseStyle,
    mods: HorseProfileMods,
    opts: HorseDecideOpts = {}
  ): HorseDecision {
    const base = STYLE_PARAMS[styleName] || STYLE_PARAMS.balanced;
    const params: StyleParams = {
      ...base,
      tightness: base.tightness * (mods.tightness ?? 1),
      bluffFreq: base.bluffFreq * (mods.bluffFreq ?? 1),
      aggression: base.aggression * (mods.aggression ?? 1),
      sizingMultiplier: base.sizingMultiplier * (mods.sizingMultiplier ?? 1),
    };

    const vi = variantInfo(gs.gameVariant);
    const toCall = Math.max(0, gs.currentBet - player.bet);

    // V8: per-variant style overlays. The five styles were tuned on NLH;
    // Omaha punishes slowplay (equities swing too hard street to street) and
    // rewards preflop discipline, so PLO variants trim bluff/slowplay volume
    // and tighten a notch. Short deck trims bluffs slightly (equities run
    // closer). The 'balanced' style also caps its slowplay — live telemetry
    // showed it giving away free cards at the worst rate in the fleet.
    if (opts.v8 !== false) {
      if (vi.isOmaha) {
        params.bluffFreq *= 0.8;
        params.slowplayFreq *= 0.8;
        params.tightness *= 1.03;
      } else if (vi.isShortDeck) {
        params.bluffFreq *= 0.9;
      }
      if (styleName === 'balanced') {
        params.slowplayFreq = Math.min(params.slowplayFreq, 0.14);
      }
    }

    // V9: hourly mood gear-shift — a horse's bluff/aggression volume drifts
    // hour to hour the way a human's does. Zero-mean across the fleet.
    if ((opts.v9Mood ?? opts.v9) !== false) {
      const m01 = moodOf(player.user_id);
      params.bluffFreq *= 0.88 + 0.24 * m01;
      params.aggression *= 0.96 + 0.08 * m01;
    }

    const v7 = opts.v7 !== false;
    let decision: HorseDecision;
    if (gs.stage === 'preflop') {
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

    decision = this.legalize(decision, player, gs, vi);
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
    const toCall = Math.max(0, gs.currentBet - player.bet);

    let strength: number;
    if (vi.isOmaha) strength = omahaPreflopScore(player.cards, vi.isHiLo);
    else if (player.cards.length === 3)
      strength = pineapplePreflopScore(player.cards, vi.isShortDeck);
    else if (player.cards.length === 2)
      strength = holdemPreflopScore(player.cards[0], player.cards[1], vi.isShortDeck);
    else strength = 0.3;
    strength = clamp01(strength + (fastRandom() * 0.06 - 0.03));

    const history = (gs.actionHistory || []).filter((a) => a.stage === 'preflop');
    let raises = 0;
    let limpers = 0;
    let callers = 0;
    let lastRaiserSeat = -1;
    for (const a of history) {
      const isAggr =
        a.action === 'raise' || a.action === 'bet' || (a.action === 'all_in' && a.isFullRaise);
      if (isAggr) {
        raises++;
        callers = 0; // callers-of-THE-raise reset when a new raise lands
        lastRaiserSeat = a.seat;
      } else if (a.action === 'call') {
        if (raises === 0) limpers++;
        else callers++;
      }
    }
    if (history.length === 0 && gs.currentBet > bb * 1.05) {
      raises = gs.currentBet > bb * 4.5 ? 2 : 1;
    }

    const position = classifyPosition(player.seat, gs.dealerSeat, gs.players, opts.v13 !== false);
    const raiserPosition: PreflopPosition | null =
      lastRaiserSeat >= 0
        ? classifyPosition(lastRaiserSeat, gs.dealerSeat, gs.players, opts.v13 !== false)
        : null;
    // V13: a sitting-out player counted as an opponent, so a two-handed table
    // with one sitter reported oppsLeft = 2 and switched OFF the heads-up and
    // blind-vs-blind ranges entirely — the SB opened on 0.44 instead of 0.24
    // and the BB defended on 0.54 instead of 0.30. Postflop already did this.
    const oppsLeft = gs.players.filter(
      (p) => !p.is_folded && p.seat !== player.seat && (opts.v13 === false || !p.is_sitting_out)
    ).length;
    const stackBB = player.stack / bb;

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
      riskAdd: icmRisk(gs, stackBB),
      // NLH only: widening the iso range vs limpers is an NLH edge; PLO limped
      // pots play multiway/postflop where a wide iso bloats pots out of line.
      isoWiden: (opts.v10Iso ?? opts.v10) !== false && !vi.isOmaha ? 0.06 : 0,
      // V11: explicit game mode + ante awareness (undefined when disabled so
      // the preflop layer keeps exact legacy behavior in ablation runs).
      mode: opts.v11 !== false ? (isTournamentMode(gs) ? 'tournament' : 'cash') : undefined,
      anteInPlay: opts.v11 !== false && (gs.ante ?? 0) > 0,
      // V12: table format — spins widen (winner-take-all chip EV), HU SNGs
      // ride the heads-up ranges.
      // V13: `format` is a V12 field and now answers to the v12 flag.
      format:
        opts.v12 !== false ? (gs.format ?? (isTournamentMode(gs) ? 'mtt' : 'cash')) : undefined,
      targeted,
      raiserFoldTo3Bet: raiserF3b,
      v13: opts.v13 !== false,
      rand: fastRandom,
    });

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

    // Hand strength 0..1 (percentile-style, variant-aware)
    let strength: number;
    if (vi.isOmaha) strength = omahaPreflopScore(player.cards, vi.isHiLo);
    else if (player.cards.length === 3)
      strength = pineapplePreflopScore(player.cards, vi.isShortDeck);
    else if (player.cards.length === 2)
      strength = holdemPreflopScore(player.cards[0], player.cards[1], vi.isShortDeck);
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
    const oppsLeft = gs.players.filter((p) => !p.is_folded && p.seat !== player.seat).length;

    // Position-based open thresholds (percentile strength required)
    const OPEN_THRESH: Record<PositionClass, number> = {
      early: 0.62,
      middle: 0.54,
      late: 0.42,
      sb: 0.5,
      bb: 0.42,
    };
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
        const sizeBB = (2.2 + fastRandom() * 0.8 + limpers * 1.0) * params.sizingMultiplier;
        return this.raiseTo(sizeBB * bb, player, gs, vi);
      }
      // Below opening threshold: free check, limp-behind with playable hands,
      // otherwise fold to a raise / complete cheap in the blinds.
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      const limpable = strength >= openThresh - 0.12;
      if (toCall <= bb && (limpable || position === 'sb') && fastRandom() < 0.7) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      if (toCall <= bb * 1.5 && strength >= 0.3) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
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
        const mult = 2.2 + fastRandom() * 0.4;
        return this.raiseTo(currentBet * mult * params.sizingMultiplier, player, gs, vi);
      }
      if (strength >= callThresh && toCall <= stack * 0.35) {
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      // Getting a monster price closing the action
      if (toCall > 0 && toCall <= pot * 0.15 && strength >= 0.45) {
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
    const { currentBet, pot } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
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
    let oppReads: Array<{ aggrW: number; checked: number } | null> | undefined;
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
        bands = HorseMind.bandsForOpponents(
          player.seat,
          gs.players,
          bandHistory,
          gs.bigBlind,
          useSizeReads,
          gs.communityCards,
          oppReads
        );
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
    const equity = simulateEquity(
      player.cards,
      gs.communityCards,
      Math.min(oppCount, 4),
      vi,
      vi.iterations,
      bands,
      useAdaptiveMC,
      hiLoSplit,
      oppReads
    );

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

    // Multiway tightening: each extra opponent raises the bar.
    // V7 ICM: tournament survival premium tightens calls and trims bluffs.
    // V8: Omaha equities cluster much closer than NLH equities, so each extra
    // opponent tightens HARDER in PLO — thresholds tuned on NLH gaps overplay
    // Omaha hands multiway.
    const risk = useV7 ? icmRisk(gs, gs.bigBlind > 0 ? stack / gs.bigBlind : 100) : 0;
    // V15: equities cluster tighter still with 5 and 6 hole cards, so the
    // per-opponent multiway tightening scales with hole count.
    const useV15 = opts.v15 !== false;
    const omahaMwStep =
      useV8 && vi.isOmaha ? 0.045 + (useV15 ? Math.max(0, vi.holeCount - 4) * 0.005 : 0) : 0.03;
    let mw = (oppCount - 1) * (useV8 && vi.isOmaha ? omahaMwStep : 0.03) + risk;

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
        // V13: on the pineapple discard street a player still holds THREE
        // cards, but only two ever play. madeCategory concatenates hole+board
        // and takes the best five, so it was scoring a 6-card hand and
        // inflating the category — which mis-fires the vulnerable check, the
        // semi-bluff gates (cat <= 2), the monster gates (cat >= 6) and the
        // one-pair domination penalty all at once. Score the best TWO of the
        // three, which is what the player will actually be left holding.
        cat = bestTwoCardCategory(player.cards, gs.communityCards, vi);
        scare = scareShift(gs.communityCards);
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

    // ═══ V15 OMAHA NUT DISCIPLINE (Dan 2026-08-26) ═══
    // "I watched a horse call off 800 chips with a 9-high flush in PLO6 —
    //  when you get raised, your opponent always has a bigger flush."
    // The made-hand category stops at "flush"; this knows WHICH flush.
    let nuts15: OmahaNutStatus | null = null;
    if (useV15 && vi.isOmaha && (cat === 5 || cat === 6)) {
      try {
        nuts15 = omahaNutStatus(player.cards, gs.communityCards);
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
      for (const bc of gs.communityCards) {
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
    // Did hero bet/raise THIS street and then get raised? The strongest
    // possible "they have it" signal, and the exact line Dan flagged.
    let raisedAfterAggr = false;
    if (useV15 && facingBet && gs.actionHistory) {
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
    const boardRanks = gs.communityCards.map((cc) => cc.rank);
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
    const bluffScale =
      exploit.bluffMod * blockerMod * posMod * Math.max(0.5, 1 - 2 * risk) * (quartered ? 0.6 : 1);

    // V8 Omaha draw quality — computed LAZILY (enumeration cost) and only
    // inside the semi-bluff bands. Nut draws fight; dominated flush draws
    // without wrap backup stop stacking off.
    let drawInfoCache: OmahaDrawInfo | null = null;
    const omahaDrawMod = (): number => {
      if (!useDraws || !drawsLive) return 1;
      if (!drawInfoCache) drawInfoCache = omahaDrawQuality(player.cards, gs.communityCards);
      const d = drawInfoCache;
      if (d.nutty) return 1.15;
      if (d.dominatedFlushDraw && d.straightOuts < 6) return 0.35;
      return 0.7;
    };

    // ═══ V7: barrel planning — multi-street bluffs tell a coherent story ═══
    // When a bluff/semi-bluff bet fires, the horse decides THEN whether it is
    // a planned multi-street line. On later streets the plan is honored:
    // planned barrels continue on safe cards; unplanned stabs give up.
    const handKey = useBarrels ? HorseMind.handKeyOf(gs.actionHistory) : null;
    const barrelPlan = useBarrels ? HorseMind.getPlan(handKey, player.user_id) : undefined;
    const planBarrel = (equityNow: number): void => {
      if (!useBarrels || isRiver) return;
      // Only bluffs/semi-bluffs need a plan — value hands bet themselves.
      // TUNED (duplicate-deal ablation): 0.55 planned too many multi-street
      // bluffs into a pool that calls; 0.40 keeps the coherent-story benefit
      // without torching chips on over-frequent second barrels.
      if (equityNow < 0.55) {
        HorseMind.notePlan(handKey, player.user_id, fastRandom() < 0.35);
      }
    };

    const useV11 = opts.v11 !== false;

    // ═══ Not facing a bet ═══
    if (!facingBet) {
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
          (equity >= 0.8 + mw && wetness >= 0.55 && fastRandom() < 0.3);
        if (!donkLead) return { action: 'check', thinkTime: 0 };
      }
      // Monster: usually bet big, sometimes trap (never trap on wet or
      // freshly-dangered boards). V4: size to get stacks in by the river.
      if (equity >= 0.8 + mw) {
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
        return this.betSize(pot, monsterFrac, player, gs, vi, params, useSizing);
      }
      // Strong value. V4: a vulnerable made hand sizes UP and never checks
      // back; a dangered hand slows down instead of firing into the new nuts.
      if (equity >= 0.62 + mw) {
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
        const protection = vulnerable ? 0.1 : 0;
        return this.betSize(
          pot,
          (sizeBase + 0.12 + protection + fastRandom() * 0.15) * ploDamp,
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
      if (equity >= 0.52 + mw - (exploit.valueThinMod - 1) * 0.08) {
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
        if (barrelPlan && !dangered && oppCount <= 2 && (equity >= 0.15 || blocker)) {
          // TUNED (duplicate-deal ablation): continuation frequencies cut
          // (turn 0.75->0.60, river 0.55->0.42) and total-air no-blocker
          // barrels abandoned — the original volume measurably lost.
          if (fastRandom() < (isRiver ? 0.35 : 0.52) * Math.min(1.25, bluffScale)) {
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
      // V4 CONTINUATION BET: the preflop/prior-street aggressor keeps the
      // pressure on favorable boards even without made equity. Small sizing,
      // dry-board + short-handed gated, position-scaled, station-aware.
      // V5 PROBE: when the previous street checked through, everyone's range
      // is capped — attack it even without the betting lead (delayed c-bet /
      // missed-c-bet stab).
      // V10: on a range-advantage board fire the whole range more often at a
      // smaller size (the classic high-freq small c-bet); otherwise keep the
      // V4 dry-board stab.
      let cbetFreqMult = boardFavorsAggressor ? 1.35 : 1.0;
      // V16 DEEP READS: heads-up, c-bet the player in front of you, not the
      // population average. 0.6 + ftc maps a 75% folder to x1.35 and a 30%
      // station to x0.9, clamped to keep the read a reshaping, not a switch.
      if (useMind && opts.v16Reads !== false && oppCount === 1) {
        try {
          const ftc = HorseMind.foldToCbetOf(opponents[0].user_id);
          if (ftc !== null) {
            cbetFreqMult *= Math.max(0.75, Math.min(1.4, 0.6 + ftc));
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
        fastRandom() <
          params.bluffFreq *
            params.aggression *
            bluffScale *
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
      const scareBluffBoost = useIQ && scare.any && blocker ? 1.5 : 1.0;
      if (
        equity < 0.3 &&
        oppCount === 1 &&
        fastRandom() < params.bluffFreq * bluffScale * scareBluffBoost * (isRiver ? 0.55 : 0.8)
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
    // V10 RAKE: below the cap the pot we stand to win is taxed ~10%, so price
    // marginal calls against the raked pot, not the raw one. Above the cap
    // (large pots) the drag is zero and this reduces to honest pot odds.
    // V11: tournaments rake the buy-in, not the pot — pot odds are honest.
    const rakeMarg = useRake10 && !isTournamentMode(gs) ? rakeDrag(pot, gs.bigBlind) : 0;
    const potOdds = toCall / (pot * (1 - rakeMarg) + toCall);
    const betRatio = pot > 0 ? toCall / pot : 1;

    // ═══ V11 BOARD DOMINATION DISCIPLINE (the "QQ on AKx" leak) ═══
    // The MC prices opponents by their PREFLOP range only — it cannot see
    // that a player firing big on an A/K-high board has connected with it.
    // A one-pair hand whose pair sits UNDER board overcards (an underpair,
    // or second/third pair) is exactly the hand class big bets dominate, so
    // it pays an explicit equity premium that grows with each overcard and
    // with bet size. Top pair (zero overcards above it) pays nothing.
    let dominationPenalty = 0;
    if (useV11 && useIQ && cat === 2 && !vi.isOmaha && betRatio >= 0.45) {
      const pr = onePairRank(player.cards, gs.communityCards);
      if (pr > 0) {
        let over = 0;
        for (const r of Object.keys(rankCounts) as Array<keyof typeof RANK_VALUES>) {
          if ((RANK_VALUES[r] ?? 0) > pr) over++;
        }
        if (over > 0) {
          dominationPenalty = 0.07 * Math.min(2, over) * (betRatio >= 0.8 ? 1.4 : 1);
        }
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
      } else if (isRiver && betRatio >= 0.8) {
        // Big river bet into us: "check-calling, or check-folding to big
        // bets" — the bigger the bet, the more nutted the range.
        if (cat === 6 && hf >= 2) cap = betRatio >= 1.2 ? 0.32 : 0.42;
        else if (cat === 5) cap = betRatio >= 1.2 ? 0.38 : 0.48;
      }
      if (cap !== Infinity) {
        if (!isRiver) cap += 0.1; // redraws + protection before the river
        if (oppCount >= 2) cap -= 0.05; // a raise INTO A FIELD is more nutted
        eq15 = Math.min(equity, Math.max(0.05, cap));
      }
    }

    // Low-SPR commitment: with the money effectively in, play equity directly.
    const committed = spr < 1.2 || toCall >= stack;
    if (committed) {
      const required = potOdds + 0.02 + dominationPenalty * 0.5;
      if (eq15 >= Math.max(required, 0.42 + mw + dominationPenalty * 0.5)) {
        // V15: a dominated flush/straight that still clears the (penalized)
        // bar CALLS rather than jams — shoving it has zero fold equity
        // against the range that just raised, and the raise-shove line with
        // a nine-high flush is the exact hand Dan watched. Sets and boats
        // keep the jam.
        const preferFlat15 = useV15 && vi.isOmaha && nuts15 != null && !nutClass15;
        return toCall >= stack || preferFlat15
          ? { action: 'call', amount: toCall, thinkTime: 0 }
          : { action: 'all_in', thinkTime: 0 };
      }
      if (eq15 >= required) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
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
    const valueRaiseThresh = 0.68 + mw + (isRiver ? 0.04 : 0) + sprAdj + dominationPenalty;
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
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      const oopBoost = useIQ && !ip ? params.checkRaiseFreq * 0.6 : 0;
      if (
        !(dangered && cat < 6) &&
        fastRandom() < 0.55 * params.aggression + params.checkRaiseFreq + oopBoost
      ) {
        const raiseToAmt = currentBet + (pot + toCall) * (0.7 + fastRandom() * 0.4);
        return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
      }
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Semi-bluff raise with big draws (flop/turn only, not into a crowd,
    // gated by the target's fold tendency + our blockers). V4: pure draws
    // only — made hands in the band call instead of bloating the pot.
    // V8: Omaha raise semi-bluffs demand draw QUALITY too.
    if (
      drawsLive &&
      equity >= 0.33 &&
      equity < 0.52 &&
      (cat <= 2 || !useIQ) &&
      oppCount <= 2 &&
      betRatio <= 0.85 &&
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
    if (
      useNlhX &&
      !ip &&
      scare.any &&
      blocker &&
      equity >= 0.2 &&
      equity < 0.42 &&
      oppCount === 1 &&
      betRatio <= 0.6 &&
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
      useNlhX &&
      isRiver &&
      oppCount === 1 &&
      blocker &&
      equity < 0.3 &&
      betRatio <= 0.75 &&
      fastRandom() < params.bluffFreq * 0.35 * Math.min(1.2, bluffScale)
    ) {
      const raiseToAmt = currentBet + (pot + toCall) * (1.0 + fastRandom() * 0.3);
      return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
    }

    // Call when the price is right. Margin scales with bet size; draws get a
    // small implied-odds allowance before the river. V3: a maniac's bets need
    // less respect (callDownMod > 1); a passive player's bets need more.
    // V4: bets fired ON a fresh scare card into a hand that does not beat the
    // new class get extra respect; in-position calls realize equity better.
    // V11: a dominated pair has REVERSE implied odds (improving to a set can
    // still lose to a higher set / straight the same range makes) — it gets
    // no implied-odds allowance.
    const impliedBonus = drawsLive && equity >= 0.25 && dominationPenalty === 0 ? 0.04 : 0;
    let respect = 2 - exploit.callDownMod; // maniac 0.8, neutral 1, passive 1.15
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
          if (opts.v16Reads !== false && isRiver && betRatio >= 0.75) {
            const tell = HorseMind.bigBetValueTendency(bettorId);
            if (tell !== null) {
              if (tell >= 0.75) respect += 0.12;
              else if (tell <= 0.4) respect -= 0.1;
            }
          }
        }
      } catch {
        /* targeting is best-effort */
      }
    }
    // V7 overbet polarity: an overbet is nuts-or-bluffs. Medium hands without
    // a nut blocker fold more; holding the blocker shifts toward the catch.
    if (useSizeReads && betRatio > 1.2) respect += blocker ? -0.05 : 0.08;
    // V12 (G): the same blocker logic extends into the big-bet band (0.8-1.2
    // pot) on the river — large river bets are already polarized enough that
    // the blocker meaningfully changes the catch.
    if ((opts.v12River ?? opts.v12) !== false && isRiver && betRatio >= 0.8 && betRatio <= 1.2) {
      respect += blocker ? -0.04 : 0.04;
    }
    // (V10 explored a river blocker-aware bluff-catch adjustment here; the
    // duplicate-deal A/B showed it LEAKED in both directions — the V4/V7 river
    // logic is already well-calibrated — so it was dropped, not shipped.)
    // V8: OOP calls tighten further multiway — equity realization out of
    // position degrades with every extra live opponent.
    const posEdge = useIQ ? (ip ? -0.012 : 0.008 * (useNlhX ? 1 + 0.3 * (oppCount - 1) : 1)) : 0;
    const sizingPenalty = (Math.min(0.06, betRatio * 0.04) + mw * 0.5) * respect;
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
    if (
      isRiver &&
      oppCount === 1 &&
      betRatio <= 0.4 &&
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
    if (!cards || cards.length !== 3) return 2;
    const vi = variantInfo('nlh'); // after the discard the hand plays like holdem
    let bestIdx = 2;
    let bestEq = -1;
    for (let discard = 0; discard < 3; discard++) {
      const keep = cards.filter((_, i) => i !== discard);
      const eq =
        communityCards.length >= 3
          ? simulateEquity(keep, communityCards, 1, vi, 400)
          : holdemPreflopScore(keep[0], keep[1], gameVariant === 'short_deck');
      if (eq > bestEq) {
        bestEq = eq;
        bestIdx = discard;
      }
    }
    return bestIdx;
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
    const frac = snap ? snapFraction(fraction) : fraction;
    return this.legalize(
      { action: 'bet', amount: pot * frac * params.sizingMultiplier, thinkTime: 0 },
      player,
      gs,
      vi
    );
  }

  /** Build a raise decision to an absolute amount, clamped to legal bounds. */
  private static raiseTo(
    target: number,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo
  ): HorseDecision {
    const action = gs.currentBet > 0 ? 'raise' : 'bet';
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
    return this.capPotLimitJam(this.legalizeInner(d, player, gs, vi), player, gs, vi);
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
    const stage = gs.stage;
    const bigRiverCall = stage === 'river' && toCall > gs.pot * 0.5;

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
    let wBeat = 0.52;
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
      // SNAP: the decision was made before the action arrived.
      think = 180 + fastRandom() * 620;
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
    if (simple && stage === 'preflop') think *= 0.8;
    if (aggressive) think *= 1.1;
    const headsUp = gs.players.filter((p) => !p.is_folded).length === 2;
    if (headsUp) think *= 0.85;

    return Math.round(Math.max(180, think));
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
      if (vi.isOmaha && holeCards.length >= 4) return omahaPreflopScore(holeCards, vi.isHiLo);
      if (holeCards.length === 3) return pineapplePreflopScore(holeCards, vi.isShortDeck);
      if (holeCards.length !== 2) return 0.3;
      return holdemPreflopScore(holeCards[0], holeCards[1], vi.isShortDeck);
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
