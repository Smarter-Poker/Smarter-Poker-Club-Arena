import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { readDiamondCashSessionRecap } from '../services/diamondCashSessionRecap';
import { reportError } from '../utils/errorReporter';

export interface TopUpAccountingFacts {
  totalBuyIn: number;
  totalRebuys?: number;
}

export async function readTopUpAccounting(
  tableId: string,
  userId: string,
  asset: 'chips' | 'diamonds'
): Promise<TopUpAccountingFacts | null> {
  if (asset === 'chips') {
    const { data, error } = await supabase.rpc('fn_my_cash_session_baseline', {
      p_table_id: tableId,
    });
    const total = Number(data);
    if (error) throw error;
    if (data === null || !Number.isFinite(total) || total <= 0)
      throw new Error('Could Not Read Recorded Table Funding');
    return { totalBuyIn: total };
  }
  const seat = await supabase
    .from('table_seats')
    .select('occupancy_id')
    .eq('table_id', tableId)
    .eq('user_id', userId)
    .is('left_at', null)
    .maybeSingle();
  if (seat.error) throw seat.error;
  if (!seat.data) return null;
  return readDiamondCashSessionRecap({
    tableId,
    userId,
    occupancyId: seat.data.occupancy_id,
    notify: false,
  });
}

/** Restore recorded funding at seat entry, reconnect and committed funding events. No polling. */
export function useTopUpAccounting({
  tableId,
  userId,
  asset,
  tableEvent,
  seat,
  enabled,
  connected,
  revision,
  event,
  onFunding,
  read = readTopUpAccounting,
}: {
  tableId: string | null | undefined;
  asset: 'chips' | 'diamonds' | null;
  tableEvent: Record<string, unknown> | null;
  userId: string | null | undefined;
  seat: number;
  enabled: boolean;
  connected: boolean;
  revision: number;
  event: Record<string, unknown> | null;
  onFunding: (facts: TopUpAccountingFacts, isCurrent: () => boolean) => void;
  read?: typeof readTopUpAccounting;
}) {
  const key = `${asset}/${tableId}/${userId}/${seat}`;
  const owner = useRef({
    key,
    enabled,
    version: -1,
    connected: false,
    lastEnabled: false,
    generation: 0,
    seen: new Set<string>(),
    tableEvent: null as Record<string, unknown> | null,
  });
  if (owner.current.key !== key)
    owner.current = {
      key,
      enabled,
      version: -1,
      connected: false,
      lastEnabled: false,
      generation: owner.current.generation + 1,
      seen: new Set(),
      tableEvent: null,
    };
  owner.current.enabled = enabled;
  const callback = useRef(onFunding);
  callback.current = onFunding;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    owner.current.version = -1;
    return () => {
      mounted.current = false;
      owner.current.generation++;
    };
  }, []);
  const receipt =
    event?.kind === 'diamond_top_up_completed' &&
    event.table_id === tableId &&
    event.user_id === userId &&
    typeof event.request_id === 'string'
      ? event.request_id
      : null;
  const landed =
    tableEvent?.type === 'add_on_applied' &&
    tableEvent.table_id === tableId &&
    tableEvent.seat === seat
      ? tableEvent
      : null;
  useEffect(() => {
    const state = owner.current;
    const changed =
      state.version !== revision || state.connected !== connected || state.lastEnabled !== enabled;
    const fresh =
      (receipt !== null && !state.seen.has(receipt)) ||
      (landed !== null && landed !== state.tableEvent);
    if (landed) state.tableEvent = landed;
    state.version = revision;
    state.connected = connected;
    state.lastEnabled = enabled;
    if (receipt) state.seen.add(receipt);
    if (!changed && !fresh) return;
    if (!enabled || !connected || !asset || !tableId || !userId || userId === 'guest') return;
    const generation = ++state.generation;
    const current = () =>
      mounted.current &&
      owner.current === state &&
      state.enabled &&
      state.generation === generation;
    void read(tableId, userId, asset)
      .then((facts) => {
        if (current() && facts) callback.current(facts, current);
      })
      .catch((error) => {
        if (current()) reportError(error, 'TablePage.top_up_accounting_read_failed');
      });
  }, [key, tableId, userId, asset, seat, enabled, connected, revision, receipt, landed, read]);
}
