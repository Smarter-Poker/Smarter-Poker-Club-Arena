import { supabase } from '../lib/supabase';

export interface SatelliteQualifierResult {
  qualified: boolean;
  targetId: string;
  position: number | null;
  amount: number;
  deliveryKind: 'seat' | 'ticket' | 'cash' | 'remainder' | 'none';
}

/** A named event is the trigger; this signed-in receipt also survives reconnect. */
export async function readMySatelliteQualifierResult(
  tournamentId: string,
  userId: string
): Promise<SatelliteQualifierResult | null> {
  const { data, error } = await supabase.rpc('fn_get_my_satellite_qualifier_result', {
    p_tournament_id: tournamentId,
  });
  if (error) throw error;
  if (data === null) return null; // Legacy receipts retain their original result path.
  if (
    !data ||
    data.ok !== true ||
    data.receipt_version !== 3 ||
    data.tournament_id !== tournamentId ||
    data.user_id !== userId ||
    typeof data.target_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.target_id) ||
    typeof data.qualified !== 'boolean' ||
    (data.qualified
      ? data.position !== null
      : !Number.isSafeInteger(data.position) || data.position < 1) ||
    typeof data.amount !== 'number' ||
    !Number.isFinite(data.amount) ||
    data.amount < 0 ||
    !['seat', 'ticket', 'cash', 'remainder', 'none'].includes(data.delivery_kind) ||
    (data.qualified && !['seat', 'ticket', 'cash'].includes(data.delivery_kind)) ||
    typeof data.settled_at !== 'string' ||
    !Number.isFinite(Date.parse(data.settled_at))
  ) {
    throw new Error('Satellite qualifier result is unproven');
  }
  return {
    qualified: data.qualified,
    targetId: data.target_id,
    position: data.position,
    amount: data.amount,
    deliveryKind: data.delivery_kind,
  };
}
