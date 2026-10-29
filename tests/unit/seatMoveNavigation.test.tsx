import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSeatMoveNavigation } from '../../src/hooks/useSeatMoveNavigation';

const { seatRead, seatFilter } = vi.hoisted(() => ({ seatRead: vi.fn(), seatFilter: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          seatFilter(key, value);
          return query;
        },
        is: (key: string, value: unknown) => {
          seatFilter(key, value);
          return query;
        },
        maybeSingle: () => seatRead(),
      };
      return query;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
beforeEach(() => {
  seatRead.mockReset();
  seatFilter.mockClear();
});

const move = (user = 'alice', from = 'source', to = 'destination') => ({
  type: 'seat_moved',
  table_id: from,
  user_id: user,
  to_table_id: to,
});
const start = (userId = 'guest', event: Record<string, unknown> | null = move()) => {
  const follow = vi.fn();
  const initialProps = { tableId: 'source', userId, event, follow };
  const hook = renderHook(useSeatMoveNavigation, { initialProps });
  return { ...hook, follow, props: initialProps };
};

describe('a completed seat move survives identity hydration', () => {
  it('follows once after identity arrives, even if another event replaced the move', () => {
    const h = start();
    expect(h.follow).not.toHaveBeenCalled();
    h.rerender({ ...h.props, event: { type: 'hand_complete' } });
    h.rerender({ ...h.props, event: { type: 'hand_complete' }, userId: 'alice' });
    expect(h.follow).toHaveBeenCalledExactlyOnceWith('destination');
    h.rerender({ ...h.props, event: { type: 'hand_complete' }, userId: 'alice' });
    expect(h.follow).toHaveBeenCalledTimes(1);
  });

  it('keeps both swap recipients separate while their identities load', () => {
    for (const user of ['alice', 'bob']) {
      const h = start('guest', move('alice', 'source', 'alice-destination'));
      const second = move('bob', 'source', 'bob-destination');
      h.rerender({ ...h.props, event: second });
      h.rerender({ ...h.props, event: second, userId: user });
      expect(h.follow).toHaveBeenCalledExactlyOnceWith(`${user}-destination`);
      h.unmount();
    }
  });

  it('ignores another player and does not replay it when the account changes', () => {
    const h = start('bob');
    h.rerender({ ...h.props, userId: 'alice' });
    expect(h.follow).not.toHaveBeenCalled();
  });

  it('drops the pending move when the open table changes', () => {
    const h = start();
    h.rerender({ ...h.props, tableId: 'different', userId: 'alice' });
    expect(h.follow).not.toHaveBeenCalled();
  });

  it('follows a known player immediately, without repeating on callback changes', () => {
    const h = start('alice');
    expect(h.follow).toHaveBeenCalledExactlyOnceWith('destination');
    const next = vi.fn();
    h.rerender({ ...h.props, follow: next });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    move('alice', 'different'),
    move('alice', 'source', 'source'),
    { type: 'seat_moved', user_id: 'alice', to_table_id: 'destination' },
    { type: 'seat_move_pending', table_id: 'source', user_id: 'alice', to_table_id: 'destination' },
  ])('does not follow malformed, unrelated or merely proposed moves: %j', (event) => {
    const h = start('alice', event);
    expect(h.follow).not.toHaveBeenCalled();
  });
});

describe('retained moves follow the current chair', () => {
  it('does not follow the old Main 2 to Feeder move after the must-move returned the player', async () => {
    seatRead.mockResolvedValue({ data: null, error: null });
    const h = start('alice', { ...move(), replayed: true });
    await act(async () => {});
    expect(h.follow).not.toHaveBeenCalled();
    expect(seatRead).toHaveBeenCalledTimes(1);
    expect(seatFilter.mock.calls).toEqual([
      ['user_id', 'alice'],
      ['table_id', 'destination'],
      ['left_at', null],
    ]);
  });

  it('still follows a retained move to a confirmed live destination', async () => {
    seatRead.mockResolvedValue({ data: { table_id: 'destination' }, error: null });
    const h = start('alice', { ...move(), replayed: true });
    await waitFor(() => expect(h.follow).toHaveBeenCalledExactlyOnceWith('destination'));
  });

  it.each([
    { data: null, error: { message: 'offline' } },
    { data: null, error: null },
  ])('never navigates on an unknown or absent destination seat', async (result) => {
    seatRead.mockResolvedValue(result);
    const h = start('alice', { ...move(), replayed: true });
    await act(async () => {});
    expect(h.follow).not.toHaveBeenCalled();
  });

  it('does not let a slow replay override a newer live move', async () => {
    let resolve!: (value: unknown) => void;
    seatRead.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      })
    );
    const h = start('alice', { ...move(), replayed: true });
    h.rerender({ ...h.props, event: move('alice', 'source', 'newer') });
    await act(async () => resolve({ data: { table_id: 'destination' }, error: null }));
    expect(h.follow).toHaveBeenCalledExactlyOnceWith('newer');
  });

  it.each(['account', 'table', 'unmount'])(
    'drops a pending read after %s changes',
    async (change) => {
      let resolve!: (value: unknown) => void;
      seatRead.mockReturnValue(
        new Promise((yes) => {
          resolve = yes;
        })
      );
      const h = start('alice', { ...move(), replayed: true });
      if (change === 'unmount') h.unmount();
      else
        h.rerender({
          ...h.props,
          ...(change === 'account' ? { userId: 'bob' } : { tableId: 'other' }),
        });
      await act(async () => resolve({ data: { table_id: 'destination' }, error: null }));
      expect(h.follow).not.toHaveBeenCalled();
    }
  );
});

it('retained navigation survives StrictMode effect replay', async () => {
  seatRead.mockResolvedValue({ data: { table_id: 'destination' }, error: null });
  const follow = vi.fn();
  renderHook(useSeatMoveNavigation, {
    initialProps: {
      tableId: 'source',
      userId: 'alice',
      event: { ...move(), replayed: true },
      follow,
    },
    wrapper: StrictMode,
  });
  await waitFor(() => expect(follow).toHaveBeenCalledExactlyOnceWith('destination'));
});

it('reports a rejected seat read without following an unverified move', async () => {
  seatRead.mockRejectedValue(new Error('transport'));
  const h = start('alice', { ...move(), replayed: true });
  await act(async () => {});
  expect(h.follow).not.toHaveBeenCalled();
});
