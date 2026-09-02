/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GTO CHARTS — the solver database reaches the horse brain (Dan 2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "MAKE SURE THE HORSES HAVE ACCESS TO THE SOLVER DATABASE AND ANY AND ALL
 *  OTHER DATA THEY NEED ACCESS TO WHILE MAKING A DECISION IN REAL TIME ...
 *  THEY'RE NOT JUST GUESSING, THEY HAVE SPECIFIC GTO RENDERED PLAYS."
 *
 * The platform holds 8.8M PioSolver CFR solutions. Until today the brain read
 * NONE of them — every preflop threshold was a hand-tuned literal, which the
 * 169-combo classifier's own header admits ("Hand-tuned tiers — NOT equity vs
 * random"). This module is Stage 1 of closing that gap: the preflop push/fold
 * charts (memory_charts_gold, 240 charts, ~330KB) become an in-memory,
 * synchronous, zero-I/O lookup the live decision can afford.
 *
 * ── WHY IN-MEMORY AND NOT A QUERY ──────────────────────────────────────
 *
 * Two constraints, both measured, decide the architecture:
 *
 *  1. HorseLogic.decide() is SYNCHRONOUS with zero I/O, and its live latency
 *     (horse_decision_latency) runs 0.007ms-17ms. A per-decision query would
 *     make every turn async and add a 5-50ms network round trip to a path
 *     that fires hundreds of times a minute.
 *
 *  2. The solver warehouse has already taken the platform down: the
 *     2026-08-15 incident was a cron that merely COUNTED rows in
 *     solved_spots_gold starving the database until /health read
 *     `liveness: dead`. Casual reads of solver data are not casual.
 *
 * So the charts follow the HorseMind pattern: hydrated by a loader service at
 * boot, refreshed on a slow timer, consulted here as a plain Map read. The
 * whole dataset is ~330KB — smaller than one hand of telemetry.
 *
 * ── WHAT THE CHARTS ARE ────────────────────────────────────────────────
 *
 * memory_charts_gold, verified against production 2026-08-29:
 *
 *   game_type       'Cash' | 'Tournament'
 *   stack_depth     2..20, 25 (big blinds)
 *   hero_position   UTG / MP / CO / BTN / SB  with villain_action 'fold_to_hero'
 *                   (folded to hero: jam or fold), and
 *                   BB with villain_action 'sb_push' (SB jammed: call or fold)
 *   hand_matrix     { "A5s": {"push": 0.964, "fold": 0.036}, ... } — ~70 hands
 *                   per chart. AN ABSENT HAND IS A FOLD: the solver output
 *                   only lists hands with a non-fold branch (72o is absent
 *                   from every chart, and 72o folds).
 *
 * Hold'em only (169 classes assume a 52-card deck), so short deck never
 * consults it, and Omaha/pineapple cannot.
 *
 * ── SCOPE OF AUTHORITY (deliberate, and narrower than the data) ────────
 *
 *  - OPEN jam-or-fold: authoritative at <= 15bb, the classic push/fold zone
 *    where jamming genuinely is the whole strategy. The charts extend to
 *    25bb, but a 25bb "jam or fold" chart describes only the jam branch of a
 *    depth where real players also open small — a fleet that ONLY open-jams
 *    at 25bb would be the robotic tell Dan keeps telling us to remove.
 *  - BB facing an SB jam: authoritative at any charted depth (<= 25bb),
 *    because facing an all-in, call-or-fold IS the entire decision and the
 *    chart answers exactly that question.
 *  - No chart loaded (boot race, load failure) -> null, and the caller falls
 *    back to the heuristics that ran yesterday. The solver upgrades the
 *    brain; its absence must never lobotomize it.
 */

import type { Card } from '../types.js';

export interface GtoChartRow {
  game_type: string;
  stack_depth: number;
  hero_position: string;
  villain_action: string;
  hand_matrix: Record<string, Record<string, number>>;
}

export type GtoAdvice = {
  /** 'push' | 'fold' for opens; 'call' | 'fold' for BB defense. */
  action: string;
  /** Solver frequency of that action for this hand, 0..1. */
  freq: number;
  /** The chart cell that answered, for telemetry and the daily audit. */
  chart: string;
};

/** key: game|villain_action|position|depth */
const charts = new Map<string, Record<string, Record<string, number>>>();

/** The depths that exist in the data. Snapping must match reality, not hope. */
const CHART_DEPTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25];

/** Open jams are authoritative only in the true push/fold zone. */
export const GTO_OPEN_JAM_MAX_BB = 15;
/** BB call-offs use the full charted range. */
export const GTO_BB_DEFEND_MAX_BB = 25;

