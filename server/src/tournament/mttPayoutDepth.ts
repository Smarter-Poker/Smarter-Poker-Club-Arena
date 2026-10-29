/** Owner October 29, 2026: all new MTTs pay the top 15% of the field.
 * The database guard enforces this on every creator, including saved schedules.
 * Existing finalized ladders and non-MTT prize contracts remain authoritative. */
export const MTT_DEFAULT_PAYOUT_DEPTH = 15;

export const MTT_PAYOUT_DEPTH_CHOICES = [
  { value: 'payout3', percent: 15, label: 'Top 15% Of Field (Standard)' },
] as const;

export type MttPayoutDepth = (typeof MTT_PAYOUT_DEPTH_CHOICES)[number]['percent'];

export const MTT_PAYOUT_DEPTH_REQUIRED = 'MTT Tournaments Pay The Top 15% Of The Field';

export function isSupportedMttPayoutDepth(value: unknown): value is MttPayoutDepth {
  return MTT_PAYOUT_DEPTH_CHOICES.some((item) => item.percent === value);
}

export function mttPayoutDepthForChoice(choice: unknown): MttPayoutDepth | null {
  return MTT_PAYOUT_DEPTH_CHOICES.find((item) => item.value === choice)?.percent ?? null;
}

/** New MTT creation cannot inherit an obsolete saved schedule depth. */
export function mttPayoutDepthColumn(_value: unknown): number {
  return MTT_DEFAULT_PAYOUT_DEPTH;
}

/** tournaments.payout_percent is the legacy smallint column (CHECK 10/15/20).
 * It is still written for readers that predate payout_depth_percent; any depth
 * it cannot hold is stored as 10 and the real depth lives in the new column. */
export function legacyPayoutPercentColumn(value: unknown): 10 | 15 | 20 {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (n === 15) return 15;
  if (n === 20) return 20;
  return 10;
}

/** A new MTT has no final field yet. Capacity must never become a prize
 * promise or allocate one row per hypothetical paid entrant. The database
 * finalizes the real ladder from funded entries and the persisted paid depth.
 * A fresh array prevents a form edit from mutating another creation request. */
export function provisionalMttPayoutStructure(): { place: number; percentage: number }[] {
  return [{ place: 1, percentage: 100 }];
}
