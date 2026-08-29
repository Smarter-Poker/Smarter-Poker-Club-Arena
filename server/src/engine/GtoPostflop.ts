/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GTO POSTFLOP — V29: the flop plays from the solver (Dan 2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Stage 2 of the solver integration. The 8.8M-row warehouse was aggregated
 * OFFLINE (fn_aggregate_gto_flop, 24 index-driven batches — never a live read
 * of the 79 GB table) into gto_postflop_compact: 5,556 cells keyed by
 * (street, game_family, position, depth bucket, TEXTURE CLASS, facing), each
 * holding mean solver frequencies per 169-hand class. ~12 MB, preloaded by
 * GtoPostflopLoader, read here as a synchronous Map — the same zero-I/O
 * contract as V27 and HorseMind.
 *
 * ── THE TEXTURE CLASS, STATED HONESTLY ─────────────────────────────────
 *
 * The solved boards are a canonical subset; a live flop essentially never
 * exact-matches one. Boards are therefore classed by the four properties
 * that drive flop strategy — high card (A/B/M/L), suit distribution (m/t/r),
 * pairing (p/u), connectivity (c/d) — and the cell is the MEAN of the
 * solver's answers across every solved board in the class. That is an
 * approximation and is meant to be: it replaces hand-tuned literals with
 * solver-derived frequencies, it does not claim to be an exact solve of the
 * live board. textureClass() below is MIRRORED by fn_gto_texture_class in
 * the database; the two must classify identically or lookups land in the
 * wrong cell (pinned by tests on shared examples).
 *
 * ── SCOPE OF AUTHORITY ──────────────────────────────────────────────────
 *
 *  - Hold'em, FLOP only (turn/river aggregation is a later batch pass).
 *  - 'open' (no bet to face): the c-bet/check mix — check, bet_small
 *    (~third pot), bet_big (~three-quarter pot), rolled at solver frequency.
 *  - 'facing' (a bet to face, hero has not been raised): fold / call /
 *    raise_small / raise_big.
 *  - A SAFETY VALVE the caller applies: a solver "fold" is ignored when the
 *    live MC equity is overwhelming (>= 0.72) — the cell is a class mean and
 *    the specific board can be far better for hero than the class average.
 *    The valve only ever prevents folds, never creates them.
 *  - Empty store -> null -> yesterday's heuristics. A loader failure cannot
 *    lobotomize the brain (ablation-equality pinned, like V27).
 */

import type { Card } from '../types.js';

export interface GtoPostflopRow {
  street: string;
  game_family: string;
  position: string;
  depth_bucket: number;
  texture_class: string;
  facing: string;
  hand_matrix: Record<string, Record<string, number>>;
}

export type GtoFlopAdvice = {
  /** action -> frequency, exactly as stored (already class-mean). */
  mix: Record<string, number>;
  cell: string;
};

const store = new Map<string, Record<string, Record<string, number>>>();

const DEPTH_BUCKETS = [10, 20, 40, 80, 150];

function key(
  family: string,
  position: string,
  depth: number,
  texture: string,
  facing: string
): string {
  return `flop|${family}|${position}|${depth}|${texture}|${facing}`;
}

export function setGtoPostflop(rows: GtoPostflopRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (!r || r.street !== 'flop') continue;
    if (!r.hand_matrix || typeof r.hand_matrix !== 'object') continue;
    store.set(
      key(r.game_family, r.position, r.depth_bucket, r.texture_class, r.facing),
      r.hand_matrix
    );
    n++;
  }
  return n;
}

export function gtoPostflopCount(): number {
  return store.size;
}

/** Test seam. */
export function _clearGtoPostflop(): void {
  store.clear();
}

