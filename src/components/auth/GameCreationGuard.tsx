import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState } from '../common/EmptyState';
import PageSkeleton from '../common/PageSkeleton';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import {
  canUseStandaloneClubCreationRoute,
  gameCreationDeniedMessage,
  type GameCreationAccess,
} from '../../lib/gameCreationAccess';
import { fetchGameCreationAccess } from '../../services/GameAccessService';

/**
 * Authoritative gate for game builders. Unlike ClubMemberGuard, this admits a
 * union owner/admin who manages a member club without requiring that operator
 * to also be a member of every club in the union.
 */
export default function GameCreationGuard({ children }: { children: ReactNode }) {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const [access, setAccess] = useState<GameCreationAccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkAccess = useCallback(async () => {
    setAccess(null);
    setError(null);
    try {
      if (!clubId) throw new Error('Club is required.');
      const resolvedClubId = await resolveClubUUID(clubId);
      setAccess(await fetchGameCreationAccess(resolvedClubId));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Game creation access could not be verified.'
      );
    }
  }, [clubId]);

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  if (error) return <ErrorState message={error} onRetry={() => void checkAccess()} />;
  if (!access) return <PageSkeleton variant="default" />;

  if (!canUseStandaloneClubCreationRoute(access)) {
    return (
      <ErrorState
        message={
          access.allowed && access.unionId
            ? 'This Club Is Managed By A Union. Create Games From The Union Console.'
            : gameCreationDeniedMessage(access)
        }
        onRetry={() => navigate(`/clubs/${clubId}`, { replace: true })}
      />
    );
  }

  return <>{children}</>;
}
