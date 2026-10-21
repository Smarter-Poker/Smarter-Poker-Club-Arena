/** Owner policy, 2026-10-21. BBJ remains on the independently published stake spec. */
export const MIDWAY_UNION_ID = 'fade0000-0000-0000-0000-000000000001';
export const DEFAULT_CASH_RAKE_CAP_BB = 2.5;
export type CashRakeScope = 'midway' | 'standalone' | 'standard';

export function cashRakeScope(
  tableUnionId?: string | null,
  clubUnionId?: string | null
): CashRakeScope {
  if (tableUnionId === MIDWAY_UNION_ID || clubUnionId === MIDWAY_UNION_ID) return 'midway';
  // Only a successfully read, explicitly standalone club may set its own price.
  if (tableUnionId == null && clubUnionId === null) return 'standalone';
  return 'standard';
}

export function scopedCashRake(
  bigBlind: number,
  scope: CashRakeScope,
  percent?: number | null,
  capBB?: number | null
): { rakePercent: number; rakeCap: number } {
  const set = (v: number | null | undefined): v is number =>
    v != null && Number.isFinite(Number(v)) && Number(v) >= 0;
  const custom = scope === 'standalone';
  const rate = set(percent) ? Number(percent) : 10;
  const cap = set(capBB) ? Number(capBB) : DEFAULT_CASH_RAKE_CAP_BB;
  const boundedCap = custom ? cap : Math.min(cap, DEFAULT_CASH_RAKE_CAP_BB);
  return {
    rakePercent: Math.min(rate, custom ? 100 : 10),
    // A cent that rounds up must never take a Midway pot above 2.5 BB.
    rakeCap: Math.floor(Math.max(0, bigBlind) * boundedCap * 100 + 1e-8) / 100,
  };
}
