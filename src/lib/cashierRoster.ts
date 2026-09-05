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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEARCH RANKS BY HOW WELL IT MATCHED, NOT BY WHO HAS THE MOST CHIPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04, on being told he was "discoverable": "I AM NOT
 * DISCOVERABLE... WHY ARE YOU LYING TO ME?!" He was row 21 of 21. His row was
 * on the list - the previous fix put it there - but the list kept sorting by
 * chip balance while a search was active, and his Deep Stack balance is 0.00,
 * so twenty horses whose HANDLES contain "kingsley" sat above the one member
 * whose NAME is KingFish. Present is not discoverable.
 *
 * With a query on, the best match leads. Ties fall back to the chosen sort.
 * With no query, the chosen sort is the whole order, exactly as before.
 *
 * 0 means no match. Higher is better. The bands are wide apart on purpose,
 * so a name hit always outranks a handle hit, which always outranks an id hit.
 */
export function rosterMatchRank(row: DownlineRow, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = row.name.toLowerCase();
  const handle = row.username.toLowerCase();
  const id = (row.playerNumber || '').toLowerCase();

  let rank = 0;
  if (name === q) rank = 900;
  else if (name.startsWith(q)) rank = 800;
  else if (name.includes(q)) rank = 700;
  else if (handle === q) rank = 600;
  else if (handle.startsWith(q)) rank = 500;
  else if (handle.includes(q)) rank = 400;
  else if (id === q) rank = 300;
  else if (id.startsWith(q)) rank = 200;
  if (rank === 0) return 0;

  // The person searching for themselves is the most common search there is,
  // and their row is never a recipient, so it never gets in the way.
  if (row.isSelf) rank += 1000;
  return rank;
}
