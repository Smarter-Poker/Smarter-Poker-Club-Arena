import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({
  events: new Map<string, () => void>(),
  statuses: new Set<(status: string) => void>(),
  destination: 'source',
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToTournament: (id: string, callbacks: any) => {
      fx.events.set(id, callbacks.onEvent);
      return () => fx.events.delete(id);
    },
  },
}));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    onStatusChange: (callback: (status: string) => void) => {
      fx.statuses.add(callback);
      return () => fx.statuses.delete(callback);
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { subscribe: () => () => {} },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        maybeSingle: async () => ({
          error: null,
          data:
            table === 'tournament_players'
              ? { table_id: fx.destination, status: 'playing' }
              : table === 'tables'
                ? { id: fx.destination, name: 'Event - Table 2', status: 'running' }
                : null,
        }),
      };
      return query;
    },
  },
}));
import PlayerFollowSubscription from '../../src/components/table/PlayerFollowSubscription';
afterEach(cleanup);
it('connects real follow logic to tournament engine rebalances and reconnect, with cleanup', async () => {
  const onMove = vi.fn();
  const view = render(
    <PlayerFollowSubscription
      target={{ tournamentId: 'event', userId: 'watched', username: 'Watched' }}
      tableId="source"
      accountId="observer"
      onMove={onMove}
      onEnd={vi.fn()}
      onUnavailable={vi.fn()}
    />
  );
  await act(async () => {});
  expect(fx.events.has('event')).toBe(true);
  expect(onMove).not.toHaveBeenCalled();
  fx.destination = 'destination';
  act(() => fx.events.get('event')?.());
  await waitFor(() => expect(onMove).toHaveBeenCalledOnce());
  expect(onMove.mock.calls[0][2].id).toBe('destination');
  onMove.mockClear();
  fx.destination = 'reconnected-destination';
  act(() => {
    for (const status of fx.statuses) status('connected');
  });
  await waitFor(() => expect(onMove).toHaveBeenCalledOnce());
  expect(onMove.mock.calls[0][2].id).toBe('reconnected-destination');
  view.unmount();
  expect(fx.events.size).toBe(0);
  expect(fx.statuses.size).toBe(0);
});
