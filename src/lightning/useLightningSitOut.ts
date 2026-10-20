import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { fetchLightningAnchorSeat, type LightningPoolEntry } from './lightningSession';

export interface LightningSitOutState {
  sittingOut: boolean;
  since: number | null;
}

/** Bootstrap the caller's real chair, never a hand snapshot or the pool as a table. */
export async function readLightningSitOut(
  clusterId: string,
  poolSessionId: string,
  userId: string
): Promise<LightningSitOutState | null> {
  const anchor = await fetchLightningAnchorSeat(clusterId, poolSessionId);
  if (!anchor) return null;
  const { data, error } = await supabase
    .from('table_seats')
    .select(
      'table_id,user_id,seat_number,occupancy_id,is_sitting_out,sit_out_at,left_at,leave_pending'
    )
    .eq('table_id', anchor.anchorTableId)
    .eq('user_id', userId)
    .eq('seat_number', anchor.seatNumber)
    .eq('occupancy_id', anchor.occupancyId)
    .is('left_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (
    data.table_id !== anchor.anchorTableId ||
    data.user_id !== userId ||
    data.seat_number !== anchor.seatNumber ||
    data.occupancy_id !== anchor.occupancyId ||
    data.left_at !== null ||
    typeof data.is_sitting_out !== 'boolean'
  )
    throw new Error('Lightning Sit Out Anchor Unverified');
  if (data.leave_pending === true) return null;
  const since = data.is_sitting_out ? Date.parse(data.sit_out_at ?? '') : null;
  if (since !== null && !Number.isFinite(since))
    throw new Error('Lightning Sit Out Clock Unverified');
  return { sittingOut: data.is_sitting_out, since };
}

/** Existing socket connection events bootstrap/recover; action ACKs update immediately.
 * No polling, extra socket, fabricated hand seat or cashier refresh. */
export function useLightningSitOut({
  room,
  userId,
  connectionStatus,
  event,
  read = readLightningSitOut,
}: {
  room: LightningPoolEntry | null;
  userId: string | null | undefined;
  connectionStatus: string;
  event?: Record<string, unknown> | null;
  read?: typeof readLightningSitOut;
}) {
  const pool = room?.poolSessionId;
  const cluster = room?.clusterId;
  const key =
    pool && cluster && userId && userId !== 'guest' ? `${pool}/${cluster}/${userId}` : null;
  const identity = useRef(key);
  const generation = useRef(0);
  const scope = useRef(0);
  if (identity.current !== key) {
    identity.current = key;
    scope.current++;
    generation.current++;
  }
  const currentScope = scope.current;
  const mounted = useRef(false);
  const [state, setState] = useState<{
    key: string;
    scope: number;
    value: LightningSitOutState;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!key || !pool || !cluster || !userId || connectionStatus !== 'connected') return;
    const epoch = ++generation.current;
    let current = true;
    void read(cluster, pool, userId)
      .then((value) => {
        if (current && mounted.current && identity.current === key && generation.current === epoch)
          setState(value ? { key, scope: currentScope, value } : null);
      })
      .catch((error) => {
        if (current && identity.current === key && generation.current === epoch)
          reportError(error, 'TablePage.lightning_sitout_read_failed', { clusterId: cluster });
      });
    return () => {
      current = false;
    };
  }, [key, pool, cluster, userId, connectionStatus, read, currentScope]);
  // Only the owner's persisted, named transition requests reconciliation.
  // Ordinary hand events cannot cancel this read or manufacture a hand seat.
  useEffect(() => {
    if (
      !key ||
      !pool ||
      !cluster ||
      !userId ||
      event?.type !== 'lightning_sitout_changed' ||
      event.pool_session_id !== pool ||
      event.player_id !== userId ||
      typeof event.occupancy_id !== 'string' ||
      typeof event.sitting_out !== 'boolean'
    )
      return;
    const epoch = ++generation.current;
    void read(cluster, pool, userId)
      .then((value) => {
        if (
          mounted.current &&
          identity.current === key &&
          scope.current === currentScope &&
          generation.current === epoch
        )
          setState(value ? { key, scope: currentScope, value } : null);
      })
      .catch((error) => {
        if (mounted.current && identity.current === key && generation.current === epoch)
          reportError(error, 'TablePage.lightning_sitout_read_failed', { clusterId: cluster });
      });
  }, [event, key, pool, cluster, userId, read, currentScope]);
  const isCurrent = useCallback(
    (targetPool: string, targetUser: string) =>
      mounted.current &&
      identity.current === key &&
      scope.current === currentScope &&
      key === `${targetPool}/${cluster}/${targetUser}`,
    [key, cluster, currentScope]
  );
  const acknowledge = useCallback(
    (targetPool: string, targetUser: string, sittingOut: boolean) => {
      const current = identity.current;
      if (
        !mounted.current ||
        !current ||
        current !== key ||
        scope.current !== currentScope ||
        current !== `${targetPool}/${cluster}/${targetUser}`
      )
        return false;
      // An earlier bootstrap cannot overwrite this newer accepted user request.
      generation.current++;
      setState({
        key: current,
        scope: currentScope,
        value: { sittingOut, since: sittingOut ? Date.now() : null },
      });
      return true;
    },
    [key, cluster, currentScope]
  );
  return {
    sittingOut: state?.key === key && state.scope === currentScope ? state.value.sittingOut : false,
    since: state?.key === key && state.scope === currentScope ? state.value.since : null,
    acknowledge,
    isCurrent,
  };
}
