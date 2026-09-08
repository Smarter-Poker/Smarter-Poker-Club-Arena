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
  tournament_type?: unknown;
  variant?: unknown;
  max_players?: unknown;
}

/**
 * Normalize the two format columns that coexist in historical data.
 *
 * Either SPIN marker wins. SNG markers and two-seat tournaments are Sit & Go;
 * the latter covers old heads-up rows whose type was left as MTT. Every other
 * tournament is the MTT lane, including multi-table satellites.
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
  const maxPlayers = Number(row.max_players);

  if (tournamentType === 'SPIN' || variant === 'spin') return 'spin';
  if (
    tournamentType === 'SNG' ||
    variant === 'sng' ||
    (Number.isFinite(maxPlayers) && maxPlayers > 0 && maxPlayers <= 2)
  ) {
    return 'sng';
  }
  return 'mtt';
}
