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
