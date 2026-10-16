import { useEffect, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface ServerCashSessionProfit {
  startedAt: number;
  hands: number;
  net: number;
}

/** Read the whole open sitting, never the hands this browser happened to see.
 * ca_hand_facts.net already accounts for contributions, returns and rake.
 * Buy-ins and rebuys are funding, so neither becomes a win or a loss here.
 * Both readers are restricted to auth.uid(); the explicit user filter also
 * binds every page to the account that requested it. */
export async function readServerCashSessionProfit(
  tableId: string,
  userId: string
): Promise<ServerCashSessionProfit | null> {
  const readIdentity = async () => {
    const { data, error } = await supabase.rpc('fn_my_table_session_facts', {
      p_table_id: tableId,
    });
    if (error) throw error;
    if (data === null) return null;
    const startedAt = Date.parse(data?.started_at);
    const hands = Number(data?.hands_played);
    if (!Number.isFinite(startedAt) || !Number.isSafeInteger(hands) || hands < 0) {
      throw new Error('Cash Session Identity Unavailable');
    }
    return { startedAt, started: data.started_at as string, hands };
  };
  const session = await readIdentity();
  if (!session) return null;
  const seen = new Set<string>();
  let totalCents = 0;
  let expected = session.hands;
  let offset = 0;
  // A long sitting can exceed PostgREST's page limit. The first count bounds
  // this read; a duplicate or incomplete page refuses a partial total.
  do {
    const { data, error, count } = await supabase
      .from('ca_hand_facts')
      .select('hand_id,net', { count: 'exact' })
      .eq('user_id', userId)
      .eq('table_id', tableId)
      .is('tournament_id', null)
      .gte('played_at', session.started)
      .order('played_at', { ascending: true })
      .order('hand_id', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Cash Session Hands Unavailable');
    if (offset === 0) {
      if (!Number.isSafeInteger(count) || Number(count) < session.hands) {
        throw new Error('Cash Session Hand Coverage Incomplete');
      }
      expected = Number(count);
    }
    for (const row of data) {
      const amount = row.net === null || row.net === undefined ? NaN : Number(row.net);
      const amountCents = Math.round(amount * 100);
      if (
        typeof row.hand_id !== 'string' ||
        seen.has(row.hand_id) ||
        !Number.isSafeInteger(amountCents)
      ) {
        throw new Error('Cash Session Hand Evidence Invalid');
      }
      seen.add(row.hand_id);
      totalCents += amountCents;
    }
    offset += data.length;
    if (data.length === 0 && offset < expected) {
      throw new Error('Cash Session Hand Coverage Incomplete');
    }
  } while (offset < expected);
  const current = await readIdentity();
  if (!current || current.started !== session.started) {
    throw new Error('Cash Session Changed During Read');
  }
  if (seen.size < current.hands || !Number.isSafeInteger(totalCents)) {
    throw new Error('Cash Session Hand Coverage Incomplete');
  }
  return { startedAt: session.startedAt, hands: seen.size, net: totalCents / 100 };
}

/** Initial/reconnect reconciliation plus discrete settled-hand updates. No
 * polling, browser-lifetime baseline, storage expiry or historical write. */
export function useServerCashSessionProfit(
  userId: string | undefined,
  tableKey: string,
  enabled: boolean
): Record<string, ServerCashSessionProfit | null | undefined> {
  const scope = `${userId ?? ''}:${tableKey}:${enabled}`;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    rows: Record<string, ServerCashSessionProfit | null | undefined>;
  }>({ scope: '', rows: {} });
  useEffect(() => {
    if (!enabled || !userId || userId === 'guest' || !tableKey) return;
    let active = true;
    const ids = new Set(tableKey.split('|'));
    const reads = new Map<string, number>();
    const refresh = async (id: string) => {
      if (!ids.has(id)) return;
      const version = (reads.get(id) ?? 0) + 1;
      reads.set(id, version);
      const current = () => active && reads.get(id) === version;
      try {
        const row = await readServerCashSessionProfit(id, userId);
        if (!current()) return;
        setSnapshot((old) => ({
          scope,
          rows: { ...(old.scope === scope ? old.rows : {}), [id]: row },
        }));
      } catch (error) {
        if (!current()) return;
        reportError(error, 'CashSessionProfit.Read');
        setSnapshot((old) => ({
          scope,
          rows: { ...(old.scope === scope ? old.rows : {}), [id]: undefined },
        }));
      }
    };
    const refreshAll = () => ids.forEach((id) => void refresh(id));
    const refreshTable = (event: { payload: { tableId: string } }) =>
      void refresh(event.payload.tableId);
    const unsubscribers = [
      masterBus.subscribe('HAND_COMPLETED', refreshTable),
      masterBus.subscribe('TABLE_SEATED', refreshTable),
      masterBus.subscribe('CHIPS_ADDED', refreshTable),
      masterBus.subscribe('WS_CONNECTED', refreshAll),
      masterBus.subscribe('SESSION_ENDED', ({ payload }) => {
        if (!ids.has(payload.tableId)) return;
        reads.set(payload.tableId, (reads.get(payload.tableId) ?? 0) + 1);
        setSnapshot((old) => ({
          scope,
          rows: { ...(old.scope === scope ? old.rows : {}), [payload.tableId]: null },
        }));
      }),
    ];
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshAll);
    refreshAll();
    return () => {
      active = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshAll);
    };
  }, [enabled, scope, tableKey, userId]);
  return snapshot.scope === scope ? snapshot.rows : {};
}
