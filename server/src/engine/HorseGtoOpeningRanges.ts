/**
 * ═══════════════════════════════════════════════════════════════════════════
 * V70 GTO OPENING RANGES — Hold'em raise-first-in (Dan 2026-10-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "AUDIT AND IMPROVE THE HORSES OPENING RANGES IN BOTH TOURNAMENTS AND
 * CASH GAMES, THEY SEEM LIKE THEY ARE OFF OPPOSED TO WHAT THEY SHOULD BE
 * OPENING WITH BASED ON GTO."
 *
 * The audit (docs/changelog/2026-10-31-v70-gto-opening-ranges.md) found the
 * WIDTH of most opening ranges close to target and the MEMBERSHIP wrong. The
 * open test compared `holdemPreflopScore` - a hand-tuned ladder built for
 * raise/3-bet strength, high-card heavy - with one bar per position bucket.
 * That ladder puts KTo/QJo above every suited connector and suited king, so
 * the button folded K7s-K2s, Q7s-Q2s, J6s, T6s, 96s, 85s, 74s, 64s and 53s
 * that every solver opens while opening offsuit rags in their place, and
 * under the gun opened KTo/QTo/JTo/A9o-A7o where a solver opens 22-55,
 * A2s-A5s and the suited broadways. Nine-handed, the three early seats
 * shared one bar and the lojack/hijack another, so UTG and UTG+2 opened the
 * identical 10%.
 *
 * WHAT CHANGES. The open decision (unopened, nobody limped, no-limit
 * two-card hold'em, two or more dealt in) reads the hand on a POSITION's
 * own priority order instead of the generic ladder:
 *
 *  - The position is the number of dealt-in players still to act behind
 *    hero, blinds included (SB 1, BTN 2, CO 3, HJ 4, LJ 5, UTG+2 6, UTG+1 7,
 *    UTG 8), so a 6-max UTG and a 9-max lojack - the same five players
 *    behind - open the same range, and every full-ring seat is its own.
 *  - Each position's order comes from a reference chart (below), ties
 *    broken by the next wider position's chart and finally by the old
 *    ladder, so a looser style extends into exactly the hands the next seat
 *    adds.
 *  - The order is mapped back onto the holdemPreflopScore scale by combo
 *    share (a hand ranked at the top 20% of this seat's order reads as the
 *    score whose top share is 20%). Every bar, style tightness multiplier,
 *    ICM premium, bubble widen and maniac bar therefore keeps its meaning in
 *    exactly the units it was written in; only the ORDER of hands changes.
 *  - The base bar is derived from a target share (OPEN_TARGET) on the same
 *    scale rather than typed as a literal.
 *
 * SOURCE. The charts are transcriptions of the standard solver-derived
 * 6-max 100bb opening ranges (2.5x opens, rake; GTO Wizard NL500 6-max
 * simplified RFI, solver widths UTG/LJ ~17%, HJ ~21%, CO ~28%, BTN ~45%,
 * SB raise ~45%) and the matching full-ring early-seat charts (UTG ~11%,
 * UTG+1 ~13%, UTG+2 ~15%). They are written generously at the edge (their
 * frequency-weighted widths run a few points over those figures) because
 * they supply the ORDER only; the width is OPEN_TARGET's.
 * Tournament widths are the 1bb big-blind-ante MTT chip-EV RFI shape
 * (8-max 50bb: UTG 17.6, LJ 22.5, HJ 27.1, CO 34.5, BTN 46.7), with the
 * horse's ICM premium (riskAdd) left to tighten them as before. No solver
 * artifact for unopened deep-stack RFI exists in this repository (the
 * memory_charts_gold set is push/fold at <=25bb), so these are reference
 * charts, not a hydrated solver read. Wherever the jam-or-fold structure
 * owns the stack (the push/fold charts at <= 15bb, GtoCharts.ts; the
 * push/fold and red/orange M-zone shoves up to 22bb) nothing here applies.
 *
 * Hold'em only. Never keyed on who the opponents are.
 */

