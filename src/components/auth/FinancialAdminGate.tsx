/**
 * Route-level form of `useFinancialAdminScope` for a money page that does
 * its own reads through a gated RPC and only needs the DOOR closed.
 *
 * /financial-incidents had no role check at all. Its data comes from
 * `fn_ca_incident_dashboard`, which answers club owners, union owners,
 * incident recipients and platform admins and returns nothing to anybody
 * else - so the leak was an empty admin page, and the page was still
 * advertised to every signed-in account. This gate asks the same question
 * the other money pages ask (a finance role in some club, or platform staff)
 * before the page mounts; the RPC stays authoritative underneath.
 */
import type { ReactNode } from 'react';
import { useFinancialAdminScope } from '../../hooks/useFinancialAdminScope';
import FinancialAdminScopeState from '../common/FinancialAdminScopeState';

export default function FinancialAdminGate({ children }: { children: ReactNode }) {
  const scope = useFinancialAdminScope();
  if (scope.status !== 'ready') return <FinancialAdminScopeState scope={scope} />;
  return <>{children}</>;
}
