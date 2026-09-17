import { useEffect, useRef } from 'react';

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
    destinations: new Map<string, string>(),
  });

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
        state.destinations.set(data.user_id, data.to_table_id);
      }
    }
    if (!userId || userId === 'guest') return;
    const destination = state.destinations.get(userId);
    // Once identity is known, spectator moves cannot become this user's move.
    // Clear before following so a render or a repeated effect cannot follow twice.
    state.destinations.clear();
    if (destination) follow(destination);
  }, [tableId, userId, event, follow]);
}
