/** Older clients print this field directly. Keep their ordinary one-decimal
 * display, but never round a positive chance to zero or uncertainty to 100.
 * Updated consumers use equityRaw and its explicit exactness provenance. */
export function legacyAllInPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Invalid all-in percentage');
  }
  const rounded = Math.round(percent * 10) / 10;
  if (percent > 0 && rounded === 0) return Number(percent.toPrecision(2));
  if (percent < 100 && rounded === 100) return 99.9;
  return rounded;
}