function chartKey(game: string, villainAction: string, position: string, depth: number): string {
  return `${game}|${villainAction}|${position}|${depth}`;
}

export function setGtoCharts(rows: GtoChartRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (!r || typeof r.stack_depth !== 'number') continue;
    if (!r.hand_matrix || typeof r.hand_matrix !== 'object') continue;
    if (r.game_type !== 'Cash' && r.game_type !== 'Tournament') continue;
    charts.set(
      chartKey(r.game_type, r.villain_action, r.hero_position, r.stack_depth),
      r.hand_matrix
    );
    n++;
  }
  return n;
}

/** Test/ops hook — and the loader's "did anything hydrate" check. */
export function gtoChartCount(): number {
  return charts.size;
}

/** Test seam. */
export function _clearGtoCharts(): void {
  charts.clear();
}

const RANK_ORDER: Record<string, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/**
 * Two hole cards -> the 169-class label the charts key on: pairs "TT",
 * suited "AKs", offsuit "AKo", higher rank first.
 */
export function handClass(c1: Card, c2: Card): string | null {
  if (!c1?.rank || !c2?.rank || !c1?.suit || !c2?.suit) return null;
  const r1 = RANK_ORDER[c1.rank];
  const r2 = RANK_ORDER[c2.rank];
  if (!r1 || !r2) return null;
  if (c1.rank === c2.rank) return `${c1.rank}${c2.rank}`;
  const [hi, lo] = r1 > r2 ? [c1, c2] : [c2, c1];
  return `${hi.rank}${lo.rank}${hi.suit === lo.suit ? 's' : 'o'}`;
}

/** Nearest charted depth. 11.6bb plays the 12bb chart, not a phantom one. */
export function snapDepth(stackBB: number): number {
  let best = CHART_DEPTHS[0];
  let bestDist = Math.abs(stackBB - best);
  for (const d of CHART_DEPTHS) {
    const dist = Math.abs(stackBB - d);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

function lookup(
  game: string,
  villainAction: string,
  position: string,
  stackBB: number,
  hand: string,
  pushAction: string
): GtoAdvice | null {
  const depth = snapDepth(stackBB);
  const key = chartKey(game, villainAction, position, depth);
  const matrix = charts.get(key);
  if (!matrix) return null;

  const entry = matrix[hand];
  if (!entry) {
    // AN ABSENT HAND IS A FOLD. The solver only lists hands with a non-fold
    // branch; inventing a push frequency for 72o because it is "missing"
    // would be exactly the guessing this module replaces.
    return { action: 'fold', freq: 1, chart: key };
  }

  const push = Number(entry[pushAction]) || 0;
  const fold = Number(entry.fold) || 0;
  if (push <= 0 && fold <= 0) return { action: 'fold', freq: 1, chart: key };
  return push >= fold
    ? { action: pushAction, freq: push, chart: key }
    : { action: 'fold', freq: fold, chart: key };
}

/**
 * Folded-to-hero open: jam or fold, from the solver.
 *
 * @param position UTG | MP | CO | BTN | SB (the BB cannot open an unopened pot)
 * @returns null when out of scope — deeper than the push/fold zone, no chart
 *          loaded, or an uncharted position — and the heuristics decide.
 */
export function gtoOpenJam(args: {
  isTournament: boolean;
  position: string;
  stackBB: number;
  hand: string | null;
}): GtoAdvice | null {
  if (!args.hand) return null;
  if (!(args.stackBB > 0) || args.stackBB > GTO_OPEN_JAM_MAX_BB) return null;
  if (!['UTG', 'MP', 'CO', 'BTN', 'SB'].includes(args.position)) return null;
  return lookup(
    args.isTournament ? 'Tournament' : 'Cash',
    'fold_to_hero',
    args.position,
    args.stackBB,
    args.hand,
    'push'
  );
}

/**
 * BB facing an SB all-in: call or fold, from the solver.
 *
 * Effective depth is the SMALLER stack — calling off 25bb against an 8bb jam
 * is an 8bb decision whatever the BB has behind.
 */
export function gtoBbVsSbJam(args: {
  isTournament: boolean;
  effectiveBB: number;
  hand: string | null;
}): GtoAdvice | null {
  if (!args.hand) return null;
  if (!(args.effectiveBB > 0) || args.effectiveBB > GTO_BB_DEFEND_MAX_BB) return null;
  return lookup(
    args.isTournament ? 'Tournament' : 'Cash',
    'sb_push',
    'BB',
    args.effectiveBB,
    args.hand,
    'call'
  );
}
