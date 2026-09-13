import { supabase } from './supabase/client.js';
import { raiseFinancialAlert } from './financialAlerts.js';
import { describeError } from './errorReporter.js';

export interface DiamondReservation {
  userId: string;
  purpose: 'cash_seat' | 'tournament_entry';
  targetId: string;
  entryKey: string;
  amount: number;
  requestId: string;
}
export interface DiamondCustodyReceipt {
  success: true;
  custody_id: string;
  request_id: string;
  amount: number;
  available_balance: number;
  custody_balance: number;
  journal_id: string | null;
  debt_settled?: number;
}
function receipt(
  value: unknown,
  requestId: string,
  operation: 'reserve' | 'release'
): DiamondCustodyReceipt {
  if (!value || typeof value !== 'object') throw new Error('Missing Diamond Custody Receipt');
  const v = value as Record<string, unknown>;
  if (
    v.success !== true ||
    v.request_id !== requestId ||
    typeof v.custody_id !== 'string' ||
    !v.custody_id ||
    (operation === 'release' && v.amount === 0
      ? v.journal_id !== null
      : typeof v.journal_id !== 'string' || !v.journal_id) ||
    ![v.amount, v.available_balance, v.custody_balance].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0
    )
  )
    throw new Error('Invalid Diamond Custody Receipt');
  if (
    (operation === 'reserve' && Number(v.amount) === 0) ||
    Number(v.amount) > 2147483647 ||
    (v.debt_settled !== undefined &&
      (!Number.isSafeInteger(v.debt_settled) ||
        Number(v.debt_settled) < 0 ||
        Number(v.debt_settled) > Number(v.amount)))
  )
    throw new Error('Invalid Diamond Custody Receipt');
  return value as DiamondCustodyReceipt;
}
/** A failed response can follow a committed transaction. Report uncertainty,
 * preserve the original error and identity, and never issue a compensating write. */
async function verifiedCustodyCall<T>(
  operation: 'reserve' | 'release',
  context: Record<string, unknown>,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    await raiseFinancialAlert(
      'critical',
      `DiamondCustody.${operation}_unverified`,
      'Diamond Custody Did Not Return A Verified Receipt',
      { ...context, asset: 'diamonds', operation, error: describeError(error) }
    );
    throw error;
  }
}
/** Funding contract for shared engine integration. Does not enable Diamond tables. */
export async function reserveDiamondEntry(
  input: DiamondReservation
): Promise<DiamondCustodyReceipt> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 2147483647)
    throw new Error('Invalid Diamond Amount');
  return verifiedCustodyCall(
    'reserve',
    { userId: input.userId, targetId: input.targetId, requestId: input.requestId },
    async () => {
      const { data, error } = await supabase.rpc('fn_poker_diamond_reserve', {
        p_user_id: input.userId,
        p_purpose: input.purpose,
        p_target_id: input.targetId,
        p_entry_key: input.entryKey,
        p_amount: input.amount,
        p_request_id: input.requestId,
      });
      if (error) throw new Error(error.message || 'Diamond Reservation Failed');
      const result = receipt(data, input.requestId, 'reserve');
      if (result.amount !== input.amount) throw new Error('Diamond Reservation Amount Mismatch');
      if (result.custody_balance !== input.amount)
        throw new Error('Diamond Reservation Balance Mismatch');
      return result;
    }
  );
}
/** Stable requestId must be retained across network failures; no compensating credit. */
export async function releaseDiamondEntry(
  custodyId: string,
  requestId: string
): Promise<DiamondCustodyReceipt> {
  return verifiedCustodyCall('release', { custodyId, requestId }, async () => {
    const { data, error } = await supabase.rpc('fn_poker_diamond_release', {
      p_custody_id: custodyId,
      p_request_id: requestId,
    });
    if (error) throw new Error(error.message || 'Diamond Release Failed');
    const result = receipt(data, requestId, 'release');
    if (result.custody_id !== custodyId) throw new Error('Diamond Release Custody Mismatch');
    if (result.custody_balance !== 0) throw new Error('Diamond Release Balance Mismatch');
    return result;
  });
}
