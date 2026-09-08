/** Pure arena contract shared by the browser and engine. No network or wallet access. */
export type ArenaIdentity =
  | { id: string; kind: 'chip_club'; asset: 'chips' }
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
