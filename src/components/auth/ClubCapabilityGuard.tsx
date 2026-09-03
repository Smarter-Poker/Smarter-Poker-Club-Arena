import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getRequiredClubOperationAccess } from '../../config/clubOperationsNavigation';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { capture } from '../../lib/analytics';
import { PermissionState } from '../common/EmptyState';

export default function ClubCapabilityGuard({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const workspace = useClubWorkspace();
  const required = getRequiredClubOperationAccess(location.pathname);

  /* ═══ "NOT YET KNOWN" IS NOT "NO" (2026-09-02) ═════════════════════════
     ClubWorkspaceContext hands out CLOSED_CAPABILITIES for every status that
     is not `ready` - which includes `loading`. So on a COLD LOAD of any
     finance or control route, `canViewFinance` is false for a beat, and this
     guard read that as a decision and told the viewer:

       "This Tool Is Restricted. Your Current Club Role Does Not Include
        Finance Access."

     It said that to the OWNER of the club. Verified on production: the E2E
     account is `owner` of SHARK CLUB, and the Playwright snapshot from run
     33567090010 caught the permission gate rendered on /clubs/shark-club/data
     for that account. On a warm cache the workspace resolves before anyone
     reads it; on a cold one - CI, a slow phone, a first visit - the denial is
     what the page IS, and the E2E sat on it for the full 60s and went red.

     Every denial also fired `club_capability_denied`, so the telemetry that
     would have shown this has been carrying false denials for every cold load
     of these routes.

     A capability check has three answers, not two: allowed, denied, and NOT
     YET KNOWN. Rendering `children` while undecided would flash a finance
     surface at someone who may not be allowed to see it, so the undecided
     case renders nothing and waits - the shell and the page's own skeleton
     are already handling that beat. */
  const undecided = !!required && workspace.loading;

  const allowed = !required
    ? true
    : required === 'control'
      ? workspace.canControlClub
      : required === 'finance'
        ? workspace.canViewFinance
        : workspace.isClubStaff;

  useEffect(() => {
    // Never report a denial we have not actually made.
    if (!required || allowed || undecided) return;
    capture('club_capability_denied', {
      club_id: workspace.clubUUID,
      route: location.pathname,
      required_capability: required,
      club_role: workspace.clubRole,
    });
  }, [allowed, undecided, location.pathname, required, workspace.clubRole, workspace.clubUUID]);

  if (undecided) return null;

  if (allowed) return <>{children}</>;

  const destination = workspace.isClubStaff
    ? `/clubs/${workspace.routeClubId}/operations`
    : `/clubs/${workspace.routeClubId}`;

  return (
    <PermissionState
      title="This Tool Is Restricted"
      description={`Your Current Club Role Does Not Include ${required} Access. The Club Has Not Been Changed.`}
      onBack={() => navigate(destination, { replace: true })}
    />
  );
}
