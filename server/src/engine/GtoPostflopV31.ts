/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GTO POSTFLOP V31 — suit-aware open-node cells, with the size the solver
 * actually bet (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The sibling of GtoPostflop.ts, reading `gto_postflop_v31` instead of
 * `gto_postflop_compact`. It is a SIBLING and not a replacement because the
 * two source exports are DISJOINT: of 9,584 sampled turn rows, 3,936 carry
 * v1 `tree_lines` (what V29/V30 aggregate) and 5,648 carry v2 `actions`
 * (what V31 aggregates) — and zero carry both. V31 is the 59% of the turn
 * that V30 structurally walks past, so the consult reads V31 first and falls
 * back to V30, and neither can answer for the other.
 *
 * ── WHAT THIS LAYER HAS THAT V30 CANNOT ────────────────────────────────
 *
 * 1. A REAL BET SIZE. Every solved tree in the v1 warehouse offers exactly
 *    one root bet, `b16` (16% of pot), on every street at every stack depth
 *    from 8bb to 150bb. So the v1-derived brain can only ever say "check, or
 *    bet 16% of pot" — its bet_big branch is unreachable on turn and river
 *    (0 of 444,020 turn hand entries). v2 carries an explicit size per
 *    action, and the cell stores it: flop 33% and 75% exactly (sd 0), turn
 *    246.8% on average (117-263, sd 36.6). The turn bet this layer plays is
 *    a genuine overbet, which is the single largest thing V30 cannot express.
 *
 *    That is why `sizeFrac` is part of the lookup result rather than a
 *    constant in the caller. A bucket midpoint would have sized the turn
 *    overbet at roughly a third of what the solver bets.
 *
 * 2. SUIT AWARENESS. Cells are keyed `CLASS:flushSuitCount` — how many of
 *    the board's most-present suit the holding contains, 0/1/2. Measured on
 *    the built cells: within one 169-class in one cell, bet frequency
 *    differs across suit buckets by 0.334 on average on the turn, up to
 *    1.000 (one bucket bets always, another never). The old design averaged
 *    that away into a single number wrong for both holdings.
 *
 * ── THE MIRRORING OBLIGATION ───────────────────────────────────────────
 *
 * `boardFlushSuit` here MUST agree with `fn_gto_board_flush_suit` in the
 * database, exactly as `textureClass` must agree with
 * `fn_gto_texture_class_any`. If they disagree, a live board is keyed
 * differently from the way the cell was built and every lookup lands on the
 * wrong holding — silently, because a wrong answer looks exactly like a
 * right one. Pinned by tests on shared examples classified by the
 * production function, including the tie cases.
 *
 * `textureClass` and `snapDepthBucket` are IMPORTED from GtoPostflop.ts
 * rather than reimplemented, for the same reason: one classifier, one
 * behaviour, no drift.
 *
 * ── NO FACING CELLS, STRUCTURALLY ──────────────────────────────────────
 *
 * V29's contaminated `facing` cells were purged on 2026-08-29 and
 * GtoPostflop.ts refuses them defensively at the loader. This store needs
 * no such guard: `gto_postflop_v31` HAS NO facing column, and every v2
 * action set sampled (1,006 rows) is bet/check only — not one contains fold
 * or call. There is nowhere for a facing cell to live, so refusing one
 * would be unreachable code rather than a safety net.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────
 *
 * Open advice can only choose among check and bet — it cannot fold a hand
 * or misprice a call. An empty store returns a miss, the caller falls back
 * to V30 and then to the heuristics, so a loader failure cannot lobotomise
 * the brain.
 */

import type { Card } from '../types.js';
import { textureClass, snapDepthBucket, depthCandidates } from './GtoPostflop.js';

export interface GtoPostflopV31Row {
  street: string;
  game_family: string;
  position: string;
  depth_bucket: number;
  texture_class: string;
  hand_matrix: Record<string, Record<string, number>>;
  /** Mean solver bet size as a % of pot, per bucket, e.g. { bet_big: 262 }. */
  size_pct?: Record<string, number> | null;
}

/** Why a lookup did not answer. Reported so the layer's silence is explainable. */
export type GtoV31Miss = 'no_hand' | 'no_texture' | 'no_cell' | 'hand_not_in_cell' | 'empty_store';

export type GtoV31Lookup =
  | {
      hit: true;
      mix: Record<string, number>;
      /** Bet size as a fraction of pot per bucket, e.g. { bet_big: 2.62 }. */
      sizeFrac: Record<string, number>;
      cell: string;
    }
  | { hit: false; miss: GtoV31Miss };

const store = new Map<
  string,
  { matrix: Record<string, Record<string, number>>; size: Record<string, number> }
>();

/**
 * Suit index, matching the solver's `card = rank*4 + suit` encoding and the
 * database's `fn_gto_board_flush_suit`: c, d, h, s = 0, 1, 2, 3. Confirmed
 * twice over — arithmetically from the payload's own documented endpoint
 * (`AhAs` = 51*50/2+50 = 1325) and empirically, by a spread measurement that
 * identified index 2 as the flush suit on a two-heart board unprompted.
 */
const SUIT_INDEX: Record<string, number> = {
  clubs: 0,
  diamonds: 1,
  hearts: 2,
  spades: 3,
};

function key(
  street: string,
  family: string,
  position: string,
  depth: number,
  texture: string
): string {
  return `${street}|${family}|${position}|${depth}|${texture}`;
}

/**
 * The board's most-present suit as an index, or -1 when no suit appears
 * twice. EXACT mirror of `fn_gto_board_flush_suit`, ties broken by the
 * lowest suit index exactly as the SQL's `order by n desc, suit asc` does.
 *
 * -1 is not a failure: it means the board has no flush suit, every holding
 * buckets to 0, and the cell degenerates to the 169-class behaviour V30
 * already has. That is the correct answer for a rainbow board.
 */
export function boardFlushSuit(board: Card[]): number {
  if (!board || board.length === 0) return -1;
  const counts = [0, 0, 0, 0];
  for (const c of board) {
    const idx = SUIT_INDEX[c?.suit as string];
    if (idx === undefined) continue;
    counts[idx]++;
  }
  let best = -1;
  let bestN = 1; // must appear at least twice
  for (let i = 0; i < 4; i++) {
    if (counts[i] > bestN) {
      bestN = counts[i];
      best = i;
    }
  }
  return best;
}

/**
 * The cell key for a holding: its 169-class plus how many of the board's
 * flush suit it holds. A board with no flush suit gives every holding 0,
 * which is exactly the 169-class cell.
 */
export function v31HandKey(hand: string, holeCards: Card[], board: Card[]): string | null {
  if (!hand || !holeCards || holeCards.length !== 2) return null;
  const fs = boardFlushSuit(board);
  let n = 0;
  if (fs >= 0) {
    for (const c of holeCards) if (SUIT_INDEX[c?.suit as string] === fs) n++;
  }
  return `${hand}:${n}`;
}

export function setGtoPostflopV31(rows: GtoPostflopV31Row[]): number {
  let n = 0;
  for (const r of rows) {
    if (!r) continue;
    if (r.street !== 'flop' && r.street !== 'turn' && r.street !== 'river') continue;
    if (!r.hand_matrix || typeof r.hand_matrix !== 'object') continue;
    const size: Record<string, number> = {};
    if (r.size_pct && typeof r.size_pct === 'object') {
      for (const [bucket, pct] of Object.entries(r.size_pct)) {
        const v = Number(pct);
        if (Number.isFinite(v) && v > 0) size[bucket] = v;
      }
    }
    store.set(key(r.street, r.game_family, r.position, r.depth_bucket, r.texture_class), {
      matrix: r.hand_matrix,
      size,
    });
    n++;
  }
  return n;
}

/**
 * V32 (2026-08-30): the whole suit-aware cell for the facing-defence layer.
 * The board argument exists only for signature symmetry with the V30 getter's
 * caller; keying is identical to gtoStreetAdviceV31 (texture from the board,
 * never substituted).
 */
export function gtoV31CellMatrix(
  street: string,
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev',
  position: string,
  stackBB: number,
  texture: string,
  _board: Card[]
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
      const cell = store.get(key(street, fam, position, d, texture));
      if (cell) return cell.matrix;
    }
  }
  return null;
}

