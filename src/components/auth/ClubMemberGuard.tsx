import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { ErrorState } from '../common/EmptyState';
import PageSkeleton from '../common/PageSkeleton';
import ClubCapabilityGuard from './ClubCapabilityGuard';
const ArenaAccessBoundary = lazy(() => import('../arena/ArenaAccessBoundary'));

function ChipMemberGuard({ children }: { children: ReactNode }) {
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const navigate = useNavigate();
  const workspace = useClubWorkspace();

  useEffect(() => {
    if (clubId && workspace.status === 'denied') navigate(`/invite/${clubId}`, { replace: true });
  }, [clubId, navigate, workspace.status]);

  if (!clubId) return <>{children}</>;

  if (workspace.status === 'loading' || workspace.status === 'idle') {
    return <PageSkeleton variant="default" />;
  }

  if (workspace.status === 'error') {
    return (
      <ErrorState
        message={workspace.error || 'Club access could not be verified.'}
        onRetry={workspace.reload}
      />
    );
  }

  if (!workspace.isMember) return <PageSkeleton variant="default" />;

  return <ClubCapabilityGuard>{children}</ClubCapabilityGuard>;
}

/** Resolve global entitlement before the private-club guard can redirect to Join. */
export default function ClubMemberGuard({ children }: { children: ReactNode }) {
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  if (!clubId) return <>{children}</>;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ArenaAccessBoundary clubKey={clubId} redirectToJoin>
        <ChipMemberGuard>{children}</ChipMemberGuard>
      </ArenaAccessBoundary>
    </Suspense>
  );
}
