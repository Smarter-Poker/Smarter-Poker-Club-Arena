import { parseJsonCached } from '../utils/parseJsonCached';

export interface PayoutPlace {
  place: number;
  percentage: number;
}

function numericJsonScalar(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return Number.NaN;
  if (typeof value === 'string' && value.trim() === '') return Number.NaN;
  return Number(value);
}

/**
 * Parse the one persisted payout-ladder shape the engine and database settle.
 *
 * The stored contract is an array of explicit, positive integer places with a
 * positive finite percentage. The first row for a duplicate place wins, which
 * matches the database authority and computePlacePrize. Any malformed row
 * invalidates the whole structure so the UI cannot advertise a ladder that the
 * settlement transaction will reject.
 */
export function parsePayoutStructure(raw: unknown): PayoutPlace[] | null {
  let value = raw;
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    value = parseJsonCached(value);
  }
  if (!Array.isArray(value) || value.length === 0) return null;

  const places: PayoutPlace[] = [];
  const seen = new Set<number>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    const place = numericJsonScalar(row.place);
    const percentage = numericJsonScalar(row.percentage);
    const basisPoints = Math.round(percentage * 100);
    if (!Number.isInteger(place) || place < 1 || place > 2_147_483_647) return null;
    if (
      !Number.isFinite(percentage) ||
      percentage <= 0 ||
      !Number.isSafeInteger(basisPoints) ||
      basisPoints <= 0
    ) {
      return null;
    }
    if (seen.has(place)) continue;
    seen.add(place);
    places.push({ place, percentage });
  }

  if (!seen.has(1)) return null;
  places.sort((a, b) => a.place - b.place);
  return places;
}
