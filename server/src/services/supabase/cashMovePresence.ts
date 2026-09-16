import { supabase } from './client.js';

/** Read-only proof that a transfer created the exact currently seated occupancy. */
export interface CashMoveArrival {
  move_id: string;
  player_id: string;
  from_table_id: string;
  to_table_id: string;
  source_occupancy_id: string;
  destination_occupancy_id: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

export async function readCashMoveArrivals(
  tableId: string,
  occupancyIds: readonly string[]
): Promise<CashMoveArrival[]> {
  if (occupancyIds.length === 0) return [];
  if (!isUuid(tableId) || occupancyIds.length > 64 || occupancyIds.some((id) => !isUuid(id)))
    throw new Error('Seat move arrival scope is invalid');
  const requested = new Set(occupancyIds);
  const { data, error } = await supabase.rpc('fn_cash_seat_move_arrivals', {
    p_table_id: tableId,
    p_occupancy_ids: [...requested],
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Seat move arrivals were not confirmed');
  const seen = new Set<string>();
  for (const row of data) {
    if (
      !row ||
      !isUuid(row.move_id) ||
      !isUuid(row.player_id) ||
      !isUuid(row.from_table_id) ||
      row.from_table_id === tableId ||
      row.to_table_id !== tableId ||
      !isUuid(row.source_occupancy_id) ||
      !isUuid(row.destination_occupancy_id) ||
      row.source_occupancy_id === row.destination_occupancy_id ||
      !requested.has(row.destination_occupancy_id) ||
      seen.has(row.destination_occupancy_id)
    )
      throw new Error('Seat move arrival does not prove the requested occupancy');
    seen.add(row.destination_occupancy_id);
  }
  return data as CashMoveArrival[];
}
