import { lazy, Suspense } from 'react';
import { useLocation } from 'react-router-dom';
import { getClubOperationContext } from '../../config/clubOperationsNavigation';
import { useClubNavigationAccess } from '../../hooks/useClubNavigationAccess';
import { isDiamondArenaClubKey } from '../../lib/diamondArenaIdentity';

/**
 * The compact sibling rail for club staff pages. The fuller tool inventory
 * lives at /clubs/:clubId/operations; this rail keeps the highest-frequency
 * destinations one action away without rebuilding each page.
 *
 * This half is the part that must live in the entry chunk, because AppLayout
 * mounts it on every page. It answers one question - is this a club operations
 * route, and is the viewer staff - and nothing here queries. The reading half
 * is ClubOperationsRailBody, loaded only when the answer is yes. See the note
 * at the top of that file.
 */
export default function ClubOperationsRail() {
  const location = useLocation();
  const clubId = getClubOperationContext(location.pathname);
  const isDiamondArena = isDiamondArenaClubKey(clubId);
  const access = useClubNavigationAccess(clubId);

  if (isDiamondArena) return null;
  if (!clubId || access.loading || access.error || !access.isClubStaff) return null;

  /* No fallback: a rail that flashes an empty chassis and then fills is worse
     than one that arrives complete a beat later. */
  return (
    <Suspense fallback={null}>
      <ClubOperationsRailBody clubId={clubId} access={access} />
    </Suspense>
  );
}

const ClubOperationsRailBody = lazy(() => import('./ClubOperationsRailBody'));
