/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY TERMS: CHESTS ONLY, AT THE MONEY, 50/50 (Dan 2026-10-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL
 * BOUNTIES ARE MYSTERY BOUNTY PRIZES ONLY" and "CHANGE IT TO THE 50/50 HALF
 * PAYOUT, HALF BOUNTY POOL."
 *
 * Every paid mystery MTT the spawner writes leaves here with:
 *   - half its entry contribution as the bounty (a whole Diamond at the
 *     Diamond Arena), the advertised mystery range scaled with it;
 *   - 100% of the bounty pool sealed into chests and nothing in a "regular"
 *     half, so no knockout pays before the chests open;
 *   - the chests opening at the money;
 *   - a description that says exactly that.
 *
 * The database writes the same terms on every creation path (trigger
 * a4_mystery_mtt_terms, migration 20261022160327), so the spawner and every
 * other door agree. Pure; returns a new row and never mutates its input.
 */

import { DIAMOND_UNIT_CENTS } from './tournamentUnit.js';

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** The description every chests-only mystery event carries. */
export function mysteryBountyDescription(bountyAmount: number, buyInAmount: number): string {
  const bountyPct =
    buyInAmount > 0 && bountyAmount > 0 ? Math.round((bountyAmount * 100) / buyInAmount) : 50;
  return (
    `${100 - bountyPct}% Of Each Entry Funds The Prize Pool And ${bountyPct}% Funds The Mystery ` +
    'Bounty Pool. No Bounties Are Paid Before The Money. Once The Tournament Reaches The Money, ' +
    'Every Knockout Picks 1 Of 3 Mystery Chests.'
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
 * Half of the entry contribution, floored to the event's grid: a cent for a
 * chip event, a whole Diamond (100 cents) at the Diamond Arena.
 */
export function halfEntryBounty(buyInAmount: number, unitCents: number): number {
  const unit = unitCents > 0 ? Math.floor(unitCents) : 1;
  const cents = Math.round(buyInAmount * 100);
  return (Math.floor(cents / 2 / unit) * unit) / 100;
}

export function withMysteryBountyTerms(
  row: Record<string, unknown>,
  opts: { diamonds?: boolean } = {}
): Record<string, unknown> {
  if (!isPaidMysteryMttRow(row)) return row;
  const buyIn = num(row.buy_in_amount);
  const half = halfEntryBounty(buyIn, opts.diamonds ? DIAMOND_UNIT_CENTS : 1);
  const oldBounty = num(row.bounty_amount);
  const bounty = half > 0 ? half : oldBounty;
  const scale = oldBounty > 0 && bounty > 0 ? bounty / oldBounty : 1;
  const round2 = (v: unknown) => Math.round(num(v) * scale * 100) / 100;
  return {
    ...row,
    bounty_amount: bounty,
    mystery_bounty_min: scale === 1 ? row.mystery_bounty_min : round2(row.mystery_bounty_min),
    mystery_bounty_max: scale === 1 ? row.mystery_bounty_max : round2(row.mystery_bounty_max),
    mystery_bounty_pool_percent: 100,
    mystery_bounty_regular_pool_percent: 0,
    mystery_bounty_activation: 'at_the_money',
    mystery_bounty_activation_value: null,
    short_description: mysteryBountyDescription(bounty, buyIn),
  };
}
