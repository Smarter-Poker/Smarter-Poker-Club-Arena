import { useEffect, useRef } from 'react';
import { masterBus } from '../core/MasterBus';
import { sessionStatsService } from '../services/SessionStatsService';

/** The seat owns its session. A table move or view teardown cannot end it. */
export function useGameSessionLifecycle(input: {
  tableId?: string;
  userId: string;
  seated: boolean;
  stack: number;
  bigBlind: number;
  arenaAsset?: 'chips' | 'diamonds';
  onNewSession: (initialStack: number) => void;
  onStart?: (stack: number) => void;
}): void {
  const { tableId, userId, seated, stack, bigBlind, arenaAsset } = input;
  const callbacks = useRef(input);
  callbacks.current = input;
  const state = useRef({ key: '', started: false, ended: false });
  useEffect(() => {
    const key = `${userId}:${tableId}`;
    if (state.current.key !== key) state.current = { key, started: false, ended: false };
    if (!seated) {
      // A confirmed leave may render before the empty-seat snapshot arrives.
      // Wait for that boundary before allowing a fresh sitting at this table.
      if (state.current.ended) state.current.ended = false;
      return;
    }
    if (
      !tableId ||
      !userId ||
      userId === 'guest' ||
      !arenaAsset ||
      stack <= 0 ||
      state.current.started ||
      state.current.ended
    )
      return;
    const current = sessionStatsService.getStats(tableId);
    if (
      !current ||
      current.userId !== userId ||
      current.initialStack <= 0 ||
      (current.arenaAsset ?? 'chips') !== arenaAsset
    )
      callbacks.current.onNewSession(stack);
    sessionStatsService.startSession(tableId, userId, stack, bigBlind, arenaAsset);
    state.current.started = true;
    callbacks.current.onStart?.(stack);
  }, [tableId, userId, seated, stack, bigBlind, arenaAsset]);

  useEffect(
    () =>
      masterBus.subscribe('SESSION_ENDED', ({ payload }) => {
        if (payload.tableId !== tableId || payload.userId !== userId) return;
        state.current.started = false;
        state.current.ended = true;
        sessionStatsService.endSession(payload.tableId);
      }),
    [tableId, userId]
  );
}
