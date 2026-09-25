/** The guaranteed minimum uses the full funded entry, including Double Down.
 *
 * CONTRACTS 2 AND 3 (2026-09-19, receipts sealed before 2026-09-21): an ordinary
 * award keeps a tenth of its stake. A Super award (boost 2, a doubled stake)
 * keeps HALF its stake: half a doubled stake is the spin entry, so a Super game
 * returns at least 1:1 of what the spin cost whatever happens.
 * Mirrors public.fn_diamond_bonus_minimum(p_bet, p_boost). Kept so every receipt
 * sealed under those contracts still verifies; no new round is priced by it. */
export function diamondBonusMinimum(betChips: number, boost: 1 | 2 = 1): number {
  const cents = Math.round(betChips * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(cents / 100 - betChips) > 1e-8)
    throw new Error('The Bonus Entry Could Not Be Verified');
  return boost === 2 ? Math.ceil(cents / 2) / 100 : Math.ceil(cents / 10) / 100;
}

/** The contract every round sealed since 2026-09-21 carries (owner rulings R3,
 * R10, R11): half the stake on a loss, or for a Super award what the player
 * paid; the first step of every game certain; Crash floored at 1.10x. */
export const BONUS_PAYOUT_VERSION = 4;

/** CONTRACT 4 (Dan, 2026-09-21, R10 and R11). An ordinary award keeps HALF its
 * stake on a loss ("0.10 to 0.50"). A Super award keeps the greater of half its
 * stake and what the player actually PAID, spin entry plus the Double Diamonds
 * add-on, at the bridge rate: without the add-on that is the entry, unchanged
 * (25 chips on a 2,500 spin); with it, 50 chips on 2,500 + 2,500, two thirds of
 * the 7,500 stake. Whole cents rounded UP, never in the house's favour, and
 * never at or above 0.80 of the stake: the clamp a cent under 0.80B never binds
 * for any reachable stake (the law test walks every one), but a floor that
 * reached the edge would be a game with no edge, so it is refused here too.
 * Mirrors public.fn_diamond_bonus_floor(p_bet, p_boost, p_paid_diamonds, p_rate). */
export function diamondBonusFloor(
  betChips: number,
  boost: 1 | 2,
  paidDiamonds: number,
  diamondsPerChip: number
): number {
  const cents = Math.round(betChips * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(cents / 100 - betChips) > 1e-8)
    throw new Error('The Bonus Entry Could Not Be Verified');
  if (
    !Number.isSafeInteger(paidDiamonds) ||
    paidDiamonds < 0 ||
    !Number.isSafeInteger(diamondsPerChip) ||
    diamondsPerChip <= 0
  )
    throw new Error('The Bonus Entry Could Not Be Verified');
  const half = Math.ceil(cents / 2);
  const paid = Math.ceil((paidDiamonds * 100) / diamondsPerChip);
  const floorCents = boost === 2 ? Math.max(half, paid) : half;
  const edge = Math.ceil(cents * 0.8) - 1;
  return Math.min(floorCents, edge) / 100;
}

/** The two tables the stake kind chose before 2026-09-21: Diamond (5) for an
 * ordinary award, Super (4) for a Super award. Mirrors
 * public.fn_plinko_table_version(p_boost). A receipt sealed under contract 3 or
 * earlier names its table this way; a contract-4 receipt names the table its
 * FLOOR chose (plinkoTableForFloor). */
export function plinkoTableVersion(boost: 1 | 2 = 1): number {
  return boost === 2 ? 4 : 5;
}

/** Every Plinko table a receipt may name, slot for slot as installed. Sixteen
 * rows: slot k lands with probability C(16,k)/65536.
 *   4 Super:        20x, 20x, 15x, 7.5x, 1.75x, then 0.64x .. 0.52x. Lowest 0.52x.
 *   5 Diamond:      20x on three slots each side, 12x, 5x, then 0.60x .. 0.08x.
 *                   CLOSED 2026-09-21: no stake has a floor a 0.08x slot can carry.
 *                   Readable so its settled batches keep verifying.
 *   6 Super Double: 20x on the two outer slots each side, 10x, 1.7x, then
 *                   0.80x, 0.75x, 0.75x, 0.73x, 0.72x. Lowest 0.72x, above the two
 *                   thirds a Super player with the add-on paid.
 * All three are exactly 0.800000 and top out at exactly 20x. The server's table
 * is the authority; this mirror lets a page paint the board before its quote
 * arrives and lets the test page play the same game offline. */
export const PLINKO_TABLES: Record<number, { name: string; multipliersCents: number[] }> = {
  4: {
    name: 'Super',
    multipliersCents: [
      2000, 2000, 1500, 750, 175, 64, 56, 53, 52, 53, 56, 64, 175, 750, 1500, 2000, 2000,
    ],
  },
  5: {
    name: 'Diamond',
    multipliersCents: [
      2000, 2000, 2000, 1200, 500, 60, 35, 15, 8, 15, 35, 60, 500, 1200, 2000, 2000, 2000,
    ],
  },
  6: {
    name: 'Super Double',
    multipliersCents: [
      2000, 2000, 1000, 170, 80, 75, 75, 73, 72, 73, 75, 75, 80, 170, 1000, 2000, 2000,
    ],
  },
};

