/**
 * A diamond ledger row's balance_after, as read: a finite number, or null when
 * the row recorded none. A missing value is UNKNOWN and is never coerced to 0
 * (CLAUDE.md 10.86): three production rows carry no balance_after, and the VIP
 * page used to print "Diamond Balance 0" under each of them.
 */
export function readBalanceAfter(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
