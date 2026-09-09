import { supabase } from './supabase.js';
import { parseTableArenaIdentity } from '../domain/ArenaContext.js';

export type TableViewerAccessReason =
  | 'diamond_member'
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
  /**
   * Authoritative table policy captured in the same read that grants access.
   * Optional only so injected test doubles and an older rolling-deploy peer
   * fail closed instead of becoming a source of card visibility. Production
   * results from authorizeTableViewer always set it.
   */
  observerShowCards?: boolean;
}

/**
 * The one visibility decision shared by HTTP and both WebSocket transports.
 * A verified current seat always receives the player view. Everyone else
 * needs an explicit literal-true table policy; missing/skewed data is private.
 */
export function viewerCanSeeTabledCards(access: TableViewerAccess): boolean {
  return (
    access.allowed === true && (access.reason === 'seated' || access.observerShowCards === true)
  );
}

export function isSeatedTableViewer(access: TableViewerAccess): boolean {
  return access.allowed === true && access.reason === 'seated';
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
  // Both reads depend only on the requested table and authenticated player.
  // A verified current seat is already sufficient access; membership matters
  // only for observers and must not delay or reject a seated reconnect.
  const [{ data: table, error: tableError }, seatResult] = await Promise.all([
    supabase
      .from('tables')
      .select(
        'club_id, union_id, restrict_observers, observer_show_cards, arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)'
      )
      .eq('id', tableId)
      .maybeSingle(),
    supabase
      .from('table_seats')
      .select('id')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .limit(1)
      .maybeSingle(),
  ]);

  if (tableError) {
    return { allowed: false, reason: 'check_failed', clubId: null, observerShowCards: false };
  }
  if (!table) {
    return { allowed: false, reason: 'table_not_found', clubId: null, observerShowCards: false };
  }

  const clubId = typeof table.club_id === 'string' ? table.club_id : null;
  const unionId = typeof table.union_id === 'string' ? table.union_id : null;
  const accessScopeId = unionId || clubId;
  const observerShowCards = table.observer_show_cards === true;
  if (!accessScopeId) {
    return { allowed: false, reason: 'check_failed', clubId: null, observerShowCards: false };
  }
  let arena;
  try {
    arena = parseTableArenaIdentity(table);
    if (!userId) throw new Error('Authentication Required');
  } catch {
    return {
      allowed: false,
      reason: 'check_failed',
      clubId: accessScopeId,
      observerShowCards: false,
    };
  }
  if (seatResult.error) {
    return {
      allowed: false,
      reason: 'check_failed',
      clubId: accessScopeId,
      observerShowCards: false,
    };
  }
  if (seatResult.data) {
    return { allowed: true, reason: 'seated', clubId: accessScopeId, observerShowCards };
  }

  if (arena.kind === 'diamond_arena') {
    return table.restrict_observers === true
      ? { allowed: false, reason: 'observers_restricted', clubId, observerShowCards: false }
      : { allowed: true, reason: 'diamond_member', clubId, observerShowCards };
  }

  /*
   * The lobby's ownership rule is union-aware: a member of Shark can see a
   * Midway-owned table even though that durable row names Midway's shell club
   * as club_id. Resolve the table owner's authoritative scope and the viewer's
   * complete active membership set only after proving the viewer is not
   * seated. That keeps a seated reconnect independent from both observer
   * lookups while retaining fail-closed, uncached authorization for observers.
   */
  const [membershipsResult, scopeResult] = await Promise.all([
    supabase
      .from('club_members')
      .select('club_id')
      .eq('user_id', userId)
      .in('status', ['active', 'approved']),
    supabase.rpc('fn_club_scope_ids', { p_club_id: accessScopeId }),
  ]);

  if (membershipsResult.error || scopeResult.error) {
    return {
      allowed: false,
      reason: 'check_failed',
      clubId: accessScopeId,
      observerShowCards: false,
    };
  }
  const scopeIds = new Set(
    Array.isArray(scopeResult.data)
      ? scopeResult.data.filter((id): id is string => typeof id === 'string')
      : []
  );
  const isMember = (membershipsResult.data ?? []).some(
    (membership) => typeof membership.club_id === 'string' && scopeIds.has(membership.club_id)
  );
  if (isMember && table.restrict_observers === true) {
    return {
      allowed: false,
      reason: 'observers_restricted',
      clubId: accessScopeId,
      observerShowCards: false,
    };
  }
  if (isMember) {
    return { allowed: true, reason: 'club_member', clubId: accessScopeId, observerShowCards };
  }
  return {
    allowed: false,
    reason: 'membership_required',
    clubId: accessScopeId,
    observerShowCards: false,
  };
}
