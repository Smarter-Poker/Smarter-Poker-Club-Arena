/** The database join timestamp is kept verbatim, including sub-millisecond precision. */
export interface HandSeatGeneration {
  seat_id: string;
  seat_joined_at: string;
}

export function captureHandSeatGenerations(
  players: ReadonlyArray<{ user_id: string; seat_id?: string; seat_joined_at?: string }>
): Map<string, HandSeatGeneration> {
  const result = new Map<string, HandSeatGeneration>();
  for (const player of players) {
    if (
      !player.user_id ||
      result.has(player.user_id) ||
      typeof player.seat_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player.seat_id) ||
      typeof player.seat_joined_at !== 'string' ||
      !Number.isFinite(Date.parse(player.seat_joined_at))
    ) {
      throw new Error('hand deal refused (invalid_seat_generation)');
    }
    result.set(
      player.user_id,
      Object.freeze({
        seat_id: player.seat_id,
        seat_joined_at: player.seat_joined_at,
      })
    );
  }
  return result;
}

export function requireHandSeatGeneration(
  generations: ReadonlyMap<string, HandSeatGeneration>,
  userId: string
): HandSeatGeneration {
  const generation = generations.get(userId);
  if (!generation) throw new Error('atomic hand commit refused (missing_dealt_seat_generation)');
  return generation;
}
