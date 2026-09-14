/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MYSTERY BOUNTY — INVENTORY BUILDER (pure, no I/O)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Turns a pool of money and a number of chests into the exact list of chests.
 * Nothing here reads the database, the clock, or a random source: give it the
 * same three arguments and it returns the same array, which is what makes the
 * inventory auditable after the fact.
 *
 * THE ONE RULE THAT MATTERS: the chest amounts sum to the pool EXACTLY, in
 * integer cents. Not "to within a cent", not "after rounding". Dan's section
 * 12 requires the event to reconcile to zero, and the only way to be sure of
 * that is to make the arithmetic incapable of losing a cent in the first
 * place. Every division here is integer division with the remainder carried,
 * and the function refuses to return an array that does not add up.
 *
 * The money never touches a float. `bounty_pool` on `tournaments` is a numeric
 * that JavaScript reads as a float and the old bounty code rounded with a
 * `round2` helper — which is exactly how you lose a cent per knockout and
 * cannot say where it went. Callers convert to cents at the boundary
 * (`poolCentsFromNumeric` below, which refuses a value that is not a whole
 * number of cents) and stay in cents until the moment of payment.
 *
 * WHAT "MERGE" MEANS. A ladder of eight tiers needs a field big enough to
 * express eight tiers. Twelve chests cannot carry a 1%-frequency jackpot AND a
 * 3% major AND a 5% large — largest-remainder gives several of them zero
 * chests, and a tier with zero chests must give its money to the tiers that
 * remain, or the pool does not add up. Two further collapses happen for the
 * same reason: a tier whose share cannot give each of its chests a single cent
 * is merged downward, and a tier that would end up worth LESS per chest than
 * the tier below it is merged too, because a `large` worth less than a
 * `medium` is a bug the reveal animation cannot hide.
 */

import {
  MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT,
  mysteryBountyTiers,
  type MysteryBountyProfileName,
  type MysteryBountyTierName,
  applyTopBountyPercent,
} from '../config/mysteryBountySpec.js';

export interface MysteryChest {
  readonly tier: MysteryBountyTierName;
  readonly amountCents: number;
}

/**
 * Convert a `numeric(?,2)` money column into integer cents, refusing anything
 * that is not a whole number of cents.
 *
 * Every money column this touches is written with `round(x, 2)` in SQL, so a
 * third decimal place means something upstream has changed and the conversion
 * would be silently lossy. That is worth a throw: an event that seeds an
 * inventory a cent short of its pool can never reconcile, and the mismatch
 * surfaces hours later at completion when nothing can be done about it.
 */
export function poolCentsFromNumeric(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) throw new Error(`mystery bounty pool is not a number: ${String(value)}`);
  if (n < 0) throw new Error(`mystery bounty pool is negative: ${n}`);
  const cents = Math.round(n * 100);
  // 1e-6 rather than 0: n*100 is a float, so an exact 2dp value such as 4.35
  // lands on 434.99999999999994 and an equality test would reject it.
  if (Math.abs(n * 100 - cents) > 1e-6) {
    throw new Error(`mystery bounty pool ${n} is not a whole number of cents`);
  }
  return cents;
}

/** Integer cents back to the numeric dollars `fn_credit_and_log` expects. */
export function centsToNumeric(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error(`not integer cents: ${cents}`);
  return cents / 100;
}

/**
 * Largest-remainder (Hamilton) apportionment: split `total` into
 * `weights.length` whole parts in proportion to the weights, summing to
 * exactly `total`. Ties go to the earlier index, which keeps the result
 * deterministic — a tie broken at random would make the inventory
 * irreproducible from its inputs, and an inventory nobody can recompute is an
 * inventory nobody can audit.
 */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    // No weights at all: spread evenly rather than returning zeros, because a
    // caller that reaches here still needs `total` distributed somewhere.
    const base = Math.floor(total / n);
    const out = new Array<number>(n).fill(base);
    for (let i = 0; i < total - base * n; i++) out[i] += 1;
    return out;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((e) => Math.floor(e));
  let remainder = total - out.reduce((s, v) => s + v, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    out[order[k].i] += 1;
  }
  // A negative remainder is impossible with floors, but assert rather than
  // assume: this function decides how many chests exist.
  if (remainder !== 0) {
    throw new Error(`largestRemainder failed to distribute ${total} (left ${remainder})`);
  }
  return out;
}

