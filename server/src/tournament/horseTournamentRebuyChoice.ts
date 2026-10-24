import { createHash } from 'node:crypto';

/** Share of eligible tournament busts on which a horse buys back in.
 *
 * Owner rule, 2026-10-24 (replaces 45% from 2026-10-22): "HORSES NEED TO BE
 * REBUYING 75% OF THE TIME IN ANY MTT'S IF THEY ARE ELIGIBLE TO." A field of
 * 276 entries showing 9 rebuys "LOOKS FAKE".
 */
export const HORSE_TOURNAMENT_REBUY_SHARE = 0.75;

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
