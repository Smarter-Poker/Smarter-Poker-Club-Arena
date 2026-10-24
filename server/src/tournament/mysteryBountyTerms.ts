/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY TERMS: CHESTS ONLY, AT THE MONEY, 50/50 (Dan 2026-10-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL
 * BOUNTIES ARE MYSTERY BOUNTY PRIZES ONLY" and "CHANGE IT TO THE 50/50 HALF
 * PAYOUT, HALF BOUNTY POOL."
 *
 * Dan, 11:53 CT: "YOU ALSO NEED TO ACCOUNT FOR THE RAKE, SO RAKE COMES OUT OF
 * THE TOP 12.5% PAYOUT, 50% GOES INTO THE BOUNTY POOL. MYSTERY BOUNTIES ARE
 * ALWAYS FULL CHIP AMOUNTS, NEVER FRACTIONS."
 *
 * Every paid mystery MTT the spawner writes leaves here with:
 *   - half of the WHOLE entry (buy-in plus fee) as the bounty, in whole chips;
 *     the fee comes out of the prize-pool half; the advertised mystery range
 *     scales with it;
 *   - 100% of the bounty pool sealed into chests and nothing in a "regular"
 *     half, so no knockout pays before the chests open;
 *   - the chests opening at the money;
 *   - a description that says exactly that.
 *
 * The database writes the same terms on every creation path (trigger
 * a4_mystery_mtt_terms, migrations 20261022162651 and 20261022170421), so the spawner and every
 * other door agree. Pure; returns a new row and never mutates its input.
 */

/** Mystery chests and bounties are whole chips (or whole Diamonds): 100 cents. */
export const MYSTERY_WHOLE_UNIT_CENTS = 100;

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * The description every chests-only mystery event carries. `entryTotal` is the
 * whole entry (buy-in plus fee); the database trigger writes the same words.
 */
export function mysteryBountyDescription(bountyAmount: number, entryTotal: number): string {
  const bountyPct =
    entryTotal > 0 && bountyAmount > 0 ? Math.round((bountyAmount * 100) / entryTotal) : 50;
  return (
    `${bountyPct}% Of Each Entry Funds The Mystery Bounty Pool. The Prize Pool Is The Rest, ` +
    'After The Fee. No Bounties Are Paid Before The Money. Once The Tournament Reaches The ' +
    'Money, Every Knockout Picks 1 Of 3 Mystery Chests.'
  );
}

/** Is this row a paid, pre-start mystery MTT the terms apply to? */
export function isPaidMysteryMttRow(row: Record<string, unknown>): boolean {
  if (row.is_mystery_bounty !== true || row.is_pko === true) return false;
  if (String(row.tournament_type ?? 'MTT').toUpperCase() !== 'MTT') return false;
  if (String(row.variant ?? '').toLowerCase() === 'satellite') return false;
  if (row.satellite_target_id != null && row.satellite_target_id !== '') return false;
  return num(row.buy_in_amount) + num(row.buy_in_fee) > 0;
}

/**
 * Half of the whole entry (buy-in plus fee), floored to a whole chip, and never
 * more than the buy-in after the fee: the fee comes out of the prize-pool half.
 */
export function halfEntryBounty(buyInAmount: number, buyInFee: number): number {
  const totalCents = Math.round((buyInAmount + buyInFee) * 100);
  const half = Math.floor(totalCents / 2 / MYSTERY_WHOLE_UNIT_CENTS) * MYSTERY_WHOLE_UNIT_CENTS;
  return Math.min(half, Math.round(buyInAmount * 100)) / 100;
}

export function withMysteryBountyTerms(row: Record<string, unknown>): Record<string, unknown> {
  if (!isPaidMysteryMttRow(row)) return row;
  const buyIn = num(row.buy_in_amount);
  const fee = num(row.buy_in_fee);
  const half = halfEntryBounty(buyIn, fee);
  const oldBounty = num(row.bounty_amount);
  const bounty = half > 0 ? half : oldBounty;
  const scale = oldBounty > 0 && bounty > 0 ? bounty / oldBounty : 1;
  // The advertised range is whole chips too (Dan: never fractions).
  const whole = (v: unknown) => Math.max(1, Math.round(num(v) * scale));
  return {
    ...row,
    bounty_amount: bounty,
    mystery_bounty_min: scale === 1 ? row.mystery_bounty_min : whole(row.mystery_bounty_min),
    mystery_bounty_max: scale === 1 ? row.mystery_bounty_max : whole(row.mystery_bounty_max),
    mystery_bounty_pool_percent: 100,
    mystery_bounty_regular_pool_percent: 0,
    mystery_bounty_activation: 'at_the_money',
    mystery_bounty_activation_value: null,
    short_description: mysteryBountyDescription(bounty, buyIn + fee),
  };
}
