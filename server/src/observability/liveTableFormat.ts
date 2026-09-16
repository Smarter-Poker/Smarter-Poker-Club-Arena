import { isUnlimitedMtt, type TournamentEntryCapacitySubject } from '../tournament/tournamentEntryCapacity.js';
/**
 * Public, non-sensitive format labels for per-table liveness.
 *
 * The health endpoint already publishes durable table ids and live progress.
 * This adds only the category needed to certify every product lane without
 * querying private tournament rows from the browser. Keep ownership tokens,
 * player identity, stakes, balances and cards out of this shape.
 */
export type PublicLiveTableFormat = 'cash' | 'mtt' | 'spin' | 'sng';

export interface PublicTournamentFormatRow extends TournamentEntryCapacitySubject {
  tournament_type?: unknown;
  variant?: unknown;
  max_players?: unknown;
}

/**
 * Normalize the two format columns that coexist in historical data.
 *
 * Explicit MTT/satellite type wins over historical numeric field caps. Fixed
 * Spin and SNG markers retain their lanes; physical table size is not a format.
 */
export function publicTournamentTableFormat(
  row: PublicTournamentFormatRow
): Exclude<PublicLiveTableFormat, 'cash'> {
  const tournamentType = String(row.tournament_type ?? '')
    .trim()
    .toUpperCase();
  const variant = String(row.variant ?? '')
    .trim()
    .toLowerCase();
  if (isUnlimitedMtt(row)) return 'mtt';

  if (tournamentType === 'SPIN' || variant === 'spin') return 'spin';
  if (
    tournamentType === 'SNG' ||
    variant === 'sng'
  ) {
    return 'sng';
  }
  return 'mtt';
}
