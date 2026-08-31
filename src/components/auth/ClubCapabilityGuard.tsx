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

  const allowed = !required
    ? true
    : required === 'control'
      ? workspace.canControlClub
      : required === 'finance'
        ? workspace.canViewFinance
        : workspace.isClubStaff;

  useEffect(() => {
    if (!required || allowed) return;
    capture('club_capability_denied', {
      club_id: workspace.clubUUID,
      route: location.pathname,
      required_capability: required,
      club_role: workspace.clubRole,
    });
  }, [allowed, location.pathname, required, workspace.clubRole, workspace.clubUUID]);

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
