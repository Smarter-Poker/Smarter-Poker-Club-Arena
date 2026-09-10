/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A UNION'S MONEY AND OPERATIONS ROUTES ARE FOR THE UNION'S OVERSEERS (2026-09-10)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * /clubs/:clubId/settlement carries <ClubMemberGuard>; its twin
 * /unions/:unionId/settlement carried nothing but <AuthGuard>, and neither did
 * operations, table-management, data or statements. Every one of those pages
 * is written for the union lead, and every RPC under them already raises for
 * anybody else - so the missing guard did not leak money, it leaked a page
 * that renders refusals, and it meant the client advertised a door the
 * database then slammed.
 *
 * `ca_can_oversee_union(p_union_id)` is the predicate the statements board,
 * the data page and the settlement RPCs are all gated on in Postgres: the
 * union's owner, an appointed union admin, the owner or staff of a
 * club-as-union, or a platform admin. Asking it here, about auth.uid() only,
 * means the door and the lock agree.
 *
 * NOT applied to /unions/:unionId (the overview a club owner reads before
 * applying to join) or /unions/:unionId/games (the games directory members
 * browse); those are membership surfaces, not overseer surfaces.
 *
 * Fails CLOSED while resolving, on an unreadable answer and on a slug that
 * resolves to no union. The slug is resolved to a UUID first, because the RPC
 * takes a uuid and a slug in that argument is a 22P02 that reads as an outage.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useUnionRouteId } from '../../hooks/useUnionRouteId';
import { reportError } from '../../utils/errorReporter';
import { isUUID } from '../../utils/clubIdResolver';
import { LoadingState, PermissionState } from '../common/EmptyState';

export default function UnionOverseerGuard({ children }: { children: ReactNode }) {
  const { user, isHydrating } = useAuthUser();
  const { unionId, unionRef } = useUnionRouteId();
  const navigate = useNavigate();
  const [verdict, setVerdict] = useState<{ unionId: string; allowed: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id || !unionId) return undefined;
    if (!isUUID(unionId)) {
      setVerdict({ unionId, allowed: false });
      return undefined;
    }
    (async () => {
      try {
        const { data, error } = await supabase.rpc('ca_can_oversee_union', {
          p_union_id: unionId,
        });
        if (error) throw error;
        if (!cancelled) setVerdict({ unionId, allowed: data === true });
      } catch (e) {
        reportError(e, 'UnionOverseerGuard.ca_can_oversee_union');
        if (!cancelled) setVerdict({ unionId, allowed: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, unionId]);

  if (!unionRef) return <>{children}</>;

  if (!user?.id) {
    if (isHydrating) return <LoadingState message="Checking Your Access" />;
    return (
      <PermissionState
        description="Sign In To Open This Union's Operations."
        onBack={() => navigate(-1)}
      />
    );
  }

  // The verdict is keyed by the union it was reached for, so a slug-to-slug
  // navigation cannot carry the previous union's answer across.
  if (!unionId || !verdict || verdict.unionId !== unionId) {
    return <LoadingState message="Checking Your Access" />;
  }

  if (!verdict.allowed) {
    return (
      <PermissionState
        title="This Union Tool Is Restricted"
        description="Only The Union's Owner And Admins Can Open This Page. Nothing Has Been Changed."
        onBack={() => navigate(-1)}
      />
    );
  }

  return <>{children}</>;
}
