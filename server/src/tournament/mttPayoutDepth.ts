/** MTT paid depth: the share of the final field that finishes in the money.
 *
 * Dan, 2026-10-21: "ALL MTT TOURNAMENTS MUST PAY OUT THE TOP 12.5% OF THE
 * FIELD. ANYTHING LESS IS WRONG ... STAND ALONE CLUBS CAN SET IT TO WHAT EVER
 * THEY WANT, BUT THE DEFAULT SHOULD BE 12.5%".
 *
 * The database is the authority (tournaments.payout_depth_percent, trigger
 * ca_mtt_payout_depth_guard, migration 20261022014607): every Midway, union
 * and Diamond Arena MTT pays 12.5 whatever a client sends; a standalone club's
 * choice is honoured, 12.5 when it sends none. These choices are what a
 * creator form offers; they are never authority to reprice a booked event. */
export const MTT_DEFAULT_PAYOUT_DEPTH = 12.5;

export const MTT_PAYOUT_DEPTH_CHOICES = [
  { value: 'payout2', percent: 12.5, label: 'Top 12.5% Of Field (Standard)' },
  { value: 'payout1', percent: 10, label: 'Top 10% Of Field' },
  { value: 'payout3', percent: 15, label: 'Top 15% Of Field' },
  { value: 'payout20', percent: 20, label: 'Top 20% Of Field' },
] as const;

export type MttPayoutDepth = (typeof MTT_PAYOUT_DEPTH_CHOICES)[number]['percent'];

export const MTT_PAYOUT_DEPTH_REQUIRED =
  'Choose A Supported MTT Payout Depth (10%, 12.5%, 15% Or 20%)';

export function isSupportedMttPayoutDepth(value: unknown): value is MttPayoutDepth {
  return MTT_PAYOUT_DEPTH_CHOICES.some((item) => item.percent === value);
}

export function mttPayoutDepthForChoice(choice: unknown): MttPayoutDepth | null {
  return MTT_PAYOUT_DEPTH_CHOICES.find((item) => item.value === choice)?.percent ?? null;
}

/** The value for tournaments.payout_depth_percent: any percent in (0, 100],
 * rounded to cents, otherwise the 12.5 default. The database guard still
 * forces 12.5 for every union and Diamond Arena event. */
export function mttPayoutDepthColumn(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100) return MTT_DEFAULT_PAYOUT_DEPTH;
  return Math.round(n * 100) / 100;
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
