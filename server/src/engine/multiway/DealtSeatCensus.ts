import type { SeatPlayer } from '../../types.js';

/** Shared variant-policy roster. Live callers provide the canonical census;
 * older offline fixtures may supply only their complete dealt player list.
 * A seat sitting out after the deal remains in the ring, while an explicitly
 * undealt spectator must not affect positions, rake or unknown-card counts.
 */
export function horsePolicyDealtPlayers(
  players: readonly SeatPlayer[],
  heroSeat: number,
  ids?: unknown
): SeatPlayer[] {
  const dealt = validateDealtSeatCensus(
    players,
    heroSeat,
    ids === undefined ? players.map((p) => p.seat) : ids
  );
  return players.filter((p) => dealt.includes(p.seat));
}

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
    ids.some(
      (id) => !Number.isSafeInteger(id) || id < 1 || id > 10 || !players.some((p) => p.seat === id)
    ) ||
    new Set(ids).size !== ids.length ||
    !ids.includes(heroSeat) ||
    players.some(
      (p) => ((!p.is_folded && !p.is_sitting_out) || p.is_all_in) && !ids.includes(p.seat)
    )
  )
    throw new Error('joint_cards_invalid_dealt_census');
  return [...ids].sort((a, b) => a - b);
}