import type { Card } from '../types.js';
import { holdemPreflopScore } from './HorseEval.js';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
const RV: Record<string, number> = Object.fromEntries(RANKS.map((r, i) => [r, 14 - i]));

/** All 169 classes with their combo counts. */
export const HAND_CLASSES: readonly { cls: string; combos: number }[] = (() => {
  const out: { cls: string; combos: number }[] = [];
  for (let i = 0; i < 13; i++)
    for (let j = 0; j < 13; j++) {
      if (i === j) out.push({ cls: RANKS[i] + RANKS[j], combos: 6 });
      else if (j > i) out.push({ cls: RANKS[i] + RANKS[j] + 's', combos: 4 });
      else out.push({ cls: RANKS[j] + RANKS[i] + 'o', combos: 12 });
    }
  return out;
})();

const COMBOS: Record<string, number> = Object.fromEntries(
  HAND_CLASSES.map((h) => [h.cls, h.combos])
);

/** "A5s" -> representative cards for the legacy ladder (tie-break only). */
function repCards(cls: string): [Card, Card] {
  const a = cls[0];
  const b = cls[1];
  const suited = cls[2] === 's';
  return [
    { rank: a, suit: 'spades' } as Card,
    { rank: b, suit: suited ? 'spades' : 'hearts' } as Card,
  ];
}

/**
 * Parse a chart string: comma-separated tokens, each `range[:freq]`.
 * Ranges: "TT", "22+", "A2s+", "K9s+" (kicker up to one below the high card),
 * "ATo+", "K5s-K8s", "22-44".
 */
export function parseChart(spec: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of spec.split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const [range, f] = tok.split(':');
    const freq = f === undefined ? 1 : Number(f);
    if (!(freq >= 0 && freq <= 1)) throw new Error(`bad_chart_freq:${tok}`);
    for (const cls of expandRange(range)) out[cls] = Math.max(out[cls] ?? 0, freq);
  }
  return out;
}

function expandRange(range: string): string[] {
  const plus = range.endsWith('+');
  const body = plus ? range.slice(0, -1) : range;
  if (body.includes('-')) {
    const [lo, hi] = body.split('-');
    const pair = lo[0] === lo[1];
    if (pair) {
      const out: string[] = [];
      for (let v = RV[lo[0]]; v <= RV[hi[0]]; v++) out.push(rankOf(v) + rankOf(v));
      return out;
    }
    const kind = lo[2];
    const out: string[] = [];
    for (let v = RV[lo[1]]; v <= RV[hi[1]]; v++) out.push(lo[0] + rankOf(v) + kind);
    return out;
  }
  if (body.length === 2) {
    if (!plus) return [body];
    const out: string[] = [];
    for (let v = RV[body[0]]; v <= 14; v++) out.push(rankOf(v) + rankOf(v));
    return out;
  }
  if (!plus) return [body];
  const out: string[] = [];
  for (let v = RV[body[1]]; v < RV[body[0]]; v++) out.push(body[0] + rankOf(v) + body[2]);
  return out;
}

function rankOf(v: number): string {
  return RANKS[14 - v];
}

/**
 * Reference opening charts by players-behind (blinds included). Frequencies
 * are the solver's raise frequency for the class; 0 or absent = fold.
 */
