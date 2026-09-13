/** Decode an explicit whole-cent database amount without inventing a zero pool. */
export function readTournamentPrizePool(value: unknown): number | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !/^[0-9]+(?:[.][0-9]+)?$/.test(value))
  ) {
    return null;
  }
  const pool = Number(value);
  if (
    !Number.isFinite(pool) ||
    pool < 0 ||
    !Number.isSafeInteger(Math.round(pool * 100)) ||
    Math.round(pool * 100) / 100 !== pool
  ) {
    return null;
  }
  return pool;
}
