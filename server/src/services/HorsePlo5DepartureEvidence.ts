/** Aggregate evidence from actual 2/5 PLO5 Horse departure decisions.
 * No identities, financial amounts or individual event times are retained.
 * The caller owns the decision; this recorder never initiates or retries it.
 */
export type HorsePlo5DepartureReason =
  | 'below_profit_floor'
  | 'in_hand'
  | 'unknown_investment'
  | 'eligible'
  | 'unverified_roster';

const counts: Record<HorsePlo5DepartureReason, number> = {
  below_profit_floor: 0,
  in_hand: 0,
  unknown_investment: 0,
  eligible: 0,
  unverified_roster: 0,
};

export function recordHorsePlo5Departure(reason: HorsePlo5DepartureReason): void {
  if (!Object.prototype.hasOwnProperty.call(counts, reason)) return;
  counts[reason] = Math.min(Number.MAX_SAFE_INTEGER, counts[reason] + 1);
}

export function horsePlo5DepartureEvidence() {
  return Object.freeze({
    profitBuyIns: 3.5,
    requiredStackBuyIns: 4.5,
    minimumBuyIn: 500,
    counts: Object.freeze({ ...counts }),
  });
}
