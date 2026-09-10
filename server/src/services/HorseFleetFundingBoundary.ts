import { parseTableArenaIdentity } from '../domain/ArenaContext.js';

/** Treasury-funded fleet seats belong only to authoritative chip arenas. */
export function isChipFleetTable(table: {
  club_id?: unknown;
  union_id?: unknown;
  arena?: unknown;
}): boolean {
  try {
    return parseTableArenaIdentity(table).asset === 'chips';
  } catch {
    return false;
  }
}
