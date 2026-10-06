import { parseTableArenaIdentity } from '../domain/ArenaContext.js';
import { DSS_CLUB_ID } from './StableHand.js';

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

/* ═══ HORSES PLAY THE DIAMOND ARENA (Dan, 2026-10-06) ════════════════════════
 *
 * Dan, verbatim: "CREATE THE SAME FUNCTIONALITY FOR THE HORSES INSIDE THE CLUB
 * ARENA, TO PLAY IN THE DIAMOND ARENA. IF A HORSE IS BROKE OR HAS NO CHIPS THEY
 * SHOULD BE PLAYING IN THE DIAMOND ARENA TO GET DIAMONDS ... ASSIGN ALL THE
 * HORSES THAT WERE INSIDE OF DEEP STACK SOCIETY TO PLAY IN THE DIAMOND ARENA
 * NOW." And, on the same day: cash games are not to start before the engine
 * fix is proven.
 *
 * So a Diamond Arena cash table is seated by the SAME seeding cycle, the same
 * candidate filter and the same door (`atomic_table_buyin`, which already
 * routes an arena table to `fn_poker_diamond_buyin`) as every chip table - a
 * horse is a player (CLAUDE.md 10.5) and the arena is just a table whose
 * wallet is the player's own Diamonds. What differs is only the WALLET:
 *
 *   - who may pay: a horse that is a member of one of the clubs below. The
 *     arena admits every profile (fn_ca_entry_scope_ok); Dan chose which
 *     horses play it, and that choice is this list.
 *   - with what: `profiles.diamonds`, the same balance the arena's own door
 *     reserves from, never a club treasury. Nothing here funds a horse.
 *   - in what unit: whole Diamonds. The door refuses a fractional amount.
 *
 * LATENT WHILE THE ARENA IS CLOSED. `diamondArenaIdFrom` answers null unless
 * `ca_arena_settings.cash_games_enabled` reads exactly true, and a null id
 * means no arena table enters the cycle at all - no read, no seat, no buy-in
 * attempt. Opening cash games is a person's decision (only-a-person-moves-
 * the-arena-switches); this file never touches the switch.
 */

/** The clubs whose horses play the Diamond Arena. Dan 2026-10-06: Deep Stack
 *  Society. A horse qualifies through a membership in one of these, and its
 *  Diamonds - not that club's chips - are what it plays with. */
export const DIAMOND_ARENA_HORSE_CLUBS: readonly string[] = [DSS_CLUB_ID];

/** The arena's club id, but only while its cash games are OPEN. Fails closed:
 *  an error, a missing row, a missing club id or a switch that is anything but
 *  `true` all read as "no arena this cycle". */
export function diamondArenaIdFrom(
  row: { club_id?: unknown; cash_games_enabled?: unknown } | null | undefined,
  error?: unknown
): string | null {
  if (error || !row) return null;
  if (row.cash_games_enabled !== true) return null;
  return typeof row.club_id === 'string' && row.club_id ? row.club_id : null;
}

/** A plain Diamond Arena cash table of THIS arena: the arena identity parses
 *  as `diamond_arena`, it is the open arena's own club, and it is not a
 *  cluster table (the arena's admission door refuses clustered tables). */
export function isDiamondArenaCashTable(
  table: {
    club_id?: unknown;
    union_id?: unknown;
    arena?: unknown;
    cluster_id?: unknown;
    lifecycle?: unknown;
  },
  arenaId: string | null
): boolean {
  if (!arenaId) return false;
  if (table.cluster_id != null || table.lifecycle != null) return false;
  try {
    const identity = parseTableArenaIdentity(table);
    return identity.kind === 'diamond_arena' && identity.id === arenaId;
  } catch {
    return false;
  }
}

/** Any Diamond table row (the arena join says so). Used where only the row is
 *  in hand, to decide the unit a buy-in is counted in. */
export function isDiamondTableRow(table: {
  club_id?: unknown;
  union_id?: unknown;
  arena?: unknown;
}): boolean {
  try {
    return parseTableArenaIdentity(table).asset === 'diamonds';
  } catch {
    return false;
  }
}

/** A Diamond is indivisible, and the arena door refuses a fractional buy-in
 *  (`invalid_diamond_cash_purchase`). The bankroll share can size one (it is
 *  floored to cents), so it is floored to whole Diamonds here - never rounded
 *  up, which would spend more of the roll than the share allows. Below the
 *  table minimum it is no seat at all. */
export function wholeDiamondBuyIn(sized: number, minBuyIn: number): number {
  if (!Number.isFinite(sized) || sized <= 0) return 0;
  const whole = Math.floor(sized + 1e-9);
  return whole >= Math.ceil(minBuyIn - 1e-9) ? whole : 0;
}
