import { supabase } from '../services/supabase.js';

export interface CashAddonReceipt {
  amount: number;
  appliedToSeat: boolean;
  stack: number;
  pending: number;
  queued: boolean;
}

/** Read an existing operation without issuing a second funding command. */
export async function readCashAddonReceipt(
  tableId: string,
  userId: string,
  key: string
): Promise<CashAddonReceipt | null> {
  const { data, error } = await supabase.rpc('fn_cash_addon_receipt', {
    p_table_id: tableId,
    p_user_id: userId,
    p_idempotency_key: key,
  });
  if (error) throw error;
  if (data === null) return null;
  return parseReceipt(data, tableId, userId);
}

export async function readDiamondAddonReceipt(
  tableId: string,
  userId: string,
  requestId: string
): Promise<CashAddonReceipt | null> {
  const { data, error } = await supabase.rpc('fn_diamond_top_up_receipt', {
    p_table_id: tableId,
    p_user_id: userId,
    p_request_id: requestId,
  });
  if (error) throw error;
  if (data === null) return null;
  return parseReceipt(data, tableId, userId);
}

function parseReceipt(data: unknown, tableId: string, userId: string): CashAddonReceipt {
  const receipt = data as Record<string, unknown>;
  const amount = Number(receipt?.amount);
  const stack = Number(receipt?.stack);
  const pending = Number(receipt?.pending);
  if (
    !receipt ||
    receipt.table_id !== tableId ||
    receipt.user_id !== userId ||
    typeof receipt.applied_to_seat !== 'boolean' ||
    typeof receipt.queued !== 'boolean' ||
    !['number', 'string'].includes(typeof receipt.amount) ||
    !['number', 'string'].includes(typeof receipt.stack) ||
    !['number', 'string'].includes(typeof receipt.pending) ||
    String(receipt.amount).trim() === '' ||
    String(receipt.stack).trim() === '' ||
    String(receipt.pending).trim() === '' ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isFinite(stack) ||
    stack < 0 ||
    !Number.isFinite(pending) ||
    pending < 0
  )
    throw new Error('Malformed cash add-on receipt');
  return { amount, appliedToSeat: receipt.applied_to_seat, stack, pending, queued: receipt.queued };
}
