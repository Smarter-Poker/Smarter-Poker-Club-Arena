/**
 * Is this COMPLETING tournament actually finishing, or was it still being
 * played when its engine died?
 *
 * Extracted 2026-08-30 for the reason satelliteAwardPlan.ts was: the answer
 * decides whether a prize pool is paid out, and it used to live inside
 * recoverStuckCompletingTournaments — a function that needs several Supabase
 * round trips and a stuck tournament to reach, which is why it went wrong
 * unnoticed and expensively.
 *
 * THE INCIDENT. On 2026-08-30 the Sunday $200 Deep Stack was paid its entire
 * 20,880 pool to the top nine BY CHIP COUNT while it sat at level 7 of twelve
 * late-registration levels with ninety players still holding 2,730,654 chips.
 * Supabase went into RESIZING, the engine died mid-flight, the tournament was
 * left in COMPLETING, and the boot-time rescue settled it on the way back up.
 *
 * THE RULE. A tournament at its finish cannot have more players left than it
 * has places to pay. That is structural and needs no clock.
 *
 * WHY NOT A TIME-BASED TEST. "It dealt a hand recently" does not separate the
 * two cases: a tournament that crashes during finishTournament also dealt its
 * last hand seconds earlier, so any window short enough to catch a live event
 * would also block the legitimate rescue this path exists to perform. There is
 * no such overlap in the structural question.
 */

export interface RecoveryFieldInput {
  /** Players still `status = 'playing'` on the tournament. */
  livePlayers: number;
  /** Places the payout structure actually pays. */
  paidPlaces: number;
}

/**
 * True when the field is too large for this to be a finish, and the rescue
 * must NOT rank by chipstack and pay.
 *
 * Returns false when `paidPlaces` is 0 — an unresolved or empty payout
 * structure is a different failure, handled by the caller, and this guard must
 * not swallow it by refusing everything.
 */
export function fieldIsStillLive(input: RecoveryFieldInput): boolean {
  const livePlayers = Math.max(0, Math.floor(Number(input.livePlayers) || 0));
  const paidPlaces = Math.max(0, Math.floor(Number(input.paidPlaces) || 0));
  if (paidPlaces === 0) return false;
  return livePlayers > paidPlaces;
}
