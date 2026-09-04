/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CREATE-UNION PAGE IS NOT A PUBLIC DOOR (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL ACCOUNTS EXCEPT FOR
 * MINE."
 *
 * Hiding the links is not hiding the page - /unions/create is a URL anyone can
 * type, and it was reachable by every signed-in account. This closes the route
 * itself. The real refusal is in the database
 * (trg_union_creation_is_allowlisted on public.unions), because the API route
 * behind the form runs as the service role and bypasses RLS; this guard exists
 * so nobody fills in three steps of a form to be told no at the end.
 *
 * Fails closed while checking and on any error.
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useCanCreateUnion } from '../../hooks/useCanCreateUnion';
import { LoadingState } from '../common/EmptyState';

export default function UnionCreationGuard({ children }: { children: ReactNode }) {
  const { canCreateUnion, checking } = useCanCreateUnion();
  if (checking) return <LoadingState message="Checking Your Access" />;
  if (!canCreateUnion) return <Navigate to="/unions" replace />;
  return <>{children}</>;
}
