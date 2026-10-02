/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MENU OFFERS NO UNION INSIDE THE DIAMOND ARENA (2026-09-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond programme, line 6: "Verify no agent panels, union
 * menus, chip metrics or synthetic players appear as real activity." Ruling
 * 16 keeps unions, agents and commissions out of the arena, and the arena has
 * no union (`union_id` NULL, held by `poker_arena_diamond_identity`). The
 * global menu's "Create Union" quick action, an allowlisted door
 * (`useCanCreateUnion`), was still offered while the player stood in the
 * arena, the one union control a Diamond player could see.
 *
 * It is hidden while the club in the menu's context is the arena, judged by
 * the client's one arena identity (`isDiamondArenaClubKey`) over every key
 * that can name it: the route's club (path or `?club=`), that club resolved
 * to its id, and the lobby opened as a tab over a table, where the address
 * stays `/table/<id>`. Every chip club, and every other entry in the menu,
 * is unchanged, "Create Club" included.
 */
import { isDiamondArenaClubKey } from '../../lib/constants';

export function menuOffersCreateUnion(
  canCreateUnion: boolean,
  clubKeys: readonly (string | null | undefined)[]
): boolean {
  return canCreateUnion && !clubKeys.some((key) => isDiamondArenaClubKey(key));
}