/**
 * Round an amount DOWN to something a player can read at a glance. $1,247.13
 * is not a prize, it is a bank statement; $1,200 is a prize. Whatever is
 * shaved off is not lost — it falls through to the lowest tier, which is the
 * one place a ragged number does no harm because it is already the
 * consolation.
 *
 * Must be monotone non-decreasing in `v`, or the ladder can invert: the
 * step boundaries below are chosen so that `cleanDown(x) <= cleanDown(y)`
 * whenever `x <= y`.
 */
export function cleanDownCents(v: number): number {
  if (v <= 0) return 0;
  let step: number;
  if (v >= 100000)
    step = 10000; // >= $1,000 -> nearest $100
  else if (v >= 10000)
    step = 1000; // >= $100  -> nearest $10
  else if (v >= 1000)
    step = 100; // >= $10   -> nearest $1
  else if (v >= 100)
    step = 10; // >= $1    -> nearest 10c
  else step = 1;
  return Math.max(1, Math.floor(v / step) * step);
}

interface Bucket {
  tier: MysteryBountyTierName;
  count: number;
  share: number;
}

/**
 * Build the chest inventory for one tournament.
 *
 * @param poolCents  the whole mystery pool, in integer cents. Every cent of it
 *                   ends up on a chest.
 * @param drawCount  how many chests to create — one per player who can still
 *                   be knocked out when the mystery phase activates.
 * @param profile    which ladder to use.
 *
 * Returned chests are ordered highest tier first. That is a presentation
 * order, not a draw order: `mysteryBountyDraw.shuffleChests` decides which
 * chest is handed out first, and it uses the CSPRNG.
 */
