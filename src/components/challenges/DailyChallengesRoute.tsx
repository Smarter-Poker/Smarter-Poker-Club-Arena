import { Suspense } from 'react';
import { AuthGuard } from '../auth/AuthGuard';
import { PageErrorBoundary } from '../common/PageErrorBoundary';
import { lazyWithRetry } from '../../utils/lazyWithRetry';
import {
  DailyChallengesAuthLoading,
  DailyChallengesCrashFallback,
} from './DailyChallengesRouteFallback';

const DailyChallengesPage = lazyWithRetry(() => import('../../pages/DailyChallengesPage'));

/**
 * Route-local shell for every Daily Challenges cycle.
 *
 * Keeping this wrapper lazy prevents its cinematic loading and recovery graph
 * from entering Club Arena's universal first-load bundle. The nested suspense
 * boundary also keeps that same approved master on screen while the full
 * challenge ledger chunk is fetched for an already-authenticated player.
 */
export default function DailyChallengesRoute() {
  return (
    <AuthGuard loadingFallback={<DailyChallengesAuthLoading />}>
      <PageErrorBoundary
        pageName="Daily Challenges"
        fallback={({ error, retry }) => (
          <DailyChallengesCrashFallback error={error} onRetry={retry} />
        )}
      >
        <Suspense fallback={<DailyChallengesAuthLoading />}>
          <DailyChallengesPage />
        </Suspense>
      </PageErrorBoundary>
    </AuthGuard>
  );
}
