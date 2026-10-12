/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PLATFORM-STAFF ROUTE IS CLOSED TO EVERYONE ELSE (2026-09-10)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * /engine and the legacy /financial-alerts redirect were behind <AuthGuard>
 * alone. The pages themselves carried no role check, so any signed-in account
 * could open the engine control panel and the financial alert queue. The data
 * behind them is gated in Postgres (`fn_admin_horse_fleet_counts` raises
 * 42501 for a non-admin, `financial_alerts` is service-role only), which is
 * why the leak was a blank page rather than a breach - and why nobody closed
 * the door: it looked like nothing was behind it.
 *
 * The answer is the same one `HouseAdsPage` and `ClubWorkspaceContext` use:
 * `profiles.role` through `isPlatformStaffRole`, the client mirror of
 * `fn_is_platform_admin()`. Fails CLOSED - not signed in, an unreadable
 * profile, a network error - and sends the refused account to the arena
 * home rather than leaving them on a page that says nothing.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { reportError } from '../../utils/errorReporter';
import { isPlatformStaffRole } from '../../utils/platformRoles';
import { LoadingState } from '../common/EmptyState';

export default function PlatformStaffGuard({ children }: { children: ReactNode }) {
  const { user, isHydrating } = useAuthUser();
  const [decision, setDecision] = useState<{
    userId: string | null;
    allowed: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (isHydrating) {
      setDecision(null);
      return undefined;
    }
    if (!user?.id) {
      setDecision({ userId: null, allowed: false });
      return undefined;
    }
    const verifiedUserId = user.id;
    setDecision(null);
    (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', verifiedUserId)
          .maybeSingle();
        if (error) throw error;
        if (!cancelled) {
          setDecision({
            userId: verifiedUserId,
            allowed: isPlatformStaffRole(data?.role),
          });
        }
      } catch (e) {
        reportError(e, 'PlatformStaffGuard.role_lookup');
        // An unreadable role is not a grant.
        if (!cancelled) setDecision({ userId: verifiedUserId, allowed: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, isHydrating]);

  const activeUserId = user?.id ?? null;
  const allowed = !isHydrating && decision?.userId === activeUserId ? decision.allowed : null;

  if (allowed === null) return <LoadingState message="Checking Your Access" />;
  if (!allowed) return <Navigate to="/" replace />;
  return <>{children}</>;
}
