/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GTO POSTFLOP — V29 flop + V30 turn/river: open nodes play from the solver
 * (Dan 2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 8.8M-row warehouse is aggregated OFFLINE (V29: fn_aggregate_gto_flop,
 * 24 batches; V30: fn_aggregate_gto_street_next, cursor-driven and paced by
 * GtoAggregationDriver — never a live read of the 79 GB table) into
 * gto_postflop_compact: cells keyed by (street, game_family, position, depth
 * bucket, TEXTURE CLASS), each holding mean solver frequencies per 169-hand
 * class. Preloaded by GtoPostflopLoader, read here as a synchronous Map —
 * the same zero-I/O contract as V27 and HorseMind.
 *
 * ── OPEN NODES ONLY (V30 correction, 2026-08-29) ────────────────────────
 *
 * Every solved tree in the warehouse is an OPEN node: the root actions
 * (tree_lines matching r:0:X) are uniformly check / bet — no tree anywhere
 * starts with hero facing a bet. The exported per-hand numbers are
 * trustworthy only at the root; deep-node labels (f, b45) carry
 * contaminated EV-magnitude values (fold "frequencies" averaging 299).
 * V29's 'facing' cells were built from exactly those numbers and were
 * purged from the table (migration 20260829213000); the facing-a-bet
 * consult was removed from HorseLogic in the same change. This store now
 * answers ONE question per street: the solver's check / bet_small /
 * bet_big mix when hero holds the betting lead.
 *
 * ── THE TEXTURE CLASS, STATED HONESTLY ─────────────────────────────────
 *
 * A live board essentially never exact-matches a solved one. Boards are
 * classed by high card (A/B/M/L), suit distribution (m/t/r), pairing
 * (p/u), connectivity (c/d), and the cell is the MEAN of the solver's
 * answers across every solved board in the class — an approximation, and
 * meant to be. textureClass() is MIRRORED by fn_gto_texture_class (3
 * cards) and fn_gto_texture_class_any (4/5 cards) in the database; the
 * classifiers must agree or lookups land in the wrong cell (pinned by
 * tests on shared examples classified by the production functions).
 *
 * ── SAFETY PROPERTIES ───────────────────────────────────────────────────
 *
 *  - Open advice can only choose among check/bet — it can never fold a
 *    hand or misprice a call; the worst case is a differently-sized bet.
 *  - Empty store -> null -> yesterday's heuristics. A loader failure
 *    cannot lobotomize the brain (ablation-equality pinned, like V27).
 *  - An absent hand in a cell means the solver never reached this node
 *    with it — no signal, stay silent, let the heuristics play it.
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

export type GtoStreetAdvice = {
  /** action -> frequency, exactly as stored (already class-mean). */
  mix: Record<string, number>;
  cell: string;
};

const store = new Map<string, Record<string, Record<string, number>>>();

const DEPTH_BUCKETS = [10, 20, 40, 80, 150];

function key(
  street: string,
  family: string,
  position: string,
  depth: number,
  texture: string
): string {
  return `${street}|${family}|${position}|${depth}|${texture}`;
}

export function setGtoPostflop(rows: GtoPostflopRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (!r) continue;
    if (r.street !== 'flop' && r.street !== 'turn' && r.street !== 'river') continue;
    // 'facing' cells were proven contaminated and purged from the table
    // (2026-08-29). Refuse them here too so a stale or restored snapshot
    // cannot resurrect the over-folding bug through the loader.
    if (r.facing !== 'open') continue;
    if (!r.hand_matrix || typeof r.hand_matrix !== 'object') continue;
    store.set(
      key(r.street, r.game_family, r.position, r.depth_bucket, r.texture_class),
      r.hand_matrix
    );
    n++;
  }
  return n;
}

/**
 * V32 (2026-08-30): the WHOLE cell, for the facing-defence layer. Reading a
 * single hand's mix answers "what do I do"; reading the whole matrix from
 * the BETTOR's seat answers "what does a bet at this size mean" — the
 * per-holding bet frequencies ARE the betting range. Same family/depth
 * fallback discipline as gtoStreetAdvice, texture never substituted.
 */
