/**
 * THE MEMBER DOOR (2026-09-29)
 *
 * `/clubs/:clubId/members/:userId` is a chip club's member-management screen:
 * roles, agents, downline, fees and credit. The Diamond Arena has none of
 * those, and a row on its own Players page opens nothing, so a member URL
 * typed inside the arena goes to the arena's Players page instead. The choice
 * is the server's, as in ClubPlayersDoor: ClubMemberGuard wraps this route in
 * ArenaAccessBoundary, which publishes the verified `fn_poker_arena_context`
 * answer, and only an arena whose membership the server grants automatically
 * reads true here. Nothing is decided from the URL.
 *
 * A chip club renders MemberManagementPage exactly as it did before this door
 * existed: same component, no props, nothing wrapped around it.
 */
import { Navigate } from 'react-router-dom';
import { useAutomaticArenaMembership } from '../components/arena/arenaAccess';
import MemberManagementPage from './MemberManagementPage';

export default function ClubMemberDoor() {
  return useAutomaticArenaMembership() ? (
    <Navigate to=".." relative="path" replace />
  ) : (
    <MemberManagementPage />
  );
}
