import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

/** A retained move may beat the page's asynchronous account hydration. */
export function useSeatMoveNavigation({
  tableId,
  userId,
  event,
  follow,
}: {
  tableId: string | undefined;
  userId: string;
  event: Record<string, unknown> | null;
  follow: (destination: string) => void;
}) {
  const pending = useRef({
    tableId,
    event: null as Record<string, unknown> | null,
    destinations: new Map<string, { destination: string; replayed: boolean }>(),
  });

  const followRef = useRef(follow);
  followRef.current = follow;
  const scope = useRef({ tableId, userId });
  if (scope.current.tableId !== tableId || scope.current.userId !== userId) {
    scope.current = { tableId, userId };
  }
  const validation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (pending.current.tableId !== tableId) {
      pending.current = { tableId, event: null, destinations: new Map() };
    }
    const state = pending.current;
    if (event !== state.event) {
      state.event = event;
      const data = (event?.data ?? event) as Record<string, unknown> | null;
      if (
        String(event?.type).toUpperCase() === 'SEAT_MOVED' &&
        tableId &&
        data?.table_id === tableId &&
        typeof data.user_id === 'string' &&
        typeof data.to_table_id === 'string' &&
        data.to_table_id &&
        data.to_table_id !== tableId
      ) {
        state.destinations.set(data.user_id, {
          destination: data.to_table_id,
          replayed: event?.replayed === true || data.replayed === true,
        });
      }
    }
    if (!userId || userId === 'guest') return;
    const move = state.destinations.get(userId);
    // Once identity is known, spectator moves cannot become this user's move.
    // Clear before following so a render or a repeated effect cannot follow twice.
    state.destinations.clear();
    if (!move) return;
    const request = ++validation.current;
    if (!move.replayed) {
      followRef.current(move.destination);
      return;
    }
    // A seat change can return through a must-move within the 60s replay
    // window. Reopening either room gives it a NEW subscriber, so the hub's
    // per-subscriber dedupe cannot stop A -> B -> A -> B. A retained event is
    // historical evidence: follow only if its destination still owns our seat.
    const currentScope = scope.current;
    const isCurrent = () =>
      mounted.current && scope.current === currentScope && validation.current === request;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('table_seats')
          .select('table_id')
          .eq('user_id', userId)
          .eq('table_id', move.destination)
          .is('left_at', null)
          .maybeSingle();
        if (!isCurrent()) return;
        if (error) {
          reportError(error, 'useSeatMoveNavigation.currentSeatRead');
          return;
        }
        if (data?.table_id === move.destination) followRef.current(move.destination);
      } catch (error) {
        if (isCurrent()) reportError(error, 'useSeatMoveNavigation.currentSeatRead');
      }
    })();
  }, [tableId, userId, event]);
}
