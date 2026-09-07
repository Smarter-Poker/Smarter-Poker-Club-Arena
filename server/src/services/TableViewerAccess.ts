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
  // Both reads depend only on the requested table and authenticated player.
  // A verified current seat is already sufficient access; membership matters
  // only for observers and must not delay or reject a seated reconnect.
  const [{ data: table, error: tableError }, seatResult] = await Promise.all([
    supabase.from('tables').select('club_id, restrict_observers').eq('id', tableId).maybeSingle(),
    supabase
      .from('table_seats')
      .select('id')
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .limit(1)
      .maybeSingle(),
  ]);

  if (tableError) return { allowed: false, reason: 'check_failed', clubId: null };
  if (!table) return { allowed: false, reason: 'table_not_found', clubId: null };

  const clubId = typeof table.club_id === 'string' ? table.club_id : null;
  if (!clubId) return { allowed: false, reason: 'check_failed', clubId: null };
  if (seatResult.error) return { allowed: false, reason: 'check_failed', clubId };
  if (seatResult.data) return { allowed: true, reason: 'seated', clubId };

  const memberResult = await supabase
    .from('club_members')
    .select('user_id')
    .eq('club_id', clubId)
    .eq('user_id', userId)
    .in('status', ['active', 'approved'])
    .limit(1)
    .maybeSingle();

  if (memberResult.error) return { allowed: false, reason: 'check_failed', clubId };
  if (memberResult.data && table.restrict_observers === true) {
    return { allowed: false, reason: 'observers_restricted', clubId };
  }
  if (memberResult.data) return { allowed: true, reason: 'club_member', clubId };
  return { allowed: false, reason: 'membership_required', clubId };
}