export function gtoV30CellMatrix(
  street: string,
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev',
  position: string,
  stackBB: number,
  texture: string
): Record<string, Record<string, number>> | null {
  const families: string[] =
    family === 'tourney_icm'
      ? ['tourney_icm', 'tourney_ev']
      : family === 'tourney_ev'
        ? ['tourney_ev']
        : [family];
  const depths = depthCandidates(stackBB);
  for (const fam of families) {
    for (const d of depths) {
      const m = store.get(key(street, fam, position, d, texture));
      if (m) return m;
    }
  }
  return null;
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
 * Texture class for 3/4/5-card boards.
 *
 * 3 cards: the EXACT mirror of fn_gto_texture_class — the shipped V29
 * contract, byte-identical, untouched by V30.
 * 4/5 cards: the EXACT mirror of fn_gto_texture_class_any —
 *   high    A/B/M/L of ALL board cards
 *   suits   m = 4+ of one suit, t = exactly 3 (flush possible), r = no 3
 *   paired  any board pair
 *   conn    any 5-rank window holding 3+ distinct board ranks (straights
 *           live), wheel ace counted low
 */
export function textureClass(board: Card[]): string | null {
  if (!board || board.length < 3) return null;
  const n = Math.min(board.length, 5);
  if (board.length > 5) return null;

  const ranks: number[] = [];
  const suits: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = RANKV[board[i]?.rank ?? ''];
    if (!r || !board[i]?.suit) return null;
    ranks.push(r);
    suits.push(board[i].suit);
  }

  const hi = Math.max(...ranks);
  const high = hi === 14 ? 'A' : hi >= 12 ? 'B' : hi >= 9 ? 'M' : 'L';

  if (n === 3) {
    // ── the shipped V29 flop classifier, unchanged ──
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

  // ── 4/5 cards: mirror of fn_gto_texture_class_any ──
  const suitCounts = new Map<string, number>();
  for (const s of suits) suitCounts.set(s, (suitCounts.get(s) ?? 0) + 1);
  const maxSuit = Math.max(...suitCounts.values());
  const suitkind = maxSuit >= 4 ? 'm' : maxSuit === 3 ? 't' : 'r';

  const rankCounts = new Map<number, number>();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  const paired = [...rankCounts.values()].some((c) => c >= 2);

  const distinct = [...rankCounts.keys()];
  let conn = false;
  for (let win = 14; win >= 6 && !conn; win--) {
    let c = 0;
    for (const r of distinct) if (r <= win && r > win - 5) c++;
    if (c >= 3) conn = true;
  }
  if (!conn) {
    // explicit wheel window (A-2-3-4-5)
    let c = 0;
    for (const r of distinct) if (r <= 5 || r === 14) c++;
    if (c >= 3) conn = true;
  }

  return high + suitkind + (paired ? 'p' : 'u') + (conn ? 'c' : 'd');
}

/** Snap a live depth onto the aggregation's buckets. */
/**
 * The candidate depth buckets for a lookup, NEAREST FIRST (2026-08-31).
 *
 * The lookup docstring always said "Depth fallback: the neighbouring
 * bucket". The code did not: it built `[depth, ...others].slice(0, 2)`, and
 * `others` begins at DEPTH_BUCKETS[0] — so the fallback for EVERY depth
 * except 10 was the 10bb cell. A 150bb hero whose 150 cell was missing was
 * answered with short-stack strategy: the one substitution more dangerous
 * than the texture substitution these files explicitly refuse to make,
 * because a 10bb solver jams and stacks off exactly where a 150bb player
 * must not.
 *
 * Nearness is measured in LOG space against the RAW stack, not its snapped
 * bucket: stacks are geometric (the gap 10->20 equals 80->150), and a 35bb
 * stack whose 40 cell is missing is better served by 20 than by anything
 * arithmetic distance would pick. Ties at exact geometric midpoints resolve
 * to the SHALLOWER bucket by sort stability — the milder error at the
 * depths where ties occur.
 */
export function depthCandidates(stackBB: number): number[] {
  const raw = stackBB > 0 && isFinite(stackBB) ? stackBB : 40;
  // The PRIMARY stays snapDepthBucket, whose boundaries are hand-tuned and
  // are what the cells were built against — a pure log-nearest primary would
  // silently re-home live hits (snap(30) is 20; log-nearest is 40). Only the
  // FALLBACK is chosen by log distance, from the remaining buckets.
  const primary = snapDepthBucket(raw);
  const fallback = DEPTH_BUCKETS.filter((d) => d !== primary).sort(
    (a, b) => Math.abs(Math.log(raw / a)) - Math.abs(Math.log(raw / b))
  )[0];
  return [primary, fallback];
}

/**
 * THE DEEPEST THING THE WAREHOUSE KNOWS (2026-09-01).
 *
 * DEPTH_BUCKETS stops at 150, and snapDepthBucket returns 150 for ANY stack
 * over 110 - a 400bb hero and an 800bb hero are both answered with 150bb
 * strategy, silently, with no miss recorded and nothing in the telemetry to
 * say the answer was extrapolated.
 *
 * depthCandidates already refuses the equivalent error in the other
 * direction, and says why: answering a 150bb hero from the 10 cell is "the
 * one substitution more dangerous than the texture substitution these files
 * explicitly refuse to make, because a 10bb solver jams and stacks off
 * exactly where a 150bb player must not." Serving 150bb strategy to a player
 * eight hundred blinds deep is the same error with the sign flipped, and it
 * had no guard at all.
 *
 * The ceiling is set at twice the deepest bucket. That is not arbitrary: this
 * file already tolerates a fallback of one bucket, and the buckets are
 * geometric, so log(300/150) is exactly the distance between 10 and 20 - the
 * widest substitution the depth fallback already makes. Beyond it the error
 * is larger than anything the design permits, so the honest answer is no
 * answer: the consult declines and the heuristic layers, which do scale
 * continuously with stack depth, play the spot.
 */
export const GTO_MAX_DEPTH_BB = 2 * DEPTH_BUCKETS[DEPTH_BUCKETS.length - 1];

/** True when the warehouse cannot honestly speak to this stack depth. */
export function beyondGtoDepthCeiling(stackBB: number): boolean {
  return isFinite(stackBB) && stackBB > GTO_MAX_DEPTH_BB;
}

export function snapDepthBucket(stackBB: number): number {
  if (!(stackBB > 0)) return 40;
  if (stackBB <= 12) return 10;
  if (stackBB <= 30) return 20;
  if (stackBB <= 60) return 40;
  if (stackBB <= 110) return 80;
  return 150;
}

/**
 * Look up the solver's open-node mix for this exact situation.
 *
 * Family fallback: a tournament spot prefers the ICM aggregate and falls back
 * to chip-EV (and vice versa is never done — chip-EV advice in an ICM spot is
 * the milder error, ICM advice in a chip-EV spot over-folds). Depth fallback:
 * the neighbouring bucket, because the fleet's 40bb tables sit near a bucket
 * edge. Texture is NEVER substituted — a monotone board answered with a
 * rainbow cell is worse than no answer. Absent hand -> null (no signal).
 */
export function gtoStreetAdvice(args: {
  street: 'flop' | 'turn' | 'river';
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev';
  position: string;
  stackBB: number;
  board: Card[];
  hand: string | null;
}): GtoStreetAdvice | null {
  if (!args.hand) return null;
  const tex = textureClass(args.board);
  if (!tex) return null;

  const families: string[] =
    args.family === 'tourney_icm'
      ? ['tourney_icm', 'tourney_ev']
      : args.family === 'tourney_ev'
        ? ['tourney_ev']
        : [args.family];

  const depths = depthCandidates(args.stackBB);

  for (const fam of families) {
    for (const d of depths) {
      const k = key(args.street, fam, args.position, d, tex);
      const matrix = store.get(k);
      if (!matrix) continue;
      const entry = matrix[args.hand];
      if (!entry) return null;
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
