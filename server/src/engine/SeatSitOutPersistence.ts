import { supabase } from '../services/supabase/client.js';

export interface LightningSitOutChanged {
  type: 'lightning_sitout_changed';
  pool_session_id: string;
  player_id: string;
  occupancy_id: string;
  sitting_out: boolean;
  sit_out_at: string | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owns only explicit DisconnectEngine transitions; no retries or background work. */
export class SeatSitOutPersistence {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly emit: (room: string, event: LightningSitOutChanged) => void) {}

  persist(
    tableId: string,
    playerId: string,
    occupancyId: string,
    sittingOut: boolean
  ): Promise<void> {
    // Keep different devices' out/back writes AND publication in transition order.
    const key = `${tableId}:${playerId}:${occupancyId}`;
    const prior = this.pending.get(key) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(async () => {
        const { data: seat, error } = await supabase
          .from('table_seats')
          .update({ is_sitting_out: sittingOut })
          .eq('table_id', tableId)
          .eq('user_id', playerId)
          .eq('occupancy_id', occupancyId)
          .is('left_at', null)
          .select(
            'id,table_id,user_id,occupancy_id,is_sitting_out,sit_out_at,left_at,leave_pending'
          )
          .maybeSingle();
        if (error) throw new Error(`persist is_sitting_out=${sittingOut} failed: ${error.message}`);
        if (
          !seat ||
          seat.table_id !== tableId ||
          seat.user_id !== playerId ||
          seat.occupancy_id !== occupancyId ||
          seat.left_at !== null ||
          seat.leave_pending === true ||
          seat.is_sitting_out !== sittingOut ||
          !uuid.test(seat.id) ||
          !uuid.test(occupancyId)
        )
          return;
        if (
          sittingOut
            ? typeof seat.sit_out_at !== 'string' || !Number.isFinite(Date.parse(seat.sit_out_at))
            : seat.sit_out_at !== null
        )
          return;

        // Resolve the room from this exact persisted anchor, never a replacement pool.
        const { data: pool, error: poolError } = await supabase
          .from('lightning_pool_session')
          .select('id,player_id,anchor_seat_id,exited_at,state')
          .eq('anchor_seat_id', seat.id)
          .eq('player_id', playerId)
          .is('exited_at', null)
          .maybeSingle();
        if (poolError) throw new Error(`read sit-out Lightning room failed: ${poolError.message}`);
        if (
          !pool ||
          !uuid.test(pool.id) ||
          pool.player_id !== playerId ||
          pool.anchor_seat_id !== seat.id ||
          pool.exited_at !== null ||
          pool.state !== 'active'
        )
          return;
        this.emit(pool.id, {
          type: 'lightning_sitout_changed',
          pool_session_id: pool.id,
          player_id: playerId,
          occupancy_id: occupancyId,
          sitting_out: sittingOut,
          sit_out_at: seat.sit_out_at,
        });
      });
    this.pending.set(key, current);
    const cleanup = () => {
      if (this.pending.get(key) === current) this.pending.delete(key);
    };
    void current.then(cleanup).catch(cleanup);
    return current;
  }
}
