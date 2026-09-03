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
/**
 * ═══ V37 FLAT PAYOUTS ARE A DIFFERENT OBJECT (Dan 2026-09-02) ═══════════════
 *
 * The recursion below truncates at MAX_DEPTH = 4 places and spreads the rest
 * of the prize mass in proportion to chips. For a top-heavy MTT ladder that
 * is the standard approximation. For a SATELLITE — K identical seats — it is
 * exactly wrong: with K = 10 the first four places carry 40% of the mass and
 * the other 60% is handed out CHIP-PROPORTIONALLY, which says a big stack's
 * extra chips are worth something. They are worth nothing: the tenth seat
 * pays the same as the first, and a stack that can fold its way into the
 * top K has no use for another chip.
 *
 * With flat prizes hero's equity is P(hero is not among the P - K players
 * eliminated) x one prize. That is estimated by simulating eliminations in
 * order, each bust drawn with probability proportional to 1/stack^2, over a
 * bucketed field and a fixed trial count, with a fixed-seed generator so the
 * same spot prices the same way twice. The square is deliberate: the plain
 * 1/stack hazard (the textbook reverse-Harville) gives a 50,000 stack a 5%
 * chance of busting BEFORE a 4,000 stack, which no satellite has ever seen -
 * a big stack has to lose several all-ins to go, a short one loses one.
 * Squaring the hazard makes the big stack's survival move very little with
 * chips won or lost, which is precisely the property a locked seat has. The result behaves the way a satellite does: a covering stack's
 * survival is ~1 and does not move with chips won, so its bubble factor
 * saturates; a short stack's survival moves with every chip.
 */
export function isFlatPayoutCurve(payouts: number[]): boolean {
  const pos = payouts.filter((p) => isFinite(p) && p > 0);
  if (pos.length < 2) return false;
  const first = pos[0];
  // a trailing cash remainder (below a seat) does not break flatness
  const seats = pos.filter((p) => p >= first * 0.9);
  if (seats.length < 2) return false;
  return seats.every((p) => Math.abs(p - first) <= first * 0.05) && seats.length >= pos.length - 1;
}

const SURVIVAL_TRIALS = 600;
const SURVIVAL_MAX_FIELD = 24;

export function flatPayoutSurvival(stacks: number[], seats: number, heroIdx: number): number {
  const clean = stacks.map((s) => (isFinite(s) && s > 0 ? s : 0));
  if (heroIdx < 0 || heroIdx >= clean.length || clean[heroIdx] <= 0) return 0;
  const live = clean.filter((s) => s > 0).length;
  if (seats <= 0) return 0;
  if (live <= seats) return 1;

  // Bucket the field: hero exact, the rest merged pairwise smallest-first
  // until at most SURVIVAL_MAX_FIELD stacks remain. Merging preserves total
  // chips and the order of magnitude of each elimination hazard.
  let field: number[] = [];
  for (let i = 0; i < clean.length; i++) if (i !== heroIdx && clean[i] > 0) field.push(clean[i]);
  field.sort((a, b) => a - b);
  const bustsNeeded = live - seats;
  let mergedAway = 0;
  while (field.length + 1 > SURVIVAL_MAX_FIELD && field.length >= 2) {
    const a = field.shift()!;
    const b = field.shift()!;
    const merged = a + b;
    let lo = 0;
    let hi = field.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (field[mid] < merged) lo = mid + 1;
      else hi = mid;
    }
    field.splice(lo, 0, merged);
    mergedAway++;
  }
  // Each merge removed one seat-holder from the field, so the number of
  // busts the model must play out shrinks by the same count.
  const bustsModeled = Math.max(1, Math.min(field.length, bustsNeeded - mergedAway));

  let seed = 0x9e3779b9 ^ (Math.round(clean[heroIdx]) & 0xffff);
  const rand = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x1_0000_0000;
  };

  let survived = 0;
  const hazard = new Float64Array(field.length + 1);
  for (let t = 0; t < SURVIVAL_TRIALS; t++) {
    // index 0 is hero
    const alive = new Uint8Array(field.length + 1).fill(1);
    let heroOut = false;
    for (let k = 0; k < bustsModeled && !heroOut; k++) {
      let total = 0;
      for (let i = 0; i <= field.length; i++) {
        const st = i === 0 ? clean[heroIdx] : field[i - 1];
        hazard[i] = alive[i] ? 1 / (st * st) : 0;
        total += hazard[i];
      }
      let r = rand() * total;
      let bust = -1;
      for (let i = 0; i <= field.length; i++) {
        r -= hazard[i];
        if (hazard[i] > 0 && r <= 0) {
          bust = i;
          break;
        }
      }
      if (bust < 0) bust = field.length;
      alive[bust] = 0;
      if (bust === 0) heroOut = true;
    }
    if (!heroOut) survived++;
  }
  return survived / SURVIVAL_TRIALS;
}

export function icmEquity(stacks: number[], payouts: number[], heroIdx: number): number {
  if (stacks.length === 0 || heroIdx < 0 || heroIdx >= stacks.length) return 0;
  const clean = stacks.map((s) => (isFinite(s) && s > 0 ? s : 0));
  if (clean[heroIdx] <= 0) return 0;

  // V37: identical prizes are a survival problem, not a ladder.
  if (isFlatPayoutCurve(payouts)) {
    const pos = payouts.filter((p) => isFinite(p) && p > 0);
    const seatPrize = pos[0];
    const seats = pos.filter((p) => p >= seatPrize * 0.9).length;
    return flatPayoutSurvival(clean, seats, heroIdx) * seatPrize;
  }

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
