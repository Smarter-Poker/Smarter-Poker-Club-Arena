/** The guaranteed minimum uses the full funded entry, including Double Down. */
export function diamondBonusMinimum(betChips: number): number {
  const cents = Math.round(betChips * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(cents / 100 - betChips) > 1e-8)
    throw new Error('The Bonus Entry Could Not Be Verified');
  return Math.ceil(cents / 10) / 100;
}

/** Old settled and open rounds retain their original zero-minimum contract. */
export function validBonusMinimum(value: Record<string, unknown>): boolean {
  const floor = value.minimum_payout_chips;
  const version = value.payout_version;
  if (floor === undefined && version === undefined) return true;
  if (version === 1) return floor === 0;
  if (version !== 2 || typeof floor !== 'number' || typeof value.bet_chips !== 'number')
    return false;
  try {
    return floor === diamondBonusMinimum(value.bet_chips);
  } catch {
    return false;
  }
}
