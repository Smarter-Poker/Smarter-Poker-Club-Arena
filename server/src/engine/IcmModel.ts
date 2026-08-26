/**
 * ═══════════════════════════════════════════════════════════════════════════
 * V16 ICM — Malmuth-Harville equity + bubble factor (2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════
 * The V7-V12 tournament pressure was a flat additive premium (0.02-0.12)
 * keyed on distance to the bubble. Real ICM pressure is a function of the
 * STACK DISTRIBUTION and the PAYOUT CURVE: a short stack on the stone bubble
 * facing a covering stack has a bubble factor near 2-3 (chips lost hurt 2-3x
 * more than chips won help), while the table captain's factor is near 1.
 *
 * Malmuth-Harville: P(player i finishes 1st) = stack_i / total; P(i finishes
 * 2nd | j first) = stack_i / (total - stack_j); recursively down the payout
 * places. Exact MH is exponential in payout depth, so this implementation:
 *   - buckets a large field into at most MAX_MODELED stacks (hero kept
 *     exact; the rest merged pairwise smallest-first, which preserves total
 *     chips and approximately preserves finish distributions);
 *   - truncates recursion at depth 4 and distributes the remaining payout
 *     mass proportionally to remaining stacks (the standard truncation —
 *     places past 4th contribute little curvature).
 *
 * Pure functions, no engine imports — unit-tested against closed-form
 * 2-player and symmetric cases.
 */

const MAX_MODELED = 8;
const MAX_DEPTH = 4;

/** MH probability-weighted prize for ONE hero index. stacks: chips, payouts:
 *  prize per place (any monetary unit), descending. Returns hero's equity in
 *  the same unit as payouts. */
export function icmEquity(stacks: number[], payouts: number[], heroIdx: number): number {
  if (stacks.length === 0 || heroIdx < 0 || heroIdx >= stacks.length) return 0;
  const clean = stacks.map((s) => (isFinite(s) && s > 0 ? s : 0));
  if (clean[heroIdx] <= 0) return 0;

  // Bucket the field (hero exact, others merged smallest-first) so the
  // recursion below stays bounded for any field size.
  let field: number[] = [];
  let hero = clean[heroIdx];
  for (let i = 0; i < clean.length; i++) {
    if (i !== heroIdx && clean[i] > 0) field.push(clean[i]);
  }
  field.sort((a, b) => a - b);
  while (field.length + 1 > MAX_MODELED) {
    const a = field.shift()!;
    const b = field.shift()!;
    // merge two shortest into one stack; total chips preserved
    const merged = a + b;
    let lo = 0;
    let hi = field.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (field[mid] < merged) lo = mid + 1;
      else hi = mid;
    }
    field.splice(lo, 0, merged);
  }
  const all = [hero, ...field];
  const heroI = 0;

  const pays = payouts.slice(0, Math.min(payouts.length, MAX_DEPTH));
  const tailMass = payouts.slice(pays.length).reduce((s, p) => s + p, 0);

  // Recursive MH over the truncated depth.
  const n = all.length;
  const memo = new Map<string, number>();
  const heroPrize = (remaining: number[], heroPos: number, depth: number): number => {
    const total = remaining.reduce((s, x) => s + x, 0);
    if (total <= 0) return 0;
    if (depth >= pays.length) {
      // Remaining payout mass split proportionally to remaining stacks.
      return tailMass > 0 ? (tailMass * remaining[heroPos]) / total : 0;
    }
    const key = depth + '|' + heroPos + '|' + remaining.join(',');
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let eq = 0;
    for (let w = 0; w < remaining.length; w++) {
      const pWin = remaining[w] / total;
      if (pWin <= 0) continue;
      if (w === heroPos) {
        eq += pWin * pays[depth];
      } else {
        const rest = remaining.slice(0, w).concat(remaining.slice(w + 1));
        const newHero = heroPos > w ? heroPos - 1 : heroPos;
        eq += pWin * heroPrize(rest, newHero, depth + 1);
      }
    }
    memo.set(key, eq);
    return eq;
  };

  return heroPrize(all, heroI, 0);
}

/**
 * Bubble factor: how much more chips LOST hurt than chips WON help, for a
 * risk of `riskChips` against the current stakes. 1 = pure chip EV;
 * 2 = losses hurt twice as much. Clamped to [1, 5].
 */
export function bubbleFactor(
  stacks: number[],
  payouts: number[],
  heroIdx: number,
  riskChips: number
): number {
  if (riskChips <= 0) return 1;
  const hero = stacks[heroIdx] ?? 0;
  if (hero <= 0) return 1;

  // CHIP CONSERVATION: the risked chips move between hero and the largest
  // covering-capable opponent — they are never created or destroyed. The
  // first cut added/removed hero's chips in isolation, and the tell was that
  // a winner-take-all payout produced BF 2 when true WTA ICM is exactly
  // chip-proportional (BF must be 1). Conservation also makes the covering
  // asymmetry exact: the opponent who can actually take hero's stack is the
  // one who absorbs it in the loss branch.
  let oppIdx = -1;
  for (let i = 0; i < stacks.length; i++) {
    if (i === heroIdx) continue;
    if (oppIdx === -1 || stacks[i] > stacks[oppIdx]) oppIdx = i;
  }
  if (oppIdx === -1) return 1;
  const risk = Math.min(riskChips, hero, stacks[oppIdx]);
  if (risk <= 0) return 1;

  const now = icmEquity(stacks, payouts, heroIdx);
  const up = stacks.slice();
  up[heroIdx] = hero + risk;
  up[oppIdx] = stacks[oppIdx] - risk;
  const dn = stacks.slice();
  dn[heroIdx] = hero - risk;
  dn[oppIdx] = stacks[oppIdx] + risk;
  const gain = icmEquity(up, payouts, heroIdx) - now;
  const loss = now - icmEquity(dn, payouts, heroIdx);
  if (gain <= 1e-12) return 5;
  return Math.max(1, Math.min(5, loss / gain));
}

/**
 * Convert a bubble factor into the brain's additive equity premium (the same
 * scale icmRisk has always spoken). BF 1 = 0; BF 1.5 = 0.02; BF 2 = 0.04;
 * capped at 0.14.
 */
export function premiumFromBubbleFactor(bf: number): number {
  return Math.max(0, Math.min(0.14, (bf - 1) * 0.04));
}
