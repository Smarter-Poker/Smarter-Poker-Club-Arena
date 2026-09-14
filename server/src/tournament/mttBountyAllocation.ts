/** The entry stays a whole-chip price; its bounty allocation is whole cents.
 * Percentage templates retain their percent-of-total convention. An explicit
 * amount wins, and neither form can take money reserved for the entry fee.
 * This prices new events only; it never recalculates a booked bounty. */
export function mttBountyAmount(
  split: { total: number; prize: number },
  config: { bountyAmount?: unknown; bountyPercent?: unknown }
): number {
  const hundredths = (value: unknown, label: string): number => {
    const n =
      typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
        ? Number(value)
        : NaN;
    const match = String(n).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) throw new Error(`Invalid ${label}: expected a nonnegative value to two decimals`);
    const units = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    if (!Number.isSafeInteger(units)) throw new Error(`Invalid ${label}: amount is too large`);
    return units;
  };
  const total = hundredths(split.total, 'entry total');
  const prize = hundredths(split.prize, 'entry contribution');
  if (prize > total) throw new Error('Bounty entry contribution exceeds its total');

  let cents: number;
  const absolute =
    config.bountyAmount == null ? 0 : hundredths(config.bountyAmount, 'bounty amount');
  if (absolute > 0) {
    cents = absolute;
  } else {
    const basisPoints = hundredths(config.bountyPercent ?? 30, 'bounty percentage');
    if (basisPoints <= 0 || basisPoints > 10000)
      throw new Error('Bounty percentage must be greater than zero and at most 100');
    // Integer half-up rounding occurs once, at the cent boundary. Dividing
    // currency first and then rounding to whole chips changes the promise.
    cents = Number((BigInt(total) * BigInt(basisPoints) + 5000n) / 10000n);
  }
  cents = Math.min(prize, cents);
  if (cents <= 0) throw new Error('Bounty event requires a positive funded bounty');
  return cents / 100;
}
