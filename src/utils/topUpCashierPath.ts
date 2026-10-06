/**
 * Where "Top Up" sends a player who does not have enough chips to buy in.
 *
 * The club's Trade cashier (`/clubs/:clubId/cashier`) is the cashier's front
 * door and the place a chip request is made. The classic cashier reached by
 * `/cashier?club=...` opens a plain player on a Buy-In tab that needs a table
 * and can only say "No table selected for buy-in".
 *
 * With no club known, `/cashier` (no club) resolves the player's club and
 * redirects to that club's Trade cashier, or shows the no-club state.
 */
export function topUpCashierPath(clubId: string | null | undefined): string {
  const club = typeof clubId === 'string' ? clubId.trim() : '';
  return club ? `/clubs/${encodeURIComponent(club)}/cashier` : '/cashier';
}
