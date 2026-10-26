import { createHash } from 'node:crypto';
import { supabase, readClubChipBalances } from '../services/supabase.js';
import { cappedAutoTopUp, horseAutoTopUpWanted } from '../services/HorseTopUpStyle.js';
import { requestLightningTopUp } from './LightningTopUp.js';

/** A horse's input device supplies the same original request a browser submits.
 * Seat Auto Top Up is the intent; cluster auto-rebuy configuration is separate.
 *
 * EVERY HORSE AT ONCE (2026-10-26). Each horse's request is its own: its own
 * seat, its own session, its own wallet and its own idempotency key, exactly
 * the request a person's browser sends for their own seat. They used to be
 * sent one horse after another, so the last horse at a full ring waited on
 * every other horse's three round trips. They are sent together now, through
 * the same path; one horse's failure no longer stops another's request, and
 * the first failure is still reported to the caller. */
export async function requestLightningHorseTopUps(boundary: {
  handId: string;
  clusterId: string;
  horsePlayers?: Array<{ playerId: string }>;
}) {
  const settled = await Promise.allSettled(
    (boundary.horsePlayers ?? []).map(({ playerId }) => requestOneHorseTopUp(boundary, playerId))
  );
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
}

async function requestOneHorseTopUp(
  boundary: { handId: string; clusterId: string },
  playerId: string
): Promise<void> {
  const { data: seat, error } = await supabase
    .from('table_seats')
    .select(
      'table_id,stack,auto_rebuy,club_id,is_sitting_out,leave_pending,tables!table_seats_table_id_fkey!inner(cluster_id,game_variant,big_blind,min_buy_in,max_buy_in)'
    )
    .eq('user_id', playerId)
    .is('left_at', null)
    .eq('tables.cluster_id', boundary.clusterId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!seat || seat.is_sitting_out || seat.leave_pending) return;
  const table = (Array.isArray(seat.tables) ? seat.tables[0] : seat.tables) as unknown as Record<
    string,
    unknown
  >;
  const own = { autoTopUp: seat.auto_rebuy === true, clubId: seat.club_id };
  if (!own.autoTopUp || !own.clubId) return;
  const wanted = horseAutoTopUpWanted({
    userId: playerId,
    variant: table.game_variant,
    stack: Number(seat.stack),
    maxBuyIn: Number(table.max_buy_in),
  });
  if (!(wanted > 0)) return;
  // The current Classic batch reader also owns Classic flag allocation;
  // Lightning only reads its existing opt-in. Reuse the anchor read above
  // and fetch funding only when this stack actually needs an add-on.
  const [session, balances] = await Promise.all([
    supabase
      .from('cash_player_session')
      .select('baseline')
      .eq('table_id', seat.table_id)
      .eq('player_id', playerId)
      .is('closed_at', null)
      .order('opened_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    readClubChipBalances(own.clubId, [playerId]),
  ]);
  if (session.error) throw session.error;
  if (!session.data) return;
  const invested = Number(session.data.baseline);
  if (!Number.isFinite(invested) || invested < 0) return;
  const wallet = balances.get(playerId);
  const amount = cappedAutoTopUp({
    userId: playerId,
    wanted,
    wallet,
    investedThisTable: invested,
    bigBlind: Number(table.big_blind),
    minBuyIn: Number(table.min_buy_in),
    maxBuyIn: Number(table.max_buy_in),
  });
  if (!(amount > 0)) return;
  const key = createHash('sha256')
    .update(`lightning-top-up:${boundary.handId}:${playerId}`)
    .digest('hex');
  await requestLightningTopUp(seat.table_id, playerId, key, amount);
}
