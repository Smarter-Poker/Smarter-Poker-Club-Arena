/** The existing database creation/final-field contract accepts these depths.
 * This is new-event configuration, never authority to reprice a booked event. */
export const MTT_PAYOUT_DEPTH_CHOICES = [
  { value: 'payout1', percent: 10, label: 'Top 10% Of Field' },
  { value: 'payout3', percent: 15, label: 'Top 15% Of Field (Standard)' },
  { value: 'payout20', percent: 20, label: 'Top 20% Of Field' },
] as const;

export const MTT_PAYOUT_DEPTH_REQUIRED = 'Choose A Supported MTT Payout Depth (10%, 15% Or 20%)';

export function isSupportedMttPayoutDepth(value: unknown): value is 10 | 15 | 20 {
  return MTT_PAYOUT_DEPTH_CHOICES.some((item) => item.percent === value);
}

/** Legacy payout2 means 12.5%, not 15%. Never silently reinterpret that draft. */
export function mttPayoutDepthForChoice(choice: unknown): 10 | 15 | 20 | null {
  return MTT_PAYOUT_DEPTH_CHOICES.find((item) => item.value === choice)?.percent ?? null;
}

/** A new MTT has no final field yet. Capacity must never become a prize
 * promise or allocate one row per hypothetical paid entrant. The database
 * finalizes the real ladder from funded entries and the persisted paid depth.
 * A fresh array prevents a form edit from mutating another creation request. */
export function provisionalMttPayoutStructure(): { place: number; percentage: number }[] {
  return [{ place: 1, percentage: 100 }];
}
