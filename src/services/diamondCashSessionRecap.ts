import { supabase } from '../lib/supabase';

/** The original seat generation is resolved by SeatLeaveIntent before leave. */
export interface DiamondRecapTarget {
  tableId: string;
  occupancyId: string;
  userId: string;
  notify: boolean;
}

export interface DiamondCashSessionRecap {
  custodyId: string;
  status: 'pending' | 'settled';
  startedAt: number;
  endedAt: number | null;
  totalBuyIn: number;
  profitLoss: number | null;
  handsPlayed: number | null;
  handsWon: number | null;
  vpipPercent: number | null;
  peakStack: number | null;
  totalRebuys: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalCount = (value: unknown): value is number | null =>
  value === null || nonnegativeInteger(value);

/** Never turn an unreadable record, another seat, or missing facts into zero. */
export function parseDiamondCashSessionRecap(
  value: unknown,
  target: DiamondRecapTarget
): DiamondCashSessionRecap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const startedAt = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN;
  const endedAt =
    row.released_at === null
      ? null
      : typeof row.released_at === 'string'
        ? Date.parse(row.released_at)
        : NaN;
  if (
    row.asset !== 'diamonds' ||
    row.user_id !== target.userId ||
    row.table_id !== target.tableId ||
    row.occupancy_id !== target.occupancyId ||
    typeof row.custody_id !== 'string' ||
    !UUID.test(row.custody_id) ||
    (row.status !== 'settled' && row.status !== 'pending') ||
    !Number.isFinite(startedAt) ||
    startedAt <= 0 ||
    !nonnegativeInteger(row.total_buy_in) ||
    row.total_buy_in <= 0 ||
    !nonnegativeInteger(row.total_rebuys) ||
    !optionalCount(row.hands_played) ||
    !optionalCount(row.hands_won) ||
    !optionalCount(row.peak_stack) ||
    !(
      row.vpip_percent === null ||
      (nonnegativeInteger(row.vpip_percent) && row.vpip_percent <= 100)
    ) ||
    (typeof row.hands_played === 'number' &&
      typeof row.hands_won === 'number' &&
      row.hands_won > row.hands_played)
  )
    return null;
  if (row.status === 'settled') {
    if (
      endedAt === null ||
      !Number.isFinite(endedAt) ||
      endedAt < startedAt ||
      !nonnegativeInteger(row.chips_returned) ||
      !nonnegativeInteger(row.jackpot_awards) ||
      typeof row.profit_loss !== 'number' ||
      !Number.isSafeInteger(row.profit_loss) ||
      row.profit_loss !== row.chips_returned + row.jackpot_awards - row.total_buy_in ||
      (target.notify && row.notification_id !== row.custody_id)
    )
      return null;
  } else if (endedAt !== null || row.profit_loss !== null) return null;
  return {
    custodyId: row.custody_id,
    status: row.status,
    startedAt,
    endedAt,
    totalBuyIn: row.total_buy_in,
    profitLoss: row.profit_loss as number | null,
    handsPlayed: row.hands_played as number | null,
    handsWon: row.hands_won as number | null,
    vpipPercent: row.vpip_percent as number | null,
    peakStack: row.peak_stack as number | null,
    totalRebuys: row.total_rebuys,
  };
}

/** One owning request supplies both the card and its idempotent notification. */
export async function readDiamondCashSessionRecap(
  target: DiamondRecapTarget
): Promise<DiamondCashSessionRecap> {
  if (!UUID.test(target.tableId) || !UUID.test(target.occupancyId) || !UUID.test(target.userId)) {
    throw new Error('The Original Session Could Not Be Identified');
  }
  const { data, error } = await supabase.rpc(
    target.notify ? 'fn_notify_my_diamond_cash_session_recap' : 'fn_my_diamond_cash_session_recap',
    { p_table_id: target.tableId, p_occupancy_id: target.occupancyId }
  );
  const recap = error ? null : parseDiamondCashSessionRecap(data, target);
  if (!recap) throw new Error('Could Not Read The Recorded Session');
  return recap;
}
