import { parseTableArenaIdentity } from '../domain/ArenaContext.js';

/**
 * WHERE THE FLEET MAY SIT, AND WHAT PAYS.
 *
 * Dan 2026-09-10: "start linking and giving all the horses across all clubs
 * access to the diamond arena. they need to be able to fully play in the
 * diamond arena, just like they can in the club arena."
 *
 * Two kinds of table, two wallets, one rule (CLAUDE.md 10.5 - a horse is a
 * player):
 *
 *   chips     - a chip club or union table. The horse's roll is its
 *               `club_members.chip_balance` in the club that pays, exactly
 *               as it always was.
 *   diamonds  - the platform's Diamond Arena. Every platform user is a member
 *               by entitlement (POKER-ARENA-DIAMOND-BUILD-PROGRAMME, approved
 *               contract), a horse included, and there are no membership rows
 *               to read. The horse's roll is its OWN `profiles.diamonds` -
 *               ruling 16: "horses retain player parity and must use
 *               diamond-only funding" - and it buys in through the same door a
 *               human does (atomic_table_buyin -> fn_poker_diamond_buyin ->
 *               fn_poker_diamond_reserve). No treasury, no chip wallet.
 *
 * Until 2026-09-10 this module kept the fleet OUT of diamond tables
 * ("treasury-funded fleet seats belong only to authoritative chip arenas"),
 * which was right while the arena had no funding door. It has one now, and
 * the boundary that remains is the WALLET, not the room.
 */
export type FleetFunding = 'chips' | 'diamonds';

/** Which wallet a fleet seat at this table draws from, or null when the fleet may not sit here. */
export function fleetFundingFor(table: {
  club_id?: unknown;
  union_id?: unknown;
  arena?: unknown;
}): FleetFunding | null {
  try {
    const arena = parseTableArenaIdentity(table);
    if (arena.asset === 'chips') return 'chips';
    // parseArenaIdentity only ever names the PLATFORM club a diamond arena.
    if (arena.kind === 'diamond_arena') return 'diamonds';
    return null;
  } catch {
    return null;
  }
}

/** A table the fleet may seat: a chip arena, or the platform's Diamond Arena. */
export function isFleetTable(table: {
  club_id?: unknown;
  union_id?: unknown;
  arena?: unknown;
}): boolean {
  return fleetFundingFor(table) !== null;
}

/** The platform's diamond room: every horse is a member, its own diamonds pay. */
export function isDiamondArenaTable(table: {
  club_id?: unknown;
  union_id?: unknown;
  arena?: unknown;
}): boolean {
  return fleetFundingFor(table) === 'diamonds';
}

/**
 * Diamonds are whole (fn_poker_diamond_buyin: `p_amount <> trunc(p_amount)`
 * is refused, and the table's own limits are whole by the same rule). A chip
 * buy-in may carry cents; a diamond one is rounded to the nearest whole and
 * held inside the table's limits, so the door never sees a fraction.
 */
export function wholeDiamondBuyIn(amount: number, minBuyIn: number, maxBuyIn: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const whole = Math.round(amount);
  const lo = Math.ceil(minBuyIn);
  const hi = Math.floor(maxBuyIn);
  if (!(lo <= hi)) return 0;
  return Math.max(lo, Math.min(hi, whole));
}
