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
// V7 split: evaluators + Monte Carlo equity + preflop scores live in
// HorseEval.ts (extracted verbatim; zero behavior change).
import {
  fastRandom,
  variantInfo,
  type VariantInfo,
  simulateEquity,
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
  players: SeatPlayer[]
): PositionClass {
  const inHand = players
    .filter((p) => !p.is_folded || p.seat === heroSeat)
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
    if (a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise === true)) {
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
  players: SeatPlayer[]
): boolean {
  if (dealerSeat === undefined) return false;
  const live = players.filter((p) => !p.is_folded && !p.is_sitting_out).map((p) => p.seat);
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
  tournament?: { nearBubble?: boolean; inMoney?: boolean };
}

/**
 * V7 ICM-lite: the survival premium in tournament play. Chips lost hurt more
 * than chips won help, so every calling threshold rises and bluff volume
 * drops — hardest around the bubble, gone again deep in the money with a big
 * stack. Returns an additive threshold premium (0 for cash games).
 */
function icmRisk(gs: HorseGameStateV2, stackBB: number): number {
  const explicit = gs.tournament;
  const isTournament = explicit != null || (gs.bigBlind ?? 0) >= 10;
  if (!isTournament) return 0;
  let risk = stackBB < 40 ? 0.04 : 0.02;
  if (explicit?.nearBubble) risk += 0.04;
  if (explicit?.inMoney && stackBB > 60) risk = Math.max(0.01, risk - 0.02);
  return risk;
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
      try {
        HorseMind.observe(gameState.actionHistory, gameState.players);
      } catch {
        /* observation is best-effort */
      }
      return this.decideInternal(player, gameState, style, mods, opts);
    } catch {
      // Absolute safety net: never let a horse hang the table.
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

    const v7 = opts.v7 !== false;
    let decision: HorseDecision;
    if (gs.stage === 'preflop') {
      decision =
        (opts.v7Preflop ?? v7)
          ? this.decidePreflopV7Glue(player, gs, vi, params)
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
    decision.thinkTime = this.computeThinkTime(decision, gs, params, toCall);
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
    params: StyleParams
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

    const position = classifyPosition(player.seat, gs.dealerSeat, gs.players);
    const raiserPosition: PreflopPosition | null =
      lastRaiserSeat >= 0 ? classifyPosition(lastRaiserSeat, gs.dealerSeat, gs.players) : null;
    const oppsLeft = gs.players.filter((p) => !p.is_folded && p.seat !== player.seat).length;
    const stackBB = player.stack / bb;

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
    const useBarrels = opts.v7Barrels ?? useV7;
    const useCounterAdapt = opts.v7CounterAdapt ?? useV7;
    const useAdaptiveMC = opts.v7AdaptiveMC ?? useV7;
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
        bands = HorseMind.bandsForOpponents(
          player.seat,
          gs.players,
          bandHistory,
          gs.bigBlind,
          useSizeReads,
          gs.communityCards
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
    const equity = simulateEquity(
      player.cards,
      gs.communityCards,
      Math.min(oppCount, 4),
      vi,
      vi.iterations,
      bands,
      useAdaptiveMC
    );

    // Multiway tightening: each extra opponent raises the bar.
    // V7 ICM: tournament survival premium tightens calls and trims bluffs.
    const risk = useV7 ? icmRisk(gs, gs.bigBlind > 0 ? stack / gs.bigBlind : 100) : 0;
    const mw = (oppCount - 1) * 0.03 + risk;
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
        ip = actsLastPostflop(player.seat, gs.dealerSeat, gs.players);
        cat = madeCategory(player.cards, gs.communityCards, vi);
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

    // Vulnerable made hand: real hand today, wet board, cards to come — bet for
    // protection, never slowplay. (Strong two pair / trips / weak straight.)
    const vulnerable = useIQ && cat >= 3 && cat <= 5 && wetness >= 0.45 && drawsLive;
    // Fresh danger card hero does not beat: straight/flush completed, no
    // blocker, and hero's own hand is below that class.
    const dangered = useIQ && (scare.flush || scare.straight) && cat < 5 && !blocker;

    // V3 texture-driven sizing: small on dry boards, big on wet ones.
    const sizeBase = 0.3 + wetness * 0.35; // 0.30 (dry) .. 0.65 (soaked)
    // V3 bluff gating: blockers upgrade bluffs; wet boards without one demote.
    const blockerMod = blocker ? 1.35 : wetness > 0.55 ? 0.7 : 1.0;
    // V4: position scales bluffing — pressure comes cheaper in position.
    // V7: ICM survival pressure trims bluff volume in tournaments.
    const posMod = useIQ ? (ip ? 1.15 : 0.85) : 1.0;
    const bluffScale = exploit.bluffMod * blockerMod * posMod * Math.max(0.5, 1 - 2 * risk);

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

    // ═══ Not facing a bet ═══
    if (!facingBet) {
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
        const monsterFrac =
          geomFrac > 0
            ? Math.max(sizeBase + 0.2, geomFrac) + fastRandom() * 0.1
            : sizeBase + 0.3 + fastRandom() * 0.2;
        return this.betSize(pot, monsterFrac, player, gs, vi, params);
      }
      // Strong value. V4: a vulnerable made hand sizes UP and never checks
      // back; a dangered hand slows down instead of firing into the new nuts.
      if (equity >= 0.62 + mw) {
        if (dangered && fastRandom() < 0.55) {
          return { action: 'check', thinkTime: 0 };
        }
        const protection = vulnerable ? 0.1 : 0;
        return this.betSize(
          pot,
          sizeBase + 0.12 + protection + fastRandom() * 0.15,
          player,
          gs,
          vi,
          params
        );
      }
      // Thin value / protection — thinner into stations (valueThinMod > 1).
      // V4: vulnerable made hands always bet-protect; dangered hands check.
      // V5 river polarization: medium made hands stop thin-betting into
      // non-stations on the river — they get called by better and fold out
      // worse. Check back and win at showdown instead.
      if (equity >= 0.52 + mw - (exploit.valueThinMod - 1) * 0.08) {
        if (dangered) return { action: 'check', thinkTime: 0 };
        const thinFreq =
          isRiver && useHR && exploit.valueThinMod <= 1.05 && equity < 0.62 + mw ? 0.25 : 0.65;
        if (vulnerable || fastRandom() < thinFreq) {
          return this.betSize(pot, sizeBase + fastRandom() * 0.12, player, gs, vi, params);
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
            return this.betSize(pot, sizeBase + 0.15 + fastRandom() * 0.1, player, gs, vi, params);
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
      if (
        (initiative === 'hero' || prevChecked) &&
        oppCount <= 2 &&
        wetness <= 0.45 &&
        !scare.any &&
        equity >= 0.18 &&
        equity < 0.52 &&
        !isRiver &&
        fastRandom() <
          (oppCount === 1 ? 0.6 : 0.35) * (prevChecked ? 1.15 : 1.0) * Math.min(1.3, bluffScale)
      ) {
        planBarrel(equity);
        return this.betSize(pot, 0.3 + fastRandom() * 0.1, player, gs, vi, params);
      }
      // Semi-bluff with live draws (equity from draws is in the MC number).
      // V4: made hands in this band (two pair on wet boards) prefer showdown
      // lines over bloating — only true draws semi-bluff.
      if (
        drawsLive &&
        equity >= 0.3 &&
        equity < 0.52 &&
        (cat <= 2 || !useIQ) &&
        fastRandom() < params.bluffFreq * params.aggression * bluffScale * (oppCount === 1 ? 1.4 : 0.7)
      ) {
        planBarrel(equity);
        return this.betSize(pot, sizeBase + 0.2 + fastRandom() * 0.15, player, gs, vi, params);
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
        return this.betSize(pot, sizeBase + 0.15 + fastRandom() * 0.2, player, gs, vi, params);
      }
      return { action: 'check', thinkTime: 0 };
    }

    // ═══ Facing a bet ═══
    const potOdds = toCall / (pot + toCall);
    const betRatio = pot > 0 ? toCall / pot : 1;

    // Low-SPR commitment: with the money effectively in, play equity directly.
    const committed = spr < 1.2 || toCall >= stack;
    if (committed) {
      const required = potOdds + 0.02;
      if (equity >= Math.max(required, 0.42 + mw)) {
        return toCall >= stack
          ? { action: 'call', amount: toCall, thinkTime: 0 }
          : { action: 'all_in', thinkTime: 0 };
      }
      if (equity >= required) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }

    // Raise for value. V4: out of position lean harder on the check-raise
    // (denies equity + realizes fold equity); on a fresh scare card we do not
    // beat, downgrade the raise to a call.
    const valueRaiseThresh = 0.68 + mw + (isRiver ? 0.04 : 0);
    if (equity >= valueRaiseThresh) {
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
    if (
      drawsLive &&
      equity >= 0.33 &&
      equity < 0.52 &&
      (cat <= 2 || !useIQ) &&
      oppCount <= 2 &&
      betRatio <= 0.85 &&
      fastRandom() < params.bluffFreq * params.aggression * bluffScale * 0.5
    ) {
      const raiseToAmt = currentBet + (pot + toCall) * (0.8 + fastRandom() * 0.3);
      return this.raiseTo(raiseToAmt * params.sizingMultiplier, player, gs, vi);
    }

    // Call when the price is right. Margin scales with bet size; draws get a
    // small implied-odds allowance before the river. V3: a maniac's bets need
    // less respect (callDownMod > 1); a passive player's bets need more.
    // V4: bets fired ON a fresh scare card into a hand that does not beat the
    // new class get extra respect; in-position calls realize equity better.
    const impliedBonus = drawsLive && equity >= 0.25 ? 0.04 : 0;
    let respect = 2 - exploit.callDownMod; // maniac 0.8, neutral 1, passive 1.15
    if (dangered) respect += 0.15;
    // V7 overbet polarity: an overbet is nuts-or-bluffs. Medium hands without
    // a nut blocker fold more; holding the blocker shifts toward the catch.
    if (useSizeReads && betRatio > 1.2) respect += blocker ? -0.05 : 0.08;
    const posEdge = useIQ ? (ip ? -0.012 : 0.008) : 0;
    const sizingPenalty = (Math.min(0.06, betRatio * 0.04) + mw * 0.5) * respect;
    if (equity + impliedBonus >= potOdds + 0.03 * respect + sizingPenalty + posEdge) {
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
      equity >= potOdds - 0.04 &&
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
          ? simulateEquity(keep, communityCards, 1, vi, 160)
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

  /** Build a bet decision sized as a fraction of pot, clamped to legal bounds. */
  private static betSize(
    pot: number,
    fraction: number,
    player: SeatPlayer,
    gs: HorseGameStateV2,
    vi: VariantInfo,
    params: StyleParams
  ): HorseDecision {
    return this.legalize(
      { action: 'bet', amount: pot * fraction * params.sizingMultiplier, thinkTime: 0 },
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
        // No legal non-all-in bet exists.
        return amt >= stack * 0.9
          ? { action: 'all_in', thinkTime: 0 }
          : { action: 'check', thinkTime: 0 };
      }
      amt = Math.min(floorCents(amt), maxBet);
      if (amt < minBet) amt = minBet;
      if (amt >= stack * 0.92) return { action: 'all_in', thinkTime: 0 };
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
      amt = Math.min(floorCents(amt), cap);
      if (amt < minRaiseTo) amt = minRaiseTo;
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

    return d; // fold / check / all_in are always legal here
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
    const candidates = [d.amount!, toCents(d.amount! + 0.01), toCents(d.amount! - 0.01)];
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

  private static computeThinkTime(
    d: HorseDecision,
    gs: HorseGameStateV2,
    params: StyleParams,
    toCall: number
  ): number {
    const [minT, maxT] = params.thinkRange;
    let think = minT + fastRandom() * (maxT - minT);
    const simple = d.action === 'check' || d.action === 'fold';
    if (simple) think *= 0.55;
    if (d.action === 'raise' || d.action === 'all_in') think *= 1.25;
    const headsUp = gs.players.filter((p) => !p.is_folded).length === 2;
    if (headsUp) think *= 0.75;
    if (gs.stage === 'river' && toCall > gs.pot * 0.5) think *= 1.35; // big river decision
    if (gs.stage === 'preflop' && simple) think *= 0.7; // snap-folds preflop
    return Math.round(Math.max(700, Math.min(think, 8000)));
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
