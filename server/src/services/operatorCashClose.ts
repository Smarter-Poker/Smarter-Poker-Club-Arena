import { supabase } from './supabase/client.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Read-only authority for a nonplaying dealer, independently repeated at startup. */
export async function readPendingOperatorCashClose(tableId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('fn_ca_operator_floor_state', { p_table_id: tableId });
  if (
    error ||
    !data ||
    Array.isArray(data) ||
    typeof data !== 'object' ||
    !Object.hasOwn(data, 'close') ||
    !Object.hasOwn(data, 'hold')
  )
    throw new Error('operator_cash_close_authority_unknown');
  if (data.close === null) return null;
  const close = data.close;
  if (
    !close ||
    close.table_id !== tableId ||
    close.status !== 'pending' ||
    typeof close.operation_id !== 'string' ||
    !UUID.test(close.operation_id)
  )
    throw new Error('operator_cash_close_authority_unknown');
  return close.operation_id;
}
