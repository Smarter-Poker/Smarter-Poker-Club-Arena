/** The guaranteed minimum uses the full funded entry, including Double Down.
 *
 * An ordinary award keeps a tenth of its stake. A Super award (boost 2, a
 * doubled stake) keeps HALF its stake: half a doubled stake is the spin entry,
 * so a Super game returns at least 1:1 of what the spin cost whatever happens.
 * Mirrors public.fn_diamond_bonus_minimum(p_bet, p_boost). */
export function diamondBonusMinimum(betChips: number, boost: 1 | 2 = 1): number {
  const cents = Math.round(betChips * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(cents / 100 - betChips) > 1e-8)
    throw new Error('The Bonus Entry Could Not Be Verified');
  return boost === 2 ? Math.ceil(cents / 2) / 100 : Math.ceil(cents / 10) / 100;
}

/** The two open Plinko tables: Diamond (5) for an ordinary award, Super (4) for a
 * Super award. Mirrors public.fn_plinko_table_version(p_boost). Nobody chooses a table. */
export function plinkoTableVersion(boost: 1 | 2 = 1): number {
  return boost === 2 ? 4 : 5;
}

/** The two open tables' slot multipliers in cents, as installed by the migration
 * that opened them. Sixteen rows: slot k lands with probability C(16,k)/65536.
 * Diamond: 20x on the three outer slots each side (1 drop in 239), 12x (1 in 59),
 * 5x (1 in 18), then 0.60x, 0.35x, 0.15x and 0.08x. Super: every slot at least
 * 0.52x, above the 0.50x that is the spin entry on a doubled stake. Both are
 * exactly 0.800000 and top out at exactly 20x. The server's table is the
 * authority; this mirror lets a page paint the board before its quote arrives
 * and lets the test page play the same game offline. */
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
};

/** Old settled and open rounds retain their original zero-minimum contract.
 * Version 2 is the tenth, version 3 the Super half. */
export function validBonusMinimum(value: Record<string, unknown>): boolean {
  const floor = value.minimum_payout_chips;
  const version = value.payout_version;
  if (floor === undefined && version === undefined) return true;
  if (version === 1) return floor === 0;
  if (
    (version !== 2 && version !== 3) ||
    typeof floor !== 'number' ||
    typeof value.bet_chips !== 'number'
  )
    return false;
  try {
    return floor === diamondBonusMinimum(value.bet_chips, version === 3 ? 2 : 1);
  } catch {
    return false;
  }
}
