import { supabase } from './supabase.js';
import type { TableViewerAccess } from './TableViewerAccess.js';

export interface TableConnectionAccess extends TableViewerAccess {
  banned: boolean;
  ipRestricted: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_REASONS = new Set(['seated', 'club_member', 'diamond_member']);
const DENIED_REASONS = new Set([
  'membership_required',
  'observers_restricted',
  'table_not_found',
  'check_failed',
]);

/** One database snapshot for every durable connection gate; no cached grants. */
export async function authorizeTableConnection(
  tableId: string,
  userId: string
): Promise<TableConnectionAccess> {
  const refused: TableConnectionAccess = {
    allowed: false,
    reason: 'check_failed',
    clubId: null,
    banned: false,
    ipRestricted: false,
  };
  if (!UUID.test(tableId) || !UUID.test(userId)) return refused;
  try {
    const { data, error } = await supabase.rpc('fn_ca_engine_table_connection_access', {
      p_table_id: tableId,
      p_user_id: userId,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) return refused;
    const row = data as Record<string, unknown>;
    if (
      row.table_id !== tableId ||
      row.user_id !== userId ||
      typeof row.allowed !== 'boolean' ||
      typeof row.reason !== 'string' ||
      typeof row.banned !== 'boolean' ||
      typeof row.ip_restricted !== 'boolean' ||
      !(row.scope_id === null || (typeof row.scope_id === 'string' && UUID.test(row.scope_id))) ||
      !(row.allowed ? ALLOWED_REASONS : DENIED_REASONS).has(row.reason) ||
      (row.allowed && row.scope_id === null)
    )
      return refused;
    return {
      allowed: row.allowed,
      reason: row.reason as TableViewerAccess['reason'],
      clubId: row.scope_id as string | null,
      banned: row.banned,
      ipRestricted: row.ip_restricted,
    };
  } catch {
    return refused;
  }
}
