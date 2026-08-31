import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { fetchQuickLinkClubs, readLastClubId, resolveTargetClub } from '../../utils/clubQuickLink';
import { EmptyState, ErrorState, LoadingState } from '../common/EmptyState';

interface LegacyClubToolRedirectProps {
  destination: 'agents' | 'anti-cheat' | 'data' | 'invite' | 'members';
  toolName: string;
}

/**
 * Compatibility entrance for legacy global operator URLs.
 *
 * These tools are club-owned and their working pages require a club route
 * parameter. Resolve the same remembered/first active club used by cashier
 * quick links, then replace the history entry with the canonical scoped URL.
 */
export default function LegacyClubToolRedirect({
  destination,
  toolName,
}: LegacyClubToolRedirectProps) {
  const navigate = useNavigate();
  const { user, isHydrating } = useAuthUser();
  const [state, setState] = useState<'loading' | 'empty' | 'error'>('loading');

  const resolveDestination = useCallback(async () => {
    if (!user?.id) return;
    setState('loading');
    try {
      const clubs = await fetchQuickLinkClubs(user.id);
      const target = resolveTargetClub(clubs, readLastClubId());
      if (!target) {
        setState('empty');
        return;
      }
      const targetPath =
        destination === 'invite' ? `/invite/${target.id}` : `/clubs/${target.id}/${destination}`;
      navigate(targetPath, { replace: true });
    } catch {
      setState('error');
    }
  }, [destination, navigate, user?.id]);

  useEffect(() => {
    if (!isHydrating && user?.id) void resolveDestination();
  }, [isHydrating, resolveDestination, user?.id]);

  if (isHydrating || state === 'loading') {
    return <LoadingState message={`Opening ${toolName}`} />;
  }

  if (state === 'error') {
    return (
      <ErrorState
        message={`Club Arena could not determine which club should open ${toolName}.`}
        onRetry={() => void resolveDestination()}
      />
    );
  }

  return (
    <EmptyState
      icon="CLUB"
      eyebrow="Club Context Required"
      tone="permission"
      title={`Choose A Club Before Opening ${toolName}`}
      description={
        destination === 'invite'
          ? 'Join Or Create A Club First So Club Arena Can Build An Invitation For The Right Community.'
          : 'This Tool Changes Club-Owned Data. Join Or Create A Club First So Club Arena Can Open The Correct Workspace And Permissions.'
      }
      action={{ label: 'Find Clubs', onClick: () => navigate('/search') }}
      secondaryAction={{ label: 'Return To Arena', onClick: () => navigate('/') }}
    />
  );
}