/** The tables a new run may be dealt on, since 2026-09-21. Mirrors the
 * activated_at rows of public.plinko_tables after migration 20260921203512. */
export const PLINKO_LIVE_TABLES: readonly number[] = [4, 6];

/** The table follows the FLOOR, not the boost: the open table with the lowest
 * slot that still carries the floor on this stake, so the multipliers themselves
 * keep the guarantee and the floor adds nothing beyond cent rounding. Null when
 * no open table can carry it (a floor at or above 0.72 of the stake), which the
 * server refuses to start. Mirrors public.fn_plinko_table_for_floor. */
export function plinkoTableForFloor(betChips: number, floorChips: number): number | null {
  const betCents = Math.round(betChips * 100);
  const floorCents = Math.round(floorChips * 100);
  if (!Number.isSafeInteger(betCents) || betCents <= 0 || !Number.isSafeInteger(floorCents))
    return null;
  const candidates = PLINKO_LIVE_TABLES.map((version) => ({
    version,
    lowest: Math.min(...PLINKO_TABLES[version].multipliersCents),
  }))
    // lowest x bet / 100 >= floor, cleared of fractions.
    .filter((t) => t.lowest * betCents >= 100 * floorCents)
    .sort((a, b) => a.lowest - b.lowest || a.version - b.version);
  return candidates.length ? candidates[0].version : null;
}

/** THE DROP VALUE IS THE PLAYER'S AGAIN (Dan, 2026-09-21, R6). A listed value
 * in diamonds that uses every diamond of the stake, one to a hundred drops; and
 * the whole stake as a single drop is always open, so an entry no listed value
 * divides into a hundred drops or fewer (2,489 diamonds, say) still has a game.
 * Mirrors the refusal in public.fn_plinko_bonus_run after 20260921203512. */
export const PLINKO_DENOMINATIONS: readonly number[] = [1, 2, 4, 5, 10, 20, 25, 50, 100, 250, 500];
export const PLINKO_MIN_DROPS = 1;
export const PLINKO_MAX_DROPS = 100;

/** Every drop value this stake may play, with the drop count it makes. */
export function plinkoDropChoices(
  totalDiamonds: number
): { denomination: number; drops: number }[] {
  if (!Number.isSafeInteger(totalDiamonds) || totalDiamonds <= 0) return [];
  const values = PLINKO_DENOMINATIONS.includes(totalDiamonds)
    ? PLINKO_DENOMINATIONS
    : [...PLINKO_DENOMINATIONS, totalDiamonds];
  return values
    .filter(
      (d) =>
        totalDiamonds % d === 0 &&
        totalDiamonds / d >= PLINKO_MIN_DROPS &&
        totalDiamonds / d <= PLINKO_MAX_DROPS
    )
    .sort((a, b) => a - b)
    .map((denomination) => ({ denomination, drops: totalDiamonds / denomination }));
}

/** True when this stake may play this drop value: the server's exact rule. */
export function validPlinkoDenomination(totalDiamonds: number, denomination: number): boolean {
  return plinkoDropChoices(totalDiamonds).some((c) => c.denomination === denomination);
}

/** What the player paid for a receipt's stake: the spin entry plus the add-on
 * when a wheel award funded the base, the whole stake when nothing did. */
export function receiptPaidDiamonds(value: Record<string, unknown>): number | null {
  if (typeof value.paid_diamonds === 'number') return value.paid_diamonds;
  const bonus = value.bonus as Record<string, unknown> | undefined;
  if (bonus && typeof bonus.entry_diamonds === 'number' && typeof bonus.added_diamonds === 'number')
    return bonus.entry_diamonds + bonus.added_diamonds;
  return typeof value.bet_diamonds === 'number' ? value.bet_diamonds : null;
}

/** Old settled and open rounds retain their original contract. Version 1 is no
 * floor, 2 the tenth, 3 the Super half, 4 the paid floor (half the stake, or for
 * a Super award what the player paid). Every version is recomputed from the
 * rule rather than trusted, so a receipt whose floor was shaved is refused where
 * a player can see it. */
export function validBonusMinimum(value: Record<string, unknown>): boolean {
  const floor = value.minimum_payout_chips;
  const version = value.payout_version;
  if (floor === undefined && version === undefined) return true;
  if (version === 1) return floor === 0;
  if (typeof floor !== 'number') return false;
  if (version === 2 || version === 3) {
    if (typeof value.bet_chips !== 'number') return false;
    try {
      return floor === diamondBonusMinimum(value.bet_chips, version === 3 ? 2 : 1);
    } catch {
      return false;
    }
  }
  if (version !== BONUS_PAYOUT_VERSION) return false;
  const rate = value.diamonds_per_chip;
  const betChips =
    typeof value.bet_chips === 'number'
      ? value.bet_chips
      : typeof value.bet_diamonds === 'number' && typeof rate === 'number'
        ? value.bet_diamonds / rate
        : null;
  const paid = receiptPaidDiamonds(value);
  const bonus = value.bonus as Record<string, unknown> | undefined;
  const boost = bonus?.boost_multiplier === 2 ? 2 : 1;
  if (betChips === null || paid === null || typeof rate !== 'number') return false;
  try {
    return floor === diamondBonusFloor(betChips, boost, paid, rate);
  } catch {
    return false;
  }
}
