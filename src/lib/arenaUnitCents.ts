/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UNIT A TABLE PAYS ON, FROM ITS ALREADY-PARSED ARENA ASSET (2026-09-20)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE RULE ITSELF IS NOT HERE, AND MUST NOT BE COPIED HERE.
 * `tournamentUnitCents` in `server/src/tournament/tournamentUnit.ts` is the one
 * place TypeScript answers "what unit does this tournament pay in", and it is
 * the TypeScript half of `fn_ca_tournament_unit_cents`. This module derives
 * nothing: it reads an answer that has already been derived, and it imports
 * every constant it returns from that one file so the two can never disagree.
 *
 * WHAT IT IS FOR. The felt does not hold a club row. It holds an
 * `ArenaIdentity`, and the only way to get one is `parseArenaIdentity`, which
 * returns `asset: 'diamonds'` ONLY for a row satisfying `asset = 'diamonds'
 * AND is_platform IS TRUE AND union_id IS NULL` and throws on anything else.
 * Those are character for character the three conditions `tournamentUnitCents`
 * tests, so an asset that has been through that parser already carries their
 * answer - and `parseTableArenaIdentity` additionally refuses a Diamond table
 * that belongs to a union.
 *
 * It exists so the seat's bounty badge, the knockout float, the ranking card
 * and the session summary can state a unit at all. Before it they printed the
 * chip contract unconditionally, which at a Diamond table is a decimal point
 * on a payment that holds whole Diamonds.
 *
 * WHY IT SITS IN `src/` RATHER THAN BESIDE THE RULE. It is a browser adapter
 * over a browser-only input, and nothing in the engine has an `ArenaIdentity`
 * in hand where it needs a unit. `placePrize` in
 * `src/components/tournament/details/types.ts` is the same shape - a client
 * wrapper that passes the engine's rule a unit - and is censused by
 * `tests/a-tournament-prize-knows-its-unit.law.test.ts` in that position. The
 * engine tree is left untouched on purpose, so a client-only change does not
 * enter the engine release lane.
 */
import {
  CHIP_UNIT_CENTS,
  DIAMOND_UNIT_CENTS,
  UNIT_CENTS_ASSET_NOT_READ,
} from '../../server/src/tournament/tournamentUnit';

/**
 * The unit, in cents, for a table whose arena asset has already been parsed.
 *
 * `undefined` or `null` is a table whose arena has not been read yet, and its
 * answer is `UNIT_CENTS_ASSET_NOT_READ` - the greppable name for "nobody
 * looked", not a quiet cent (CLAUDE.md 10.86 rule 1).
 */
export function arenaAssetUnitCents(asset: 'chips' | 'diamonds' | undefined | null): number {
  if (asset === 'diamonds') return DIAMOND_UNIT_CENTS;
  if (asset === 'chips') return CHIP_UNIT_CENTS;
  return UNIT_CENTS_ASSET_NOT_READ;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SAME UNIT, OR NO ANSWER WHILE THE ARENA IS UNREAD (2026-09-21)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `arenaAssetUnitCents` answers an unread arena with `UNIT_CENTS_ASSET_NOT_READ`,
 * the greppable cent, and the seat's bounty badge and the knockout float keep
 * that answer. A surface that prints a tournament PRIZE, a CHEST or a POOL at a
 * moment of its own asks this instead, because for it "not read yet" and
 * "chips" must not look the same: until the table's arena has been read it gets
 * `null`, and it shows its own waiting state rather than a figure in a
 * currency nobody looked up (CLAUDE.md 10.86 rule 1).
 *
 * Still an adapter and not a second copy of the rule: every number it returns
 * comes from `arenaAssetUnitCents`, which imports its constants from the one
 * rule in `server/src/tournament/tournamentUnit.ts`.
 */
export function arenaAssetUnitCentsIfRead(
  asset: 'chips' | 'diamonds' | undefined | null
): number | null {
  return asset === 'chips' || asset === 'diamonds' ? arenaAssetUnitCents(asset) : null;
}
