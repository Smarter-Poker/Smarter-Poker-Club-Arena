import { createHash } from 'node:crypto';
import { supabase, readHorseTopUpSeat, readClubChipBalances } from '../services/supabase.js';
import { cappedAutoTopUp, horseAutoTopUpWanted } from '../services/HorseTopUpStyle.js';
import { requestLightningTopUp } from './LightningTopUp.js';

/** A horse's input device supplies the same original request a browser submits.
 * Seat Auto Top Up is the intent; cluster auto-rebuy configuration is separate. */
export async function requestLightningHorseTopUps(boundary: {
  handId: string;
  clusterId: string;
  horsePlayers?: Array<{ playerId: string }>;
}) {
  for (const { playerId } of boundary.horsePlayers ?? []) {
    const { data: seat, error } = await supabase
      .from('table_seats')
      .select(
        'table_id,stack,tables!inner(cluster_id,game_variant,big_blind,min_buy_in,max_buy_in)'
      )
      .eq('user_id', playerId)
      .is('left_at', null)
      .eq('tables.cluster_id', boundary.clusterId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!seat) continue;
    const table = (Array.isArray(seat.tables) ? seat.tables[0] : seat.tables) as unknown as Record<
      string,
      unknown
    >;
    const own = await readHorseTopUpSeat(seat.table_id, playerId);
    if (!own?.autoTopUp || !own.clubId) continue;
    const wanted = horseAutoTopUpWanted({
      userId: playerId,
      variant: table.game_variant,
      stack: Number(seat.stack),
      maxBuyIn: Number(table.max_buy_in),
    });
    if (!(wanted > 0)) continue;
    const wallet = (await readClubChipBalances(own.clubId, [playerId])).get(playerId);
    const amount = cappedAutoTopUp({
      userId: playerId,
      wanted,
      wallet,
      investedThisTable: own.invested,
      bigBlind: Number(table.big_blind),
      minBuyIn: Number(table.min_buy_in),
      maxBuyIn: Number(table.max_buy_in),
    });
    if (!(amount > 0)) continue;
    const key = createHash('sha256')
      .update(`lightning-top-up:${boundary.handId}:${playerId}`)
      .digest('hex');
    await requestLightningTopUp(seat.table_id, playerId, key, amount);
  }
}
