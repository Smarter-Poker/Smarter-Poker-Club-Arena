/** A selected pre-action and an optimistic click are not a completed fold. */
export function hasCommittedSeatFold(
  snapshot: Record<string, unknown> | null,
  tableId: string | null | undefined,
  handNumber: number | undefined,
  seatNumber: number,
  playerId: string | null | undefined
): boolean {
  if (
    !snapshot ||
    !tableId ||
    !playerId ||
    typeof handNumber !== 'number' ||
    handNumber <= 0 ||
    snapshot.table_id !== tableId ||
    snapshot.hand_number !== handNumber ||
    !Array.isArray(snapshot.players)
  )
    return false;
  return snapshot.players.some((row: unknown) => {
    if (!row || typeof row !== 'object') return false;
    const player = row as Record<string, unknown>;
    return player.user_id === playerId && player.seat === seatNumber && player.is_folded === true;
  });
}

/* ── A FOLD IS SHOWN WHEN THE ACTION REACHES THE SEAT (Dan 2026-10-24) ──────
   "IF THEY HIT THE FOLD BUTTON, DON'T REMOVE THEM UNTIL ITS THERE TURN TO
   FOLD." Since #7896 a Lightning fold is committed the moment it is pressed,
   even while another seat owes the decision, and the shared snapshot marks the
   seat folded at once. The snapshot carries no "early" flag, so the table
   remembers who was acting when each fold appeared: a fold made on the
   player's own turn shows at once; a fold made out of turn waits until the
   turn moves past that seat (the engine walks seats upward and wraps, see
   HandController.getNextActiveSeat), the street changes or the hand ends.
   A table that joins mid-hand has no history and shows existing folds. */
export interface FoldRevealTracker {
  tableId: string;
  handNumber: number;
  stage: string;
  actorSeat: number | null;
  folded: number[];
  pending: number[];
}

interface SnapshotView {
  tableId: string;
  handNumber: number;
  stage: string;
  actorSeat: number | null;
  folded: number[];
}

function readSnapshot(snapshot: Record<string, unknown> | null): SnapshotView | null {
  if (!snapshot || typeof snapshot.table_id !== 'string') return null;
  if (typeof snapshot.hand_number !== 'number' || snapshot.hand_number <= 0) return null;
  if (!Array.isArray(snapshot.players)) return null;
  const rows = snapshot.players.filter(
    (row): row is Record<string, unknown> => !!row && typeof row === 'object'
  );
  const actor = typeof snapshot.current_player === 'string' ? snapshot.current_player : null;
  const actorRow = actor ? rows.find((row) => row.user_id === actor) : undefined;
  return {
    tableId: snapshot.table_id,
    handNumber: snapshot.hand_number,
    stage: typeof snapshot.stage === 'string' ? snapshot.stage : '',
    actorSeat: typeof actorRow?.seat === 'number' ? actorRow.seat : null,
    folded: rows
      .filter((row) => row.is_folded === true && typeof row.seat === 'number')
      .map((row) => row.seat as number),
  };
}

/** Did the turn, moving upward with wrap from `from` to `to`, pass `seat`? */
export function turnPassedSeat(from: number | null, to: number | null, seat: number): boolean {
  if (from === null || to === null) return true;
  if (from === to) return false;
  return from < to ? seat > from && seat <= to : seat > from || seat <= to;
}

export function nextFoldReveal(
  prev: FoldRevealTracker | null,
  snapshot: Record<string, unknown> | null
): FoldRevealTracker | null {
  const now = readSnapshot(snapshot);
  if (!now) return prev;
  const sameHand = prev && prev.tableId === now.tableId && prev.handNumber === now.handNumber;
  if (!sameHand) return { ...now, pending: [] };
  const sameStreet = prev.stage === now.stage;
  const stillOwed = (seat: number) =>
    sameStreet && now.actorSeat !== null && !turnPassedSeat(prev.actorSeat, now.actorSeat, seat);
  const pending = prev.pending.filter((seat) => now.folded.includes(seat) && stillOwed(seat));
  for (const seat of now.folded) {
    if (prev.folded.includes(seat)) continue;
    if (prev.actorSeat !== seat && stillOwed(seat)) pending.push(seat);
  }
  return { ...now, pending };
}

export function foldRevealed(tracker: FoldRevealTracker | null, seat: number): boolean {
  return !tracker || !tracker.pending.includes(seat);
}
