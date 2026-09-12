import type { SeatPlayer } from '../../types.js';

/** Dealt identities are public; their card faces never enter this boundary.
 * Refuse incomplete or contradictory canonical censuses. */
export function validateDealtSeatCensus(
  players: readonly SeatPlayer[],
  heroSeat: number,
  ids: unknown
): number[] {
  if (
    !Array.isArray(ids) ||
    ids.length < 2 ||
    ids.length > 10 ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1 || !players.some((p) => p.seat === id)) ||
    new Set(ids).size !== ids.length ||
    !ids.includes(heroSeat) ||
    players.some(
      (p) => ((!p.is_folded && !p.is_sitting_out) || p.is_all_in) && !ids.includes(p.seat)
    )
  )
    throw new Error('joint_cards_invalid_dealt_census');
  return [...ids].sort((a, b) => a - b);
}