export function buildInventory(
  poolCents: number,
  drawCount: number,
  profile: MysteryBountyProfileName,
  /**
   * The headline prize as a percentage of the whole pool - spec section 10,
   * default 20. Omitted or out of range means "use the profile as written",
   * which is what every existing caller and test expects.
   */
  topPercent?: number | null
): MysteryChest[] {
  if (!Number.isInteger(poolCents) || poolCents <= 0) {
    throw new Error(
      `mystery bounty pool must be a positive whole number of cents (got ${poolCents})`
    );
  }
  if (!Number.isInteger(drawCount) || drawCount <= 0) {
    throw new Error(`mystery bounty draw count must be a positive integer (got ${drawCount})`);
  }
  if (drawCount > poolCents) {
    // Not a rounding problem — there is genuinely less than one cent per chest.
    throw new Error(
      `mystery bounty pool ${poolCents}c cannot fund ${drawCount} chests (needs at least 1c each)`
    );
  }

  const tiers = applyTopBountyPercent(mysteryBountyTiers(profile), topPercent);

  // ── 1. HOW MANY CHESTS PER TIER ─────────────────────────────────────────
  const counts = largestRemainder(
    drawCount,
    tiers.map((t) => t.frequency)
  );

  // EXACTLY ONE JACKPOT, when the field can carry one. Largest-remainder on a
  // 1% frequency gives zero jackpots below 50 chests and two above 150, and
  // neither is what the event advertises: "one player wins the big one" is the
  // whole premise. Below the threshold there is no jackpot at all rather than
  // a diluted one.
  const wantJackpot = drawCount >= MYSTERY_BOUNTY_MIN_FIELD_FOR_JACKPOT ? 1 : 0;
  const jackpotDelta = wantJackpot - counts[0];
  if (jackpotDelta !== 0) {
    counts[0] = wantJackpot;
    // Take the difference from (or give it to) the tier with the most chests,
    // which is where one chest matters least.
    let fattest = 1;
    for (let i = 2; i < counts.length; i++) if (counts[i] > counts[fattest]) fattest = i;
    counts[fattest] -= jackpotDelta;
    if (counts[fattest] < 0) {
      // Only reachable on an absurdly small field; fall back to putting every
      // chest in the bottom tier and let the merge pass below sort it out.
      for (let i = 0; i < counts.length; i++) counts[i] = 0;
      counts[counts.length - 1] = drawCount;
    }
  }

  // ── 2. DROP EMPTY TIERS ─────────────────────────────────────────────────
  // A tier with no chests still has a pool share, and that share has to go
  // somewhere. Dropping the tier and renormalising over the survivors is that
  // "somewhere": the money is redistributed in proportion to the shares of the
  // tiers that actually exist.
  let buckets: Bucket[] = [];
  for (let i = 0; i < tiers.length; i++) {
    if (counts[i] > 0)
      buckets.push({ tier: tiers[i].tier, count: counts[i], share: tiers[i].poolShare });
  }
  if (buckets.length === 0) {
    buckets = [{ tier: 'base', count: drawCount, share: 100 }];
  }

  // ── 3. MERGE UNTIL THE LADDER IS EXPRESSIBLE ────────────────────────────
  // Two reasons to merge, both checked on every pass because fixing one can
  // create the other:
  //   (a) a tier whose money cannot give each of its chests a single cent;
  //   (b) a tier worth no more per chest than the tier below it.
  // Merging tier i with tier i+1 keeps the LOWER name, so a chest is never
  // labelled richer than it is — except at the top, where the jackpot keeps
  // its name because losing it would remove the event's headline prize.
  for (let guard = 0; guard < tiers.length * 3; guard++) {
    const pools = largestRemainder(
      poolCents,
      buckets.map((b) => b.share)
    );
    let mergeAt = -1;
    for (let i = 0; i < buckets.length; i++) {
      if (pools[i] < buckets[i].count) {
        mergeAt = i;
        break;
      }
      if (i + 1 < buckets.length) {
        const here = pools[i] / buckets[i].count;
        const below = pools[i + 1] / buckets[i + 1].count;
        if (below >= here) {
          mergeAt = i;
          break;
        }
      }
    }
    if (mergeAt < 0) break;
    // The offender is the LAST bucket: it has nowhere below to merge into, so
    // absorb it upward instead.
    const a = mergeAt === buckets.length - 1 ? mergeAt - 1 : mergeAt;
    if (a < 0) {
      buckets = [{ tier: buckets[0].tier, count: drawCount, share: 100 }];
      break;
    }
    const merged: Bucket = {
      tier: a === 0 ? buckets[0].tier : buckets[a + 1].tier,
      count: buckets[a].count + buckets[a + 1].count,
      share: buckets[a].share + buckets[a + 1].share,
    };
    buckets.splice(a, 2, merged);
    if (buckets.length === 1) break;
  }

  // ── 4. MONEY ────────────────────────────────────────────────────────────
  const tierPools = largestRemainder(
    poolCents,
    buckets.map((b) => b.share)
  );
  const last = buckets.length - 1;

  // Round the upper tiers down to readable numbers, then hand the whole
  // remainder — the shavings plus the bottom tier's own share — to the bottom
  // tier. If that would make the bottom tier richer than the one above it, the
  // shavings were too big: fall back to exact division, which cannot invert
  // the ladder because step 3 already guaranteed the raw per-chest values are
  // strictly decreasing.
  const buildWith = (clean: boolean): number[] | null => {
    const per: number[] = [];
    let spent = 0;
    for (let i = 0; i < last; i++) {
      const raw = Math.floor(tierPools[i] / buckets[i].count);
      const v = Math.max(1, clean ? cleanDownCents(raw) : raw);
      per.push(v);
      spent += v * buckets[i].count;
    }
    const remaining = poolCents - spent;
    if (remaining < buckets[last].count) return null;
    const lo = Math.floor(remaining / buckets[last].count);
    const hi = remaining % buckets[last].count > 0 ? lo + 1 : lo;
    if (last > 0 && hi >= per[last - 1]) return null;
    per.push(remaining);
    return per;
  };

  const per = buildWith(true) ?? buildWith(false);
  if (!per) {
    // Both passes refused. Rather than emit an inverted ladder, collapse to a
    // single tier and split the pool evenly — ugly, but honest and exact.
    return evenSplit(poolCents, drawCount, buckets[buckets.length - 1].tier);
  }

  // ── 5. EXPAND ───────────────────────────────────────────────────────────
  const chests: MysteryChest[] = [];
  for (let i = 0; i < last; i++) {
    for (let k = 0; k < buckets[i].count; k++) {
      chests.push({ tier: buckets[i].tier, amountCents: per[i] });
    }
  }
  {
    const remaining = per[last];
    const n = buckets[last].count;
    const lo = Math.floor(remaining / n);
    const extra = remaining - lo * n;
    for (let k = 0; k < n; k++) {
      chests.push({ tier: buckets[last].tier, amountCents: k < extra ? lo + 1 : lo });
    }
  }

  assertInventory(chests, poolCents, drawCount);
  return chests;
}

