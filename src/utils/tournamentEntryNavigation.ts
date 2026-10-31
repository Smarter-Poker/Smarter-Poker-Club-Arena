/** Shared receipt for completing the player's initial tournament entry. */
export function tournamentEntryNavigationKey(userId: string, tournamentId: string): string {
  return `ca_tourney_entered:${userId}:${tournamentId}`;
}

export function markTournamentEntered(userId: string, tournamentId: string): void {
  try {
    sessionStorage.setItem(tournamentEntryNavigationKey(userId, tournamentId), '1');
  } catch {
    // Navigation still proceeds when browser storage is unavailable.
  }
}