const RANKV: Record<string, number> = {
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
 * The flop texture class — the EXACT mirror of fn_gto_texture_class.
 * high(A/B/M/L) + suits(m/t/r) + paired(p/u) + connectivity(c/d).
 */
export function textureClass(board: Card[]): string | null {
  if (!board || board.length < 3) return null;
  const ranks: number[] = [];
  const suits: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = RANKV[board[i]?.rank ?? ''];
    if (!r || !board[i]?.suit) return null;
    ranks.push(r);
    suits.push(board[i].suit);
  }

  const hi = Math.max(ranks[0], ranks[1], ranks[2]);
  const high = hi === 14 ? 'A' : hi >= 12 ? 'B' : hi >= 9 ? 'M' : 'L';

  const suitkind =
    suits[0] === suits[1] && suits[1] === suits[2]
      ? 'm'
      : suits[0] === suits[1] || suits[1] === suits[2] || suits[0] === suits[2]
        ? 't'
        : 'r';

  const paired = ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2];

  const distinct = [...new Set(ranks)].sort((a, b) => a - b);
  let conn = false;
  if (distinct.length >= 2) {
    if (distinct[distinct.length - 1] - distinct[0] <= 4) conn = true;
    // wheel: the ace plays low
    if (!conn && distinct[distinct.length - 1] === 14 && distinct[distinct.length - 2] <= 5) {
      conn = true;
    }
  }

  return high + suitkind + (paired ? 'p' : 'u') + (conn ? 'c' : 'd');
}

/** Snap a live depth onto the aggregation's buckets. */
export function snapDepthBucket(stackBB: number): number {
  if (!(stackBB > 0)) return 40;
  if (stackBB <= 12) return 10;
  if (stackBB <= 30) return 20;
  if (stackBB <= 60) return 40;
  if (stackBB <= 110) return 80;
  return 150;
}

/**
 * Look up the solver's flop mix for this exact situation.
 *
 * Family fallback: a tournament spot prefers the ICM aggregate and falls back
 * to chip-EV (and vice versa is never done — chip-EV advice in an ICM spot is
 * the milder error, ICM advice in a chip-EV spot over-folds). Depth fallback:
 * the neighbouring bucket, because the fleet's 40bb tables sit near a bucket
 * edge. Texture is NEVER substituted — a monotone board answered with a
 * rainbow cell is worse than no answer.
 */
export function gtoFlopAdvice(args: {
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev';
  position: string;
  stackBB: number;
  board: Card[];
  facing: 'open' | 'facing';
  hand: string | null;
}): GtoFlopAdvice | null {
  if (!args.hand) return null;
  const tex = textureClass(args.board);
  if (!tex) return null;
  const depth = snapDepthBucket(args.stackBB);

  const families: string[] =
    args.family === 'tourney_icm'
      ? ['tourney_icm', 'tourney_ev']
      : args.family === 'tourney_ev'
        ? ['tourney_ev']
        : [args.family];

  const depths = [depth, ...DEPTH_BUCKETS.filter((d) => d !== depth)].slice(0, 2);

  for (const fam of families) {
    for (const d of depths) {
      const k = key(fam, args.position, d, tex, args.facing);
      const matrix = store.get(k);
      if (!matrix) continue;
      const entry = matrix[args.hand];
      if (!entry) {
        // AN ABSENT HAND IS A FOLD in the solver output. For an 'open' node
        // there is no fold — absence means the solver never reached this node
        // with the hand, so it carries no signal: stay silent and let the
        // heuristics play it.
        if (args.facing === 'facing') return { mix: { fold: 1 }, cell: k };
        return null;
      }
      return { mix: entry, cell: k };
    }
  }
  return null;
}

/**
 * Roll the mix. Returns the chosen action bucket, honoring the exact solver
 * frequencies (renormalized in case rounding left the mass at 0.9998).
 */
export function rollMix(mix: Record<string, number>, rand: () => number): string | null {
  let total = 0;
  for (const v of Object.values(mix)) total += Math.max(0, Number(v) || 0);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const [action, v] of Object.entries(mix)) {
    roll -= Math.max(0, Number(v) || 0);
    if (roll <= 0) return action;
  }
  return Object.keys(mix)[0] ?? null;
}
