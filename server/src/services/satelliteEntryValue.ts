import { BUY_IN_LADDER, splitBuyIn } from '../config/buyIn.js';

/** Scheduled feeders fund approximately one ticket per five to ten entries.
 * Keep an already economical configured value; otherwise use a whole-chip
 * ladder value near one ticket per eight entries, including the 10% fee.
 */
export function satelliteEntryValue(ticket: number, configured: number): number {
  if (!Number.isFinite(ticket) || ticket <= 0) throw new Error('Satellite Target Value Required');
  const economical = (entry: number) => {
    const prize = splitBuyIn(entry, 0.1).prize;
    return prize > 0 && ticket / prize >= 5 && ticket / prize <= 10;
  };
  if (Number.isInteger(configured) && economical(configured)) return configured;
  const candidates = BUY_IN_LADDER.filter(economical);
  if (!candidates.length) throw new Error('Satellite Target Has No Economical Entry Value');
  return candidates.reduce((best, value) =>
    Math.abs(ticket / splitBuyIn(value, 0.1).prize - 8) <
    Math.abs(ticket / splitBuyIn(best, 0.1).prize - 8)
      ? value
      : best
  );
}
