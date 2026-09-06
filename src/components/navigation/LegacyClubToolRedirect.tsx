import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  fetchQuickLinkClubs,
  readCachedQuickLinkClubs,
  readLastClubId,
  resolveTargetClub,
} from '../../utils/clubQuickLink';
import { EmptyState, ErrorState, LoadingState } from '../common/EmptyState';

interface LegacyClubToolRedirectProps {
  destination: 'agents' | 'anti-cheat' | 'data' | 'invite' | 'members';
  toolName: string;
}

const CLUB_RESOLUTION_TIMEOUT_MS = 8_000;

function withResolutionTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Club resolution timed out.'));
    }, CLUB_RESOLUTION_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
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
  const resolutionAttemptRef = useRef(0);

  const resolveDestination = useCallback(async () => {
    if (!user?.id) return;
    const attempt = resolutionAttemptRef.current + 1;
    resolutionAttemptRef.current = attempt;
    setState('loading');

    // The lobby has already verified and cached these memberships. Reusing
    // that answer makes a legacy Players door immediate and avoids another
    // production round trip on the most common path.
    const cachedTarget = resolveTargetClub(readCachedQuickLinkClubs(user.id), readLastClubId());
    if (cachedTarget) {
      const cachedPath =
        destination === 'invite'
          ? `/invite/${cachedTarget.id}`
          : `/clubs/${cachedTarget.id}/${destination}`;
      navigate(cachedPath, { replace: true });
      return;
    }

    try {
      const clubs = await withResolutionTimeout(fetchQuickLinkClubs(user.id));
      if (resolutionAttemptRef.current !== attempt) return;
      const target = resolveTargetClub(clubs, readLastClubId());
      if (!target) {
        setState('empty');
        return;
      }
      const targetPath =
        destination === 'invite' ? `/invite/${target.id}` : `/clubs/${target.id}/${destination}`;
      navigate(targetPath, { replace: true });
    } catch {
      if (resolutionAttemptRef.current !== attempt) return;
      setState('error');
    }
  }, [destination, navigate, user?.id]);

  useEffect(() => {
    if (!isHydrating && user?.id) void resolveDestination();
    return () => {
      resolutionAttemptRef.current += 1;
    };
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