export function gtoPostflopV31Count(): number {
  return store.size;
}

/** Test seam. */
export function _clearGtoPostflopV31(): void {
  store.clear();
}

/**
 * The solver's open-node mix for this exact situation, plus the size each
 * bet bucket actually means.
 *
 * Fallbacks match V30's deliberately, so the two layers agree about what a
 * "near enough" cell is: a tournament spot prefers the ICM aggregate and
 * falls back to chip-EV (never the reverse — chip-EV advice in an ICM spot
 * is the milder error); depth falls back to one neighbouring bucket;
 * TEXTURE IS NEVER SUBSTITUTED, because a monotone board answered with a
 * rainbow cell is worse than no answer at all.
 *
 * Note v2 carries no `tourney_icm` rows at all, so ICM spots always take the
 * chip-EV fallback here. That is a property of the export, not a bug.
 */
export function gtoStreetAdviceV31(args: {
  street: 'flop' | 'turn' | 'river';
  family: 'cash' | 'spin' | 'tourney_icm' | 'tourney_ev';
  position: string;
  stackBB: number;
  board: Card[];
  hand: string | null;
  holeCards: Card[];
}): GtoV31Lookup {
  if (store.size === 0) return { hit: false, miss: 'empty_store' };
  if (!args.hand) return { hit: false, miss: 'no_hand' };
  const tex = textureClass(args.board);
  if (!tex) return { hit: false, miss: 'no_texture' };
  const handKey = v31HandKey(args.hand, args.holeCards, args.board);
  if (!handKey) return { hit: false, miss: 'no_hand' };

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
      const cell = store.get(k);
      if (!cell) continue;
      const entry = cell.matrix[handKey];
      // An absent holding means the solver never reached this node with it.
      // That is no signal, not a reason to try a different cell.
      if (!entry) return { hit: false, miss: 'hand_not_in_cell' };
      const sizeFrac: Record<string, number> = {};
      for (const [bucket, pct] of Object.entries(cell.size)) sizeFrac[bucket] = pct / 100;
      return { hit: true, mix: entry, sizeFrac, cell: k };
    }
  }
  return { hit: false, miss: 'no_cell' };
}
