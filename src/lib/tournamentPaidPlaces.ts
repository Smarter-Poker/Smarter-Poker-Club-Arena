import { isSpinTournament, resolvePayoutStructure, type PayoutSubject } from './payoutStructure';

/** Actual finishing-place awards, never a registration-depth estimate or bounty count. */
export function tournamentPaidPlaces(
  row: PayoutSubject & { prize_pool_finalized?: boolean; satellite_target_id?: string | null }
): number | null {
  // Satellite entitlement depth is a separate immutable award contract. This
  // row's placeholder ladder cannot prove it.
  if (String(row.tournament_type ?? '').toUpperCase() === 'SATELLITE' || row.satellite_target_id)
    return null;
  if (!isSpinTournament(row) && row.prize_pool_finalized !== true) return null;
  const places = resolvePayoutStructure(row);
  // A gap is not permission to advertise unpaid finishing places. The strict
  // canonical parser already validates positive percentages and unique places.
  if (!places || places.some((entry, index) => entry.place !== index + 1)) return null;
  return places.length;
}