export const GTO_OPEN_CHARTS: Readonly<Record<number, Record<string, number>>> = {
  // UTG, nine-handed (~11%)
  8: parseChart(
    '44+,22-33:0.4,A9s+,A6s-A8s:0.4,A2s-A5s:0.6,KTs+,K9s:0.3,QTs+,Q9s:0.2,JTs,J9s:0.2,T9s:0.5,98s:0.2,' +
      'AJo+,ATo:0.3,KQo,KJo:0.3'
  ),
  // UTG+1, nine-handed (~13%)
  7: parseChart(
    '33+,22:0.5,A9s+,A6s-A8s:0.7,A2s-A5s:0.8,KTs+,K9s:0.6,QTs+,Q9s:0.4,JTs,J9s:0.5,T9s:0.7,98s:0.3,87s:0.2,' +
      'ATo+:0.6,AJo+,KQo,KJo:0.6,QJo:0.2'
  ),
  // UTG+2, nine-handed (~15%)
  6: parseChart(
    '55+,22-44:0.6,A2s+,K9s+,K8s:0.4,K7s:0.2,Q9s+,J9s+,T9s,T8s:0.3,98s:0.5,87s:0.3,76s:0.3,65s:0.2,' +
      'ATo+,KJo+,KTo:0.2,QJo:0.5'
  ),
  // LJ (6-max UTG; ~17%)
  5: parseChart(
    '44+,22-33:0.6,A2s+,K8s+,K6s-K7s:0.5,K5s:0.2,Q9s+,Q8s:0.3,J9s+,J8s:0.2,T9s,T8s:0.5,98s:0.7,87s:0.5,' +
      '76s:0.5,65s:0.4,54s:0.2,ATo+,A5o:0.2,KJo+,KTo:0.4,QJo:0.6,QTo:0.1,JTo:0.2'
  ),
  // HJ (~21%)
  4: parseChart(
    '22+,A2s+,K5s+,K4s:0.5,K2s-K3s:0.2,Q8s+,Q7s:0.3,Q6s:0.2,J8s+,J7s:0.3,T8s+,T7s:0.3,98s,97s:0.6,' +
      '87s,86s:0.3,76s,75s:0.2,65s:0.8,54s:0.5,ATo+,A9o:0.7,A8o:0.2,A5o:0.3,KTo+,K9o:0.2,QJo,QTo:0.6,' +
      'JTo:0.7,T9o:0.1'
  ),
  // CO (~28%)
  3: parseChart(
    '22+,A2s+,K2s+,Q6s+,Q5s:0.6,Q2s-Q4s:0.3,J7s+,J6s:0.3,T7s+,T6s:0.3,96s+,95s:0.1,86s+,85s:0.2,75s+,' +
      '74s:0.1,64s:0.6,65s,54s,53s:0.5,43s:0.3,A8o+,A7o:0.6,A6o:0.3,A5o:0.8,A4o:0.5,A3o:0.2,KTo+,K9o:0.8,' +
      'K8o:0.2,QTo+,Q9o:0.6,JTo,J9o:0.5,T9o:0.6,98o:0.1'
  ),
  // BTN (~45%)
  2: parseChart(
    '22+,A2s+,K2s+,Q2s+,J4s+,J3s:0.7,J2s:0.5,T5s+,T4s:0.6,T3s:0.4,T2s:0.3,95s+,94s:0.4,93s:0.2,85s+,' +
      '84s:0.4,74s+,73s:0.3,63s+,62s:0.1,53s+,52s:0.3,43s,42s:0.6,32s:0.5,A2o+,K8o+,K7o:0.8,K6o:0.6,' +
      'K5o:0.5,K4o:0.3,K3o:0.1,Q9o+,Q8o:0.8,Q7o:0.2,J9o+,J8o:0.8,J7o:0.2,T9o,T8o:0.8,98o:0.8,97o:0.3,' +
      '87o:0.5,76o:0.3,65o:0.1'
  ),
  // SB raise, folded to (raise part of a raise/limp strategy; ~45%)
  1: parseChart(
    '22+,A2s+,K2s+,Q2s+,J3s+,J2s:0.6,T5s+,T4s:0.5,T2s-T3s:0.3,95s+,94s:0.3,85s+,84s:0.3,74s+,73s:0.2,' +
      '63s+,53s+,52s:0.2,43s,42s:0.4,32s:0.3,A2o+,K7o+,K5o-K6o:0.6,K2o-K4o:0.3,Q8o+,Q7o:0.5,Q6o:0.2,' +
      'J8o+,J7o:0.3,T8o+,T7o:0.2,98o,97o:0.5,87o:0.6,76o:0.4,65o:0.2'
  ),
};

/** Widest index with a chart; deeper seats reuse UTG's. */
const MAX_BEHIND = 8;

