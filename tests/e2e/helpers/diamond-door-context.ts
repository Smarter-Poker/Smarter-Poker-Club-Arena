/** Strict read-only classification of the actual arena boundary response.
 * Unknown authority must never become a closed or enabled door verdict. */
import { parseArenaIdentity } from '../../../server/src/domain/ArenaContext';

export function parseDiamondDoorContext(value: unknown): {
  cashGamesEnabled: boolean;
  tournamentsEnabled: boolean;
} {
  const row = value as Record<string, unknown> | null;
  const arena = parseArenaIdentity(row?.arena);
  if (
    !row ||
    arena.kind !== 'diamond_arena' ||
    row.member !== true ||
    row.role !== 'player' ||
    typeof row.cashGamesEnabled !== 'boolean' ||
    typeof row.tournamentsEnabled !== 'boolean'
  )
    throw new Error('Invalid Diamond Door Context');
  return { cashGamesEnabled: row.cashGamesEnabled, tournamentsEnabled: row.tournamentsEnabled };
}

/** The owning lobby's existing RLS reads, not a synthetic holding state. */
export function parseLobbyHoldingIds(
  value: unknown,
  field: 'table_id' | 'tournament_id'
): Set<string> {
  if (!Array.isArray(value)) throw new Error('Invalid Lobby Holdings');
  return new Set(
    value.map((row) => {
      if (!row || typeof row !== 'object' || typeof row[field] !== 'string' || !row[field])
        throw new Error('Invalid Lobby Holding Id');
      return row[field];
    })
  );
}
