/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH DOORS UNDER THE DIAMOND ARENA OPEN FOR A PLAYER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA.
 * (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS AND ITS
 * PLAYED WITH DIAMONDS INSTEAD OF CHIPS)".
 *
 * Phase 7 opened the arena's own lobby and kept every other route underneath
 * `/clubs/diamond-arena/...` on the safe shell, so that "no unions or agents"
 * held on a typed URL and not only on a hidden link. That was right for the
 * operator doors and wrong for the player ones: a Diamond player could reach
 * the lobby and nothing else. Tournaments, the roster, a member's profile and
 * the messenger all rendered "Welcome To Diamond Arena" instead of the page.
 *
 * This is the allowlist. It is a list of PLAYER surfaces, stated by name, and
 * everything not on it stays on the shell: finance, agents, operations,
 * control, cashier, settlement, the wheel, the diamond games, settings, hand
 * review, reports and every other chip operator door. A route added to the
 * app later is closed to the arena until somebody writes it here on purpose.
 *
 * The footer (`DiamondBottomNav`) offers exactly these doors plus the two
 * global ones (Hand History and Stats) and the wallet modal, so the list a
 * player is shown and the list the boundary opens are the same list.
 */
import { isDiamondArenaClubKey } from '../../lib/constants';

/**
 * The path segment directly under `/clubs/<arena>/` that a player may open.
 * `members` also admits `members/:userId` and `members/:userId/statistics`,
 * which are the roster's own profile and statistics pages.
 */
export const DIAMOND_PLAYER_SEGMENTS = Object.freeze([
  'lobby',
  'tournaments',
  'messages',
  'members',
] as const);

/** `/clubs/<arena>` split into the arena key and the segments beneath it. */
function splitArenaPath(pathname: string): { key: string; rest: string[] } | null {
  const match = pathname.replace(/\/+$/, '').match(/^\/clubs\/([^/]+)((?:\/[^/]+)*)$/);
  if (!match) return null;
  const rest = match[2].split('/').filter(Boolean);
  return { key: match[1], rest };
}

/**
 * True for the arena's lobby itself: `/clubs/diamond-arena` and
 * `/clubs/diamond-arena/lobby`. The closed-games notice belongs above the
 * lobby and nowhere else.
 */
export function isDiamondArenaLobbyPath(pathname: string): boolean {
  const split = splitArenaPath(pathname);
  if (!split || !isDiamondArenaClubKey(split.key)) return false;
  return split.rest.length === 0 || (split.rest.length === 1 && split.rest[0] === 'lobby');
}

/**
 * True for every Diamond Arena route a PLAYER may open: the lobby and the
 * segments in `DIAMOND_PLAYER_SEGMENTS`. False for any other route under the
 * arena, and false for every route that is not under the arena at all.
 */
export function isDiamondArenaPlayerPath(pathname: string): boolean {
  const split = splitArenaPath(pathname);
  if (!split || !isDiamondArenaClubKey(split.key)) return false;
  if (split.rest.length === 0) return true;
  const [head, userId, tail, ...beyond] = split.rest;
  if (!(DIAMOND_PLAYER_SEGMENTS as readonly string[]).includes(head)) return false;
  if (head !== 'members') return split.rest.length === 1;
  if (split.rest.length === 1) return true;
  if (!userId || beyond.length > 0) return false;
  return tail === undefined || tail === 'statistics';
}

/**
 * The opposite answer, for the boundary: a route under the arena that is NOT
 * a player route. Operator, finance, agent and union doors all land here.
 */
export function isDiamondArenaOperatorPath(pathname: string): boolean {
  const split = splitArenaPath(pathname);
  if (!split || !isDiamondArenaClubKey(split.key)) return false;
  return !isDiamondArenaPlayerPath(pathname);
}
