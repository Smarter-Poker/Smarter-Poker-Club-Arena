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
    snapshot.stage === 'waiting' ||
    !Array.isArray(snapshot.players)
  )
    return false;
  return snapshot.players.some((row: unknown) => {
    if (!row || typeof row !== 'object') return false;
    const player = row as Record<string, unknown>;
    return player.user_id === playerId && player.seat === seatNumber && player.is_folded === true;
  });
}
