/**
 * The Drift console is not a generic club-finance page. Its platform readers
 * are platform staff and the explicit ca_incident_recipients registry; a club
 * role by itself grants neither global supply data nor another club's incident.
 * Ask the same server capability the reader RPCs enforce and fail closed.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { LoadingState } from '../common/EmptyState';

export default function FinancialAdminGate({ children }: { children: ReactNode }) {
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
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_ca_can_view_drift_console');
        if (error) throw error;
        if (!cancelled) setDecision({ userId: verifiedUserId, allowed: data === true });
      } catch (error) {
        reportError(error, 'FinancialAdminGate.drift_console_authority');
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
  if (!allowed) return <Navigate to="/financial-admin" replace />;
  return <>{children}</>;
}
