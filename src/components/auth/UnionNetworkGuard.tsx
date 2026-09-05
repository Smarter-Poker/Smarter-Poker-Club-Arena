/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE UNION DIRECTORY IS NOT A PUBLIC DOOR (Dan 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "(AND THIS PAGE SHOULD BE HIDDEN TO EVERYONE EXECPT ME:
 * https://smarter.poker/hub/club-arena/unions)".
 *
 * Removing the links is not hiding the page - /unions is a URL anyone can type,
 * and it was reachable by every signed-in account. This closes the route.
 * The navigation entries are removed in the same commit
 * (config/arenaSectionNavigation.ts and the Community Center's link list), so
 * the destination is neither offered nor reachable.
 *
 * Fails closed while checking and on any error. Sends a refused account to
 * /community, which is where the Unions entry used to live and is a place they
 * can actually use - not to /unions, which would be a redirect loop.
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useCanOperateUnionNetwork } from '../../hooks/useCanCreateUnion';
import { LoadingState } from '../common/EmptyState';

export default function UnionNetworkGuard({ children }: { children: ReactNode }) {
  const { canOperateUnionNetwork, checking } = useCanOperateUnionNetwork();
  if (checking) return <LoadingState message="Checking Your Access" />;
  if (!canOperateUnionNetwork) return <Navigate to="/community" replace />;
  return <>{children}</>;
}
