/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER ROSTER — every member the server showed you, and how to find them
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04, verbatim: "IM NOT SEARCHABLE WHEN YOU ARE IN THE CASHIER,
 * EVERY PERSON WHO IS IN THE CLUB SHOULD BE SEARCHABLE, IF THEY DON'T HAVE A
 * WALLET, LIKE (ADMINS) YOU CAN'T SEND THEM ANYTHING, BUT ALL USERS SHOULD
 * STILL BE SEARCHABLE AND DISCOVERABLE ACCORDING TO YOUR ROLE ACCESS."
 *
 * WHO YOU MAY SEE is decided by the database (fn_club_cashier_members via
 * fn_club_cashier_scope: staff see the club, agents see their downline, a
 * player sees nobody). WHO YOU MAY SEND TO is decided by the database too
 * (fn_agent_wallet_send: not yourself, and only active members in your
 * scope). This module does neither. It maps what the server returned, drops
 * nothing, and answers a search with every field the row prints. The one
 * client-side fact it adds is `isSelf`, because the row that is you is the
 * row that cannot be a recipient.
 *
 * Pure on purpose - no React, no Supabase - so the rule is testable.
 */

export interface DownlineRow {
  userId: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  role: string;
  chipBalance: number;
  isHorse: boolean;
  /**
   * How many club_members.agent_id hops below the viewer this member sits, as
   * computed by fn_club_cashier_members. 1 is a direct assignee; 0 means the
   * recursion never reached them, which only happens for staff (scope 'all').
   */
  depth: number;
  /** true when this player is assigned DIRECTLY to the person looking. */
  isMine: boolean;
  playerNumber: string | null;
  /**
   * The person looking. EVERY member is discoverable (Dan 2026-09-04: "every
   * person who is in the club should be searchable ... all users should still
   * be searchable and discoverable according to your role access"); the one
   * thing a viewer cannot do is send chips to themselves, which the server
   * refuses ("You Cannot Send Chips To Yourself"). So the row is listed and
   * found, and it is the row that cannot be selected - not a row that was
   * deleted before the search ever saw it.
   */
  isSelf: boolean;
}

export interface CashierRosterRpcRow extends Record<string, unknown> {
  user_id: string;
  role_rank: number;
}

/**
 * Every row the RPC returned, in order. Nothing is dropped here: the roster
 * used to delete the viewer's own row on arrival, and an owner searching for
 * himself ("KING" for KingFish) found only the horses whose handles matched.
 * The server already decides who a viewer may see (fn_club_cashier_scope), so
 * the client's job is to show all of it and mark what cannot be sent to.
 */
export const mapCashierRoster = (rows: CashierRosterRpcRow[], viewerId: string): DownlineRow[] =>
  rows.map((row) => {
    const depth = Number(row.depth) || 0;
    const userId = String(row.user_id);
    return {
      userId,
      isSelf: userId === viewerId,
      name: (row.name as string) || 'Player',
      username: (row.username as string) || '',
      avatarUrl: (row.avatar_url as string) || null,
      role: (row.role as string) || 'player',
      chipBalance: Number(row.chip_balance) || 0,
      isHorse: row.is_horse === true,
      depth,
      isMine: depth === 1,
      playerNumber: (row.player_number as string) || null,
    };
  });

/**
 * The search predicate, exported so a test can hold it to the rule. Matches
 * the arena name, the @handle and the member ID printed on the row - a member
 * must be findable by anything the row shows about them. Plain substring, so
 * what matches is never a surprise.
 */
export const rosterRowMatches = (row: DownlineRow, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    row.username.toLowerCase().includes(q) ||
    (row.playerNumber || '').toLowerCase().includes(q)
  );
};
