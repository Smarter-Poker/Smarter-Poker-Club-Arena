/**
 * What an admin money page renders while its club scope is not `ready`.
 *
 * One component so the five global-path money pages agree on the three
 * non-ready answers: loading (wait, render nothing financial), denied (the
 * viewer holds no finance role anywhere, or not in the club they named) and
 * error (the club could not be found or the membership could not be read).
 * A page that has not been handed a club renders THIS, never a table of
 * somebody's numbers with an empty filter.
 */
import { useNavigate } from 'react-router-dom';
import type { FinancialAdminScope } from '../../hooks/useFinancialAdminScope';
import { ErrorState, LoadingState, PermissionState } from './EmptyState';

export default function FinancialAdminScopeState({ scope }: { scope: FinancialAdminScope }) {
  const navigate = useNavigate();
  if (scope.status === 'denied') {
    return (
      <PermissionState
        title="This Page Is Restricted"
        description={scope.message || 'Your Role Does Not Include Finance Access.'}
        onBack={() => navigate(-1)}
      />
    );
  }
  if (scope.status === 'error') {
    return (
      <ErrorState
        message={scope.message || 'Your Club Access Could Not Be Verified.'}
        onRetry={scope.reload}
      />
    );
  }
  return <LoadingState message="Checking Your Club Access" />;
}
