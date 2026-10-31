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

/** Remember the exact lobby that initiated this entry, including delayed seating. */
export function rememberTournamentLobby(
  userId: string,
  tournamentId: string,
  tabId?: string | null
): void {
  try {
    const key = `${tournamentEntryNavigationKey(userId, tournamentId)}:lobby`;
    if (tabId) sessionStorage.setItem(key, tabId);
    else sessionStorage.removeItem(key);
  } catch {
    /* Admission remains available without storage. */
  }
}

export function tournamentSeatNavigationOptions(userId: string, tournamentId: string) {
  let lobbyTabId: string | null = null;
  try {
    lobbyTabId = sessionStorage.getItem(
      `${tournamentEntryNavigationKey(userId, tournamentId)}:lobby`
    );
  } catch {
    /* No originating lobby survives. */
  }
  return { state: { tournamentSeat: { tournamentId, lobbyTabId } } };
}
