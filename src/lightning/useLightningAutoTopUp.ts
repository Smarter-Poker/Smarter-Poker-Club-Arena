import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { cashBuyInRange } from '../lib/cashBuyIn';
import { parseTableArenaIdentity } from '../../server/src/domain/ArenaContext';
import { reportError } from '../utils/errorReporter';
import { parseLightningMySession, type LightningPoolEntry } from './lightningSession';

const uuid = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);

/** A settled receipt is a reason to ask, never permission to bypass a live hand. */
export async function readLightningTopUp(
  cluster: string,
  pool: string,
  user: string,
  allowPending = false
) {
  const own = await supabase.rpc('fn_lightning_my_session', { p_cluster_id: cluster });
  if (own.error) throw own.error;
  const raw = Array.isArray(own.data) ? own.data[0] : own.data;
  if (!raw || typeof raw.in_hand !== 'boolean' || (raw.in_hand && !allowPending)) return null;
  const session = parseLightningMySession(raw);
  if (
    session.poolSessionId !== pool ||
    session.state !== 'active' ||
    !session.anchorTableId ||
    !session.occupancyId ||
    session.seatNumber === null ||
    session.stack === null ||
    session.stack < 0
  )
    return null;
  const seat = await supabase
    .from('table_seats')
    .select('table_id,user_id,seat_number,occupancy_id,left_at,leave_pending,is_sitting_out')
    .eq('table_id', session.anchorTableId)
    .eq('user_id', user)
    .eq('seat_number', session.seatNumber)
    .eq('occupancy_id', session.occupancyId)
    .is('left_at', null)
    .maybeSingle();
  if (seat.error) throw seat.error;
  const row = seat.data;
  if (
    !row ||
    row.table_id !== session.anchorTableId ||
    row.user_id !== user ||
    row.seat_number !== session.seatNumber ||
    row.occupancy_id !== session.occupancyId ||
    row.left_at !== null ||
    row.leave_pending !== false ||
    row.is_sitting_out !== false
  )
    return null;
  const table = await supabase
    .from('tables')
    .select(
      'id,cluster_id,tournament_id,big_blind,min_buy_in,max_buy_in,club_id,union_id,arena:clubs!fk_tables_club_id(id,asset,is_platform,union_id)'
    )
    .eq('id', session.anchorTableId)
    .maybeSingle();
  if (table.error) throw table.error;
  const t = table.data;
  if (
    !t ||
    t.id !== session.anchorTableId ||
    t.cluster_id !== cluster ||
    t.tournament_id !== null ||
    parseTableArenaIdentity(t).asset !== 'chips'
  )
    return null;
  const maximum = cashBuyInRange(t).max;
  if (!Number.isFinite(maximum) || maximum <= 0) return null;
  return { stack: session.stack, maximum };
}

/** Opt-in normal funding, once per actual post-commit receipt. No snapshot trigger or retry. */
export function useLightningAutoTopUp({
  room,
  userId,
  enabled,
  originalIntentReady = false,
  balance,
  event,
  add,
  onAdded,
  read = readLightningTopUp,
}: {
  room: LightningPoolEntry | null;
  userId: string | null | undefined;
  enabled: boolean;
  originalIntentReady?: boolean;
  balance: number | null;
  event: Record<string, unknown> | null;
  add: (
    amount: number,
    opId: string,
    isCurrent: () => boolean,
    isScopeCurrent: () => boolean
  ) => Promise<boolean>;
  onAdded?: (amount: number) => void;
  read?: typeof readLightningTopUp;
}) {
  const key =
    room && userId && userId !== 'guest'
      ? `${room.poolSessionId}/${room.clusterId}/${userId}`
      : null;
  const state = useRef({
    key,
    enabled,
    originalIntentReady,
    generation: 0,
    ignored: event,
    seen: new Set<string>(),
    busy: false,
  });
  if (state.current.key !== key) {
    state.current = {
      key,
      enabled,
      originalIntentReady,
      generation: state.current.generation + 1,
      ignored: event,
      seen: new Set(),
      busy: false,
    };
  } else if (
    state.current.enabled !== enabled ||
    state.current.originalIntentReady !== originalIntentReady
  ) {
    state.current.enabled = enabled;
    state.current.originalIntentReady = originalIntentReady;
    state.current.generation++;
    state.current.ignored = event;
  }
  const latest = useRef({ balance, add, onAdded });
  latest.current = { balance, add, onAdded };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      state.current.generation++;
    };
  }, []);
  useEffect(() => {
    const owner = state.current;
    if (
      !key ||
      !room ||
      !userId ||
      !enabled ||
      !event ||
      event === owner.ignored ||
      event.type !== 'hand_history_saved' ||
      event.replayed === true ||
      event.pool_session_id !== room.poolSessionId ||
      event.table_id !== room.poolSessionId ||
      event.player_id !== userId ||
      !uuid(event.hand_id) ||
      !uuid(event.lightning_hand_id) ||
      owner.seen.has(event.hand_id) ||
      owner.busy
    )
      return;
    owner.seen.add(event.hand_id);
    owner.busy = true;
    const generation = owner.generation;
    const current = () =>
      mounted.current &&
      state.current === owner &&
      owner.key === key &&
      owner.enabled &&
      owner.generation === generation;
    void (async () => {
      const target = await read(room.clusterId, room.poolSessionId, userId, originalIntentReady);
      if (!current() || !target) return;
      const available = latest.current.balance;
      if (available === null || !Number.isFinite(available) || available <= 0) return;
      const amount = Math.round(Math.min(target.maximum - target.stack, available) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) return;
      // The normal handler revalidates the own anchor and the database retains every money guard.
      const sameScope = () => mounted.current && state.current === owner && owner.key === key;
      const accepted = await latest.current.add(amount, crypto.randomUUID(), current, sameScope);
      if (accepted && current()) latest.current.onAdded?.(amount);
    })()
      .catch((error) => reportError(error, 'TablePage.lightning_auto_topup_failed'))
      .finally(() => {
        owner.busy = false;
      });
  }, [
    event,
    key,
    room?.poolSessionId,
    room?.clusterId,
    userId,
    enabled,
    originalIntentReady,
    read,
  ]);
}
