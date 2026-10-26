import { supabase } from '../lib/supabase';
import { isUUID } from '../utils/clubIdResolver';
import type { LightningAnchorSeat, LightningMySession } from './lightningSession';

/** Stop Playing can close an idle pool before its anchor has cashed out. */
export async function fetchStoppedLightningAnchor(
  session: LightningMySession,
  userId: string
): Promise<LightningAnchorSeat | null> {
  if (!session.seatTableId || session.seatNumber === null) return null;
  const { data, error } = await supabase
    .from('table_seats')
    .select('table_id,user_id,seat_number,occupancy_id,left_at')
    .eq('table_id', session.seatTableId)
    .eq('user_id', userId)
    .eq('seat_number', session.seatNumber)
    .is('left_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (
    data.table_id !== session.seatTableId ||
    data.user_id !== userId ||
    data.seat_number !== session.seatNumber ||
    data.left_at !== null ||
    typeof data.occupancy_id !== 'string' ||
    !isUUID(data.occupancy_id)
  )
    throw new Error('Lightning Leave Anchor Unverified');
  return {
    anchorTableId: data.table_id,
    seatNumber: data.seat_number,
    occupancyId: data.occupancy_id,
  };
}