/**
 * Target open shares (percent of 1,326 combos) for a balanced horse at
 * tightness 1.0, before the ICM premium. `cash` is no ante; `ante` is any
 * table with dead money (tournament big blind ante, cash ante).
 *
 * Cash sits at the lower half of each solver band (UTG/LJ 15-18, HJ 19-23,
 * CO 26-30, BTN 40-48, SB 40-50): measured against the human-calibrated
 * field, the centre of the bands (17.5/21.5/28/45/45) ran -4.40 +/- 3.33 at
 * 100bb and -5.07 +/- 2.31 bb/100 at 40bb, while the same orders at these
 * widths ran +1.83 +/- 2.33 and -1.12 +/- 1.90 (the order alone, at the old
 * widths, +1.95 / +0.22). The fleet's calling-heavy opponents punish width,
 * not membership. Ante targets are the MTT chip-EV shape; the ICM premium
 * brings the measured 9-handed 50bb ranges to UTG 16, HJ 24.5, CO 31,
 * BTN 46.
 */
export const OPEN_TARGET: Readonly<Record<'cash' | 'ante', Readonly<Record<number, number>>>> = {
  cash: { 1: 41, 2: 43, 3: 26.5, 4: 20.5, 5: 16, 6: 14, 7: 12.5, 8: 11 },
  ante: { 1: 48, 2: 51, 3: 34, 4: 26, 5: 23, 6: 21, 7: 19, 8: 17.5 },
};

/**
 * Short-handed targets. Three-handed the button and small blind play wider
 * than the same seats at a full table (two players to get through and, in a
 * spin, blinds that eat the stack: standard 3-max charts BTN ~50-60%, SB
 * ~55-65% raise plus limp). Heads-up the small blind is the button and plays
 * the large majority of hands (~80-100% raise or limp at 20bb+).
 */
export const OPEN_TARGET_THREE: Readonly<
  Record<'cash' | 'ante', Readonly<Record<number, number>>>
> = {
  cash: { 1: 44, 2: 47 },
  ante: { 1: 50, 2: 54 },
};
export const OPEN_TARGET_HU: Readonly<Record<'cash' | 'ante', number>> = { cash: 72, ante: 76 };

/** SB folded to: the limp band reaches down to this total share (percent). */
export const SB_LIMP_FLOOR_SHARE: Readonly<Record<'cash' | 'ante', number>> = {
  cash: 58,
  ante: 66,
};
export const SB_LIMP_FLOOR_SHARE_THREE: Readonly<Record<'cash' | 'ante', number>> = {
  cash: 62,
  ante: 70,
};
export const SB_LIMP_FLOOR_SHARE_HU: Readonly<Record<'cash' | 'ante', number>> = {
  cash: 90,
  ante: 94,
};

// ── The legacy scale, read as a function of share ─────────────────────────
// Distinct score levels with the combo share at their block midpoint,
// descending in score. scoreAtShare interpolates linearly, so it is strictly
// monotone and a share maps to one score.
const LEVELS: { score: number; share: number }[] = (() => {
  const byScore = new Map<number, number>();
  for (const h of HAND_CLASSES) {
    const [a, b] = repCards(h.cls);
    const s = Math.round(holdemPreflopScore(a, b, false) * 1e6) / 1e6;
    byScore.set(s, (byScore.get(s) ?? 0) + h.combos);
  }
  const scores = [...byScore.keys()].sort((x, y) => y - x);
  const out: { score: number; share: number }[] = [];
  let cum = 0;
  for (const s of scores) {
    const c = byScore.get(s)!;
    out.push({ score: s, share: (cum + c / 2) / 1326 });
    cum += c;
  }
  return out;
})();

/** The legacy-ladder score whose top share is `q` (0..1). */
export function scoreAtShare(q: number): number {
  if (q <= LEVELS[0].share) return LEVELS[0].score;
  const last = LEVELS[LEVELS.length - 1];
  if (q >= last.share) return last.score;
  for (let i = 1; i < LEVELS.length; i++) {
    const hi = LEVELS[i - 1];
    const lo = LEVELS[i];
    if (q <= lo.share) {
      const w = (q - hi.share) / (lo.share - hi.share);
      return hi.score + (lo.score - hi.score) * w;
    }
  }
  return last.score;
}

