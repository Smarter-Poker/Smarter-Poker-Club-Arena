/** Pure arena contract shared by the browser and engine. No network or wallet access. */
export type ArenaIdentity =
  | { id: string; kind: 'chip_club'; asset: 'chips' }
  | { id: string; kind: 'chip_union'; asset: 'chips' }
  | { id: string; kind: 'diamond_arena'; asset: 'diamonds' };

export interface ArenaAccessContext {
  arena: ArenaIdentity;
  member: boolean;
  automaticMembership: boolean;
  role: string | null;
  capabilities: {
    join: boolean;
    hierarchy: boolean;
    chipWallet: boolean;
    diamondTransfers: boolean;
  };
}

/** Unknown values are errors, never implicit chip clubs. */
export function parseArenaIdentity(value: unknown): ArenaIdentity {
  if (!value || typeof value !== 'object') throw new Error('Missing Arena Identity');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) throw new Error('Missing Arena Id');
  if (row.asset === 'diamonds' && row.is_platform === true && row.union_id === null)
    return { id: row.id, kind: 'diamond_arena', asset: 'diamonds' };
  if (row.asset === 'chips' && row.is_platform === false)
    return { id: row.id, kind: 'chip_club', asset: 'chips' };
  throw new Error('Invalid Arena Asset Or Structure');
}

export function assertChipFundingArena(arena: ArenaIdentity): void {
  if (arena.asset !== 'chips') throw new Error('Diamond Funding Cannot Use Chip Wallets');
}

/** Union-only tables are an explicit chip scope, not a missing-asset fallback. */
export function parseTableArenaIdentity(table: {
  club_id?: unknown;
  union_id?: unknown;
  arena?: unknown;
}): ArenaIdentity {
  if (
    table.club_id == null &&
    typeof table.union_id === 'string' &&
    table.union_id &&
    table.arena == null
  )
    return { id: table.union_id, kind: 'chip_union', asset: 'chips' };
  const arena = parseArenaIdentity(table.arena);
  if (arena.id !== table.club_id) throw new Error('Arena Identity Mismatch');
  if (arena.asset === 'diamonds' && table.union_id != null)
    throw new Error('Diamond Games Cannot Belong To A Union');
  return arena;
}