function evenSplit(
  poolCents: number,
  drawCount: number,
  tier: MysteryBountyTierName
): MysteryChest[] {
  const lo = Math.floor(poolCents / drawCount);
  const extra = poolCents - lo * drawCount;
  const chests: MysteryChest[] = [];
  for (let k = 0; k < drawCount; k++) {
    chests.push({ tier, amountCents: k < extra ? lo + 1 : lo });
  }
  assertInventory(chests, poolCents, drawCount);
  return chests;
}

/**
 * The last line of defence. Every one of these has a way of being violated by
 * a plausible-looking change to the arithmetic above, and every violation is
 * real money: a sum one cent short can never reconcile at completion, a zero
 * amount is a chest that pays nothing, and a missing chest is a knockout with
 * no bounty behind it.
 */
export function assertInventory(
  chests: readonly MysteryChest[],
  poolCents: number,
  drawCount: number
): void {
  if (chests.length !== drawCount) {
    throw new Error(`mystery inventory has ${chests.length} chests, expected ${drawCount}`);
  }
  let sum = 0;
  for (const c of chests) {
    if (!Number.isInteger(c.amountCents) || c.amountCents <= 0) {
      throw new Error(
        `mystery chest amount must be a positive whole number of cents: ${c.amountCents}`
      );
    }
    sum += c.amountCents;
  }
  if (sum !== poolCents) {
    throw new Error(`mystery inventory sums to ${sum}c, pool is ${poolCents}c`);
  }
}

/**
 * Build the inventory at the tournament's own unit (Diamond Phase 9).
 *
 * `buildInventory` above works in cents and is exact to the cent, which is
 * what a chip event needs. A Diamond does not divide: every chest in a
 * Diamond event must be a whole number of Diamonds (100 cents), and the
 * database seed (`fn_mystery_bounty_seed`) refuses a chest that is not on
 * the unit. So the ladder is built in UNITS - the pool in Diamonds, each
 * chest in Diamonds, the same tier arithmetic and the same readable
 * rounding (`cleanDownCents` reads 1,247 Diamonds down to 1,200 exactly as
 * it reads $1,247 down to $1,200) - and scaled back to cents at the end.
 *
 * At a chip unit (1) this is `buildInventory` to the cent, by construction.
 * The unit is required: a caller that has not read the tournament's club
 * cannot say what a chest may hold, and must not seed (see
 * `TournamentManagerBase.maybeActivateMysteryBounty`).
 */
export function buildInventoryAtUnit(
  poolCents: number,
  drawCount: number,
  profile: MysteryBountyProfileName,
  topPercent: number | null | undefined,
  unitCents: number
): MysteryChest[] {
  if (!Number.isInteger(unitCents) || unitCents <= 0) {
    throw new Error(
      `mystery bounty unit must be a positive whole number of cents (got ${unitCents})`
    );
  }
  if (!Number.isInteger(poolCents) || poolCents <= 0 || poolCents % unitCents !== 0) {
    throw new Error(
      `mystery bounty pool must be a positive whole number of units of ${unitCents}c (got ${poolCents}c)`
    );
  }
  if (unitCents === 1) return buildInventory(poolCents, drawCount, profile, topPercent);
  const units = buildInventory(poolCents / unitCents, drawCount, profile, topPercent);
  const chests = units.map((c) => ({ ...c, amountCents: c.amountCents * unitCents }));
  assertInventory(chests, poolCents, drawCount);
  for (const c of chests) {
    if (c.amountCents % unitCents !== 0) {
      throw new Error(`mystery chest ${c.amountCents}c is not on the ${unitCents}c unit`);
    }
  }
  return chests;
}

/** Convenience for the lobby and the tests: collapse an inventory to tier rows. */
export function summariseInventory(
  chests: readonly MysteryChest[]
): Array<{ tier: MysteryBountyTierName; count: number; amountCents: number; totalCents: number }> {
  const byKey = new Map<
    string,
    { tier: MysteryBountyTierName; count: number; amountCents: number; totalCents: number }
  >();
  for (const c of chests) {
    const key = `${c.tier}:${c.amountCents}`;
    const row = byKey.get(key);
    if (row) {
      row.count += 1;
      row.totalCents += c.amountCents;
    } else {
      byKey.set(key, {
        tier: c.tier,
        count: 1,
        amountCents: c.amountCents,
        totalCents: c.amountCents,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.amountCents - a.amountCents);
}
