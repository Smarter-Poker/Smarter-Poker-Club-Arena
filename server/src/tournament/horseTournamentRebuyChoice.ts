import { createHash } from 'node:crypto';

/** Share of eligible tournament busts on which a horse buys back in.
 *
 * Owner rule, 2026-10-29: horses rebuy on 70% of eligible busts before
 * the rebuy period ends. This supersedes the 75% share from 2026-10-24.
 */
export const HORSE_TOURNAMENT_REBUY_SHARE = 0.7;

/** Bind the draw to the accepted busting hand, not a sweep, clock or process.
 * A retry/restart must preserve a decline. A later bust gets a fresh draw.
 * This is only the input choice; the normal purchase transaction still owns
 * eligibility, caps, pricing, funding and duplicate-effect protection.
 */
export function horseChoosesTournamentRebuy(
  tournamentId: string,
  userId: string,
  bustHandNumber: number | null | undefined
): boolean {
  if (!Number.isSafeInteger(bustHandNumber) || Number(bustHandNumber) <= 0) return false;
  const draw = createHash('sha256')
    .update(JSON.stringify(['horse-tournament-rebuy-v1', tournamentId, userId, bustHandNumber]))
    .digest()
    .readUInt32BE(0);
  return draw / 0x1_0000_0000 < HORSE_TOURNAMENT_REBUY_SHARE;
}
