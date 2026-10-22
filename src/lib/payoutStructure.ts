import { parseJsonCached } from '../utils/parseJsonCached';
import { spinTier } from '../config/spinSpec';

export interface PayoutPlace {
  place: number;
  percentage: number;
}

export interface PayoutSubject {
  payout_structure?: unknown;
  variant?: string | null;
  tournament_type?: string | null;
  spin_multiplier?: number | null;
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

/** A Spin's persisted multiplier is its payout contract, not its stored placeholder. */
export function isSpinTournament(t: PayoutSubject | null | undefined): boolean {
  if (!t) return false;
  return (
    String(t.variant ?? '').toLowerCase() === 'spin' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SPIN'
  );
}

/** Resolve the canonical percentage ladder for a drawn Spin tier. */
export function spinPayoutStructure(multiplier: number | null | undefined): PayoutPlace[] | null {
  const tier = spinTier(Number(multiplier));
  if (!tier || !Array.isArray(tier.payouts) || tier.payouts.length === 0) return null;
  return tier.payouts.map((percentage, index) => ({
    place: index + 1,
    percentage: Math.round(percentage * 10_000) / 100,
  }));
}

/**
 * The exact payout ladder the settlement authority uses.
 *
 * Spin rows are created with a winner-take-all placeholder before the draw, so
 * a known multiplier must outrank that copy. An unknown Spin tier fails closed
 * instead of advertising the placeholder. Every other format keeps its stored
 * operator-authored structure.
 */
export function resolvePayoutStructure(
  tournament: PayoutSubject | null | undefined
): PayoutPlace[] | null {
  if (isSpinTournament(tournament)) {
    return spinPayoutStructure(tournament?.spin_multiplier);
  }
  return parsePayoutStructure(tournament?.payout_structure);
}

/**
 * THE LADDER A REGISTERING MTT WILL PAY (Dan, 2026-10-21: every MTT pays the
 * top 12.5% of the field; standalone clubs may choose another depth).
 *
 * Until registration closes, `payout_structure` holds a schedule template or a
 * provisional row, so a lobby that printed it told players "9 Paid Places" or
 * "Winner Takes All" for an event that will pay the top 12.5% of whoever
 * shows up. The database writes the real ladder at entry close with
 * `fn_ca_payout_structure(field, depth)`; this is the same arithmetic, so the
 * projection a player reads is the ladder they will be paid by if nobody else
 * registers:
 *   places = max(1, min(field, ceil(field * depth / 100)))
 *   weight(i) = 1 / i^0.8, normalised to 100, largest-remainder to the cent.
 * A mystery bounty of 1..10 total entries with at least 3 players pays
 * 50/30/20, exactly as entry close does.
 */
export function effectivePayoutDepth(subject: {
  payout_depth_percent?: number | string | null;
  payout_percent?: number | string | null;
}): number {
  const depth = Number(subject.payout_depth_percent);
  if (Number.isFinite(depth) && depth > 0 && depth <= 100) return depth;
  const legacy = Number(subject.payout_percent);
  if (Number.isFinite(legacy) && legacy > 0 && legacy <= 100) return legacy;
  return 12.5;
}

export function projectedFieldLadder(
  entrants: number,
  depthPercent: number,
  mysterySmallField = false
): PayoutPlace[] {
  const field = Math.floor(Number(entrants));
  if (!Number.isFinite(field) || field <= 0) return [];
  if (mysterySmallField && field >= 3) {
    return [
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ];
  }
  const pct = depthPercent > 0 && depthPercent <= 100 ? depthPercent : 12.5;
  const places = Math.max(1, Math.min(field, Math.ceil((field * pct) / 100 - 1e-9)));
  const weights = Array.from({ length: places }, (_, i) => 1 / Math.pow(i + 1, 0.8));
  const total = weights.reduce((a, b) => a + b, 0);
  const rows = weights.map((w, i) => {
    const exactCents = (100 * w * 100) / total;
    const flooredCents = Math.floor(exactCents + 1e-9);
    return { place: i + 1, cents: flooredCents, frac: exactCents - flooredCents };
  });
  let left = 10000 - rows.reduce((a, r) => a + r.cents, 0);
  [...rows]
    .sort((a, b) => b.frac - a.frac || a.place - b.place)
    .forEach((r) => {
      if (left > 0) {
        r.cents += 1;
        left -= 1;
      }
    });
  return rows.map((r) => ({ place: r.place, percentage: r.cents / 100 }));
}
