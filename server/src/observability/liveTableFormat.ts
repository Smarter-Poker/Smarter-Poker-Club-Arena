import { readPersistedTournamentFormatContract } from '../tournament/tournamentEntryCapacity.js';
/**
 * Public, non-sensitive format labels for per-table liveness.
 *
 * The health endpoint already publishes durable table ids and live progress.
 * This adds only the category needed to certify every product lane without
 * querying private tournament rows from the browser. Keep ownership tokens,
 * player identity, stakes, balances and cards out of this shape.
 */
export type PublicLiveTableFormat = 'cash' | 'mtt' | 'spin' | 'sng';

export interface PublicTournamentFormatRow {
  format_contract?: unknown;
  tournament_type?: unknown;
  variant?: unknown;
  max_players?: unknown;
}

/**
 * Report the recorded format, never infer purchased terms from obsolete labels
 * or a numeric field cap. Callers expose unknown observations as unknown.
 */
export function publicTournamentTableFormat(
  row: PublicTournamentFormatRow
): Exclude<PublicLiveTableFormat, 'cash'> {
  const format = readPersistedTournamentFormatContract(row);
  if (format === 'spin-v1') return 'spin';
  if (format === 'sng-v1' || format === 'seat-first-satellite-v1') return 'sng';
  return 'mtt';
}