function legacyScore(cls: string): number {
  const [a, b] = repCards(cls);
  return holdemPreflopScore(a, b, false);
}

/** Per players-behind: class -> mapped open strength, and the priority order. */
const ORDER: Record<number, string[]> = {};
const OPEN_STRENGTH: Record<number, Record<string, number>> = {};
for (let k = 1; k <= MAX_BEHIND; k++) {
  // Tie-break chain: own chart, then each wider seat's chart, then the ladder.
  const chain: Record<string, number>[] = [];
  for (let j = k; j >= 1; j--) chain.push(GTO_OPEN_CHARTS[j]);
  const order = HAND_CLASSES.map((h) => h.cls).sort((x, y) => {
    for (const c of chain) {
      const d = (c[y] ?? 0) - (c[x] ?? 0);
      if (Math.abs(d) > 1e-9) return d;
    }
    return legacyScore(y) - legacyScore(x);
  });
  ORDER[k] = order;
  const map: Record<string, number> = {};
  let cum = 0;
  for (const cls of order) {
    const c = COMBOS[cls];
    map[cls] = scoreAtShare((cum + c / 2) / 1326);
    cum += c;
  }
  OPEN_STRENGTH[k] = map;
}

/** Clamp a players-behind count onto the charted seats. */
export function chartSeat(playersBehind: number): number {
  return Math.max(1, Math.min(MAX_BEHIND, Math.round(playersBehind)));
}

export function gtoOpenOrder(playersBehind: number): readonly string[] {
  return ORDER[chartSeat(playersBehind)];
}

/** The 169-class label for two hole cards (higher rank first). */
export function holdemClass(c1: Card, c2: Card): string | null {
  const r1 = RV[c1?.rank];
  const r2 = RV[c2?.rank];
  if (!r1 || !r2) return null;
  if (r1 === r2) return c1.rank + c2.rank;
  const [hi, lo] = r1 > r2 ? [c1, c2] : [c2, c1];
  return hi.rank + lo.rank + (c1.suit === c2.suit ? 's' : 'o');
}

/**
 * The open strength of these cards from a seat with `playersBehind` dealt-in
 * players still to act, on the holdemPreflopScore scale. Null when the cards
 * are not a two-card hold'em hand.
 */
export function gtoOpenStrength(c1: Card, c2: Card, playersBehind: number): number | null {
  const cls = holdemClass(c1, c2);
  if (!cls) return null;
  return OPEN_STRENGTH[chartSeat(playersBehind)][cls] ?? null;
}

/**
 * The base open bar (pre-tightness, pre-premium) for this seat and table.
 * `dealt` is the number of players dealt in (2 = heads-up).
 */
export function gtoOpenBar(playersBehind: number, ante: boolean, dealt = 6): number {
  const key = ante ? 'ante' : 'cash';
  const k = chartSeat(playersBehind);
  if (dealt <= 2) return scoreAtShare(OPEN_TARGET_HU[key] / 100);
  if (dealt === 3 && k <= 2) return scoreAtShare(OPEN_TARGET_THREE[key][k] / 100);
  return scoreAtShare(OPEN_TARGET[key][k] / 100);
}

/** The SB limp floor on the same scale (folded to the small blind). */
export function gtoSbLimpFloor(ante: boolean, dealt = 6): number {
  const key = ante ? 'ante' : 'cash';
  const table =
    dealt <= 2
      ? SB_LIMP_FLOOR_SHARE_HU
      : dealt === 3
        ? SB_LIMP_FLOOR_SHARE_THREE
        : SB_LIMP_FLOOR_SHARE;
  return scoreAtShare(table[key] / 100);
}

/** Combo-weighted width of a reference chart, in percent. */
export function chartWidth(playersBehind: number): number {
  const c = GTO_OPEN_CHARTS[chartSeat(playersBehind)];
  let w = 0;
  for (const [cls, f] of Object.entries(c)) w += f * COMBOS[cls];
  return (100 * w) / 1326;
}
