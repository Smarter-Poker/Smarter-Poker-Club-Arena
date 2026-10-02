/**
 * THE PLAYERS DOOR (2026-09-29)
 *
 * `/clubs/:clubId/members` renders the chip roster for a chip club and the
 * Diamond Arena's own Players page inside the arena. The choice is the
 * server's: ClubMemberGuard wraps this route in ArenaAccessBoundary, which
 * publishes the verified `fn_poker_arena_context` answer, and only an arena
 * whose membership the server grants automatically reads true here. Nothing is
 * decided from the URL.
 *
 * A chip club renders ClubMembersPage exactly as it did before this door
 * existed: same component, no props, nothing wrapped around it.
 *
 * ONE CHUNK FOR BOTH PAGES, ON PURPOSE. The Diamond page wears the chip
 * roster's stylesheet and class names, so beside it in one file it compresses
 * to a fraction of its size alone, and the whole-app bundle sits at the
 * ceiling Dan set (scripts/ci/bundle-size.mjs). As its own lazy chunk it
 * weighed 3.9 kB gzipped; here it costs much less.
 */
import { useAutomaticArenaMembership } from '../components/arena/arenaAccess';
import ClubMembersPage from './ClubMembersPage';
import DiamondPlayersPage from './DiamondPlayersPage';

export default function ClubPlayersDoor() {
  return useAutomaticArenaMembership() ? <DiamondPlayersPage /> : <ClubMembersPage />;
}
