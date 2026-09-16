/** Pure arena contract shared by the browser and engine. No network or wallet access. */
export type ArenaIdentity =
  | { id: string; kind: 'chip_club'; asset: 'chips' }
  | { id: string; kind: 'chip_union'; asset: 'chips' }
  | { id: string; kind: 'diamond_arena'; asset: 'diamonds' };

export interface ArenaAccessContext {
  arena: ArenaIdentity;
  member: boolean;
  automaticMembership: boolean;
  cashGamesEnabled?: boolean;
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

/**
 * WHETHER A SEAT HAS A FUNDED TOP-UP WRITER BEHIND IT.
 *
 * Every chip seat does. `atomic_table_addon` debits `club_members.chip_balance`
 * and either applies to the seat or queues a durable row for the end of the
 * hand, and a chip tournament seat rebuys through its own door.
 *
 * A Diamond CASH seat does as of 2026-09-12: `fn_poker_diamond_top_up` reserves
 * settled Diamonds into the same custody row the seat is bound to and raises
 * `table_seats.stack` in the same transaction, which is the only shape the
 * deferred seat-keeps-custody constraint allows.
 *
 * A Diamond TOURNAMENT seat does NOT. Prize escrow is a later phase and the
 * custody door refuses a tournament table, so offering it a control that
 * cannot work is worse than not offering one.
 *
 * This lives in the shared contract rather than in the table page because
 * THREE controls ask exactly this question and they had drifted apart: the
 * seat's own Top Up button learned about Diamond cash on 2026-09-12, while the
 * multi-table tab bar's menu item and the automatic top-up both still refused
 * every non-chip asset. At a Diamond table the tab bar's item therefore did
 * nothing at all, and its Auto Top Up item toggled state that the automatic
 * top-up then ignored. One rule, read from one place, cannot drift again.
 *
 * Auto top-up asks a NARROWER question and composes it from this one: a cash
 * game with a funded writer, which is this predicate and `!isTournament`.
 */
export function seatCanAddFunds(
  asset: ArenaIdentity['asset'] | null | undefined,
  isTournament: boolean
): boolean {
  if (asset === 'chips') return true;
  return asset === 'diamonds' && !isTournament;
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
