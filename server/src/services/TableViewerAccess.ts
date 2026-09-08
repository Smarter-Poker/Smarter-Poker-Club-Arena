import { supabase } from './supabase.js';

export type TableViewerAccessReason =
  | 'seated'
  | 'club_member'
  | 'membership_required'
  | 'observers_restricted'
  | 'table_not_found'
  | 'check_failed';

export interface TableViewerAccess {
  allowed: boolean;
  reason: TableViewerAccessReason;
  clubId: string | null;
}

/**
 * Authoritative observer gate shared by HTTP state and both WebSocket paths.
 * Service-role reads are deliberately narrow and fail closed: a browser route
 * or stale client result can never grant access to a private club table.
 */
export async function authorizeTableViewer(
  tableId: string,
  userId: string
): Promise<TableViewerAccess> {
  const { data: table, error: tableError } = await supabase
    .from('tables')
    .select('club_id, union_id, restrict_observers')
    .eq('id', tableId)
    .maybeSingle();

  if (tableError) return { allowed: false, reason: 'check_failed', clubId: null };
  if (!table) return { allowed: false, reason: 'table_not_found', clubId: null };

  const clubId = typeof table.club_id === 'string' ? table.club_id : null;
  const unionId = typeof table.union_id === 'string' ? table.union_id : null;
  const accessScopeId = unionId || clubId;
  if (!accessScopeId) return { allowed: false, reason: 'check_failed', clubId: null };

  /*
   * The lobby's ownership rule is union-aware: a member of Shark can see a
   * Midway-owned table even though that durable row names Midway's shell club
   * as club_id. This gate used to require an exact club_members(club_id) row,
   * so the lobby offered Watch Table and both engine transports refused it.
   *
   * Resolve the table owner's authoritative scope and the viewer's complete
   * active membership set in the SAME second database wave as the seat read.
   * fn_join_club enforces four active memberships, so this is bounded without
   * an authorization-breaking LIMIT. fn_club_scope_ids also covers the legacy
   * union_clubs relationship as well as clubs.union_id. No scope is cached:
   * a club leaving a union must revoke access on the next subscription.
   */
  const scopeOwnerId = accessScopeId;
  const [seatResult, membershipsResult, scopeResult] = await Promise.all([
    supabase
      .from('table_seats')
      .select('id')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('club_members')
      .select('club_id')
      .eq('user_id', userId)
      .in('status', ['active', 'approved']),
    supabase.rpc('fn_club_scope_ids', { p_club_id: scopeOwnerId }),
  ]);

  if (seatResult.error || membershipsResult.error || scopeResult.error) {
    return { allowed: false, reason: 'check_failed', clubId: accessScopeId };
  }
  if (seatResult.data) return { allowed: true, reason: 'seated', clubId: accessScopeId };
  const scopeIds = new Set(
    Array.isArray(scopeResult.data)
      ? scopeResult.data.filter((id): id is string => typeof id === 'string')
      : []
  );
  const isMember = (membershipsResult.data ?? []).some(
    (membership) => typeof membership.club_id === 'string' && scopeIds.has(membership.club_id)
  );
  if (isMember && table.restrict_observers === true) {
    return { allowed: false, reason: 'observers_restricted', clubId: accessScopeId };
  }
  if (isMember) return { allowed: true, reason: 'club_member', clubId: accessScopeId };
  return { allowed: false, reason: 'membership_required', clubId: accessScopeId };
}
