import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlayerFollowSubscription from '../../src/components/table/PlayerFollowSubscription';
const fake = vi.hoisted(() => ({
  change: null as any,
  status: null as any,
  from: vi.fn(),
  remove: vi.fn(),
  report: vi.fn(),
  player: { table_id: 'old', status: 'playing' } as any,
  table: { id: 'new', name: 'Event - Table 2', status: 'playing', is_deleted: false } as any,
  error: null as any,
  seat: null as any,
}));
vi.mock('../../src/services/tournamentStandingsUpdates', () => ({
  subscribeTournamentStandings: (_id: string, callback: () => void) => {
    fake.change = callback;
    fake.status = callback;
    return fake.remove;
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: fake.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: fake.report }));
const target = { tournamentId: 'event', userId: 'player', username: 'Player' };
const callbacks = () => ({ onMove: vi.fn(), onEnd: vi.fn(), onUnavailable: vi.fn() });
const change = (tableId: string | null, status = 'playing') => {
  fake.player = { table_id: tableId, status };
  act(() => fake.change());
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.player = { table_id: 'old', status: 'playing' };
  fake.error = null;
  fake.seat = null;
  fake.table = { id: 'new', name: 'Event - Table 2', status: 'playing', is_deleted: false };
  fake.from.mockImplementation((table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      maybeSingle: () =>
        Promise.resolve({
          data: table === 'tables' ? fake.table : table === 'table_seats' ? fake.seat : fake.player,
          error: fake.error,
        }),
    };
    return q;
  });
});
afterEach(cleanup);
async function mount() {
  const calls = callbacks();
  const view = render(
    <PlayerFollowSubscription target={target} tableId="old" accountId="account" {...calls} />
  );
  await act(async () => {});
  return { ...calls, ...view };
}
describe('the real follow subscription', () => {
  it('reads the watched player on a committed tournament event', async () => {
    const calls = await mount();
    change('old');
    await act(async () => {});
    expect(calls.onMove).not.toHaveBeenCalled();
    change('new');
    await waitFor(() =>
      expect(calls.onMove).toHaveBeenCalledWith(
        'old',
        target,
        {
          id: 'new',
          name: 'Event - Table 2',
        },
        false
      )
    );
  });
  it('catches a missed move on reconnect', async () => {
    const calls = await mount();
    fake.player.table_id = 'new';
    act(() => fake.status('SUBSCRIBED'));
    await waitFor(() => expect(calls.onMove).toHaveBeenCalledOnce());
  });
  it('waits through a transient null assignment and ends only on a terminal result', async () => {
    const calls = await mount();
    change(null);
    await act(async () => {});
    expect(calls.onEnd).not.toHaveBeenCalled();
    change(null, 'eliminated');
    await waitFor(() => expect(calls.onEnd).toHaveBeenCalledWith('old', target));
    expect(calls.onMove).not.toHaveBeenCalled();
  });
  it('reports failed reads without inventing elimination or a new table', async () => {
    const calls = await mount();
    fake.error = new Error('Denied');
    change('new');
    await waitFor(() => expect(calls.onUnavailable).toHaveBeenCalledOnce());
    expect(fake.report).toHaveBeenCalled();
    expect(calls.onMove).not.toHaveBeenCalled();
    expect(calls.onEnd).not.toHaveBeenCalled();
  });
  it('refuses closed destinations', async () => {
    const calls = await mount();
    fake.table.status = 'closed';
    change('new');
    await waitFor(() => expect(calls.onUnavailable).toHaveBeenCalledOnce());
    expect(calls.onMove).not.toHaveBeenCalled();
  });
  it('disposes the channel and ignores an outstanding read after Stop Following/unmount', async () => {
    const calls = await mount();
    let finish!: (value: unknown) => void;
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      maybeSingle: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    fake.from.mockReturnValue(q);
    change('new');
    calls.unmount();
    await act(async () => finish({ data: { table_id: 'new', status: 'playing' }, error: null }));
    expect(fake.remove).toHaveBeenCalledOnce();
    expect(calls.onMove).not.toHaveBeenCalled();
  });
  it('ignores an older read resolved after the latest terminal event', async () => {
    const calls = await mount();
    let finish!: (value: unknown) => void;
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      maybeSingle: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    fake.from.mockReturnValueOnce(q);
    change('new');
    change(null, 'finished');
    await waitFor(() => expect(calls.onEnd).toHaveBeenCalledOnce());
    await act(async () => finish({ data: { table_id: 'new', status: 'playing' }, error: null }));
    expect(calls.onMove).not.toHaveBeenCalled();
  });
  it('carries a confirmed source seat even before the container recovers its seats', async () => {
    const calls = await mount();
    fake.seat = { id: 'live-seat' };
    change('new');
    await waitFor(() =>
      expect(calls.onMove).toHaveBeenCalledWith(
        'old',
        target,
        { id: 'new', name: 'Event - Table 2' },
        true
      )
    );
  });
});
