/**
 * Winner-unit scaling after rake: the two pure settlement helpers HandController
 * pays every pot with, moved here unchanged from HandController.ts (P13.3,
 * October 6, 2026) so that a caller needing only the arithmetic (the joint
 * multiway owner's settlement replica, `multiway/JointDeductions.ts`) does not
 * load the whole controller and, through it, the database client.
 * HandController imports them from here and re-exports the two public ones,
 * so every existing import keeps working. This module imports nothing.
 */

/**
 * Scale winners' pre-rake amounts down to the post-rake total, in whole cents.
 *
 * Exported and pure so the invariant below can be tested directly rather than
 * only through a 10,000-hand fuzz run.
 *
 * TWO POST-CONDITIONS, both load-bearing:
 *   1. `sum(result) === round(totalWinnings * 100)` — no chip is created or
 *      destroyed by the rake deduction.
 *   2. `result[i] <= round(preRakeAmounts[i] * 100)` — no winner is paid more
 *      than they were entitled to BEFORE rake. Rake only ever takes away, so a
 *      winner rising above their pre-rake figure means a cent moved from
 *      another winner's stack into theirs.
 *
 * (2) is the one that was broken. The rounding remainder was handed to
 * `adjusted[0]` unconditionally, and index 0 is the MAIN-pot winner — by
 * construction the shortest all-in stack at the table. In a side-pot hand that
 * player is not eligible for the chips above the main pot, so the cent came out
 * of a side-pot winner. Found by the D24 chip-conservation fuzzer (INV-7):
 * main pot 1.93, u3 all-in for 0.32, four side pots above them; u3 was eligible
 * for 1.93 and was paid 1.94. Totals still balanced, which is exactly why plain
 * conservation never caught it — the cent moved between players.
 *
 * Placing the remainder under the pre-rake caps always succeeds: total headroom
 * is `rakeCents + remainder`, which is never less than `remainder`.
 */
export function scaleWinnerCentsForRake(
  preRakeAmounts: readonly number[],
  totalWinnings: number
): number[] {
  return scaleWinnerUnitsForRake(preRakeAmounts, totalWinnings, 100);
}

export function scaleWinnerUnitsForRake(
  preRakeAmounts: readonly number[],
  totalWinnings: number,
  unitsPerAmount: 1 | 100
): number[] {
  // Round 40 audit Pass 3 fix: integer-cents arithmetic with Math.round (NOT
  // Math.trunc) for the float->cents conversion. IEEE 754 drift can make a pot
  // of "$140.30" actually be 140.29999..., and Math.trunc(140.299... * 100) is
  // 13479 rather than 13480 — exactly 1c lost per chop pot with any drift.
  const totalCents = Math.round(totalWinnings * unitsPerAmount);
  const entitlementCents = preRakeAmounts.map((a) => Math.round(a * unitsPerAmount));
  const totalWinnerCents = entitlementCents.reduce((s, c) => s + c, 0) || 1;

  const adjusted = entitlementCents.map((c) => Math.round((c * totalCents) / totalWinnerCents));

  let remainder = totalCents - adjusted.reduce((s, a) => s + a, 0);

  // Positive remainder: rounding dust. Place it only where it does not exceed
  // the winner's pre-rake entitlement.
  let placedOne = true;
  while (remainder > 0 && placedOne) {
    placedOne = false;
    for (let i = 0; i < adjusted.length && remainder > 0; i++) {
      if (adjusted[i] >= entitlementCents[i]) continue;
      adjusted[i]++;
      remainder--;
      placedOne = true;
    }
  }

  // Negative remainder: rounding overshot. Pull back evenly, never below zero.
  let pulledOne = true;
  while (remainder < 0 && pulledOne) {
    pulledOne = false;
    for (let i = 0; i < adjusted.length && remainder < 0; i++) {
      if (adjusted[i] <= 0) continue;
      adjusted[i]--;
      remainder++;
      pulledOne = true;
    }
  }

  return adjusted;
}

/**
 * Scale a MULTI-BOARD hand's pre-rake awards down to the post-rake total, in
 * whole payout units, by largest remainder (natural-evidence F2, 2026-10-03).
 *
 * Each player is owed exactly `entitlement * total / grossEntitlement`. Every
 * player gets the floor of that exact share; the few indivisible units left
 * over go one each to the largest fractional remainders, and a tie between
 * equal remainders goes by the engine's odd-chip rule - the first winner
 * clockwise of the button (`oddChipRank`, lower first; distributePot, Bible V8
 * 2.7). So every player lands strictly within one unit of the exact share, a
 * player whose exact share is whole (a sole board winner on an even split)
 * gets exactly that, and nobody exceeds their pre-rake entitlement while the
 * total is below the gross.
 *
 * scaleWinnerUnitsForRake rounds every share to nearest and then pulls any
 * overshoot from index 0. On a multi-board hand index 0 is the board-1 winner,
 * so two split halves of 3.925 both rounded up to 3.93 and the board-1
 * winner's exact 7.85 paid 7.84 (hand 177246036add; 91 two-board bombs one
 * cent off). That function still serves single-board and run-it-N hands,
 * unchanged.
 *
 * Integer arithmetic throughout (BigInt for the products), so a large pot
 * cannot lose precision in `entitlement * total`.
 */
export function scaleMultiBoardWinnerUnits(
  preRakeAmounts: readonly number[],
  totalWinnings: number,
  unitsPerAmount: 1 | 100,
  oddChipRank: readonly number[]
): number[] {
  const total = BigInt(Math.max(0, Math.round(totalWinnings * unitsPerAmount)));
  const entitlement = preRakeAmounts.map((a) =>
    BigInt(Math.max(0, Math.round(a * unitsPerAmount)))
  );
  const gross = entitlement.reduce((sum, units) => sum + units, 0n);
  if (gross === 0n) return preRakeAmounts.map(() => 0);
  const floors = entitlement.map((units) => (units * total) / gross);
  const remainders = entitlement.map((units) => (units * total) % gross);
  let leftover = total - floors.reduce((sum, units) => sum + units, 0n);
  const rank = (i: number) => oddChipRank[i] ?? Number.MAX_SAFE_INTEGER;
  const order = preRakeAmounts
    .map((_, i) => i)
    .sort((a, b) => {
      if (remainders[a] !== remainders[b]) return remainders[a] > remainders[b] ? -1 : 1;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a - b;
    });
  const result = floors.map((units) => Number(units));
  for (const i of order) {
    if (leftover <= 0n) break;
    result[i] += 1;
    leftover -= 1n;
  }
  return result;
}
