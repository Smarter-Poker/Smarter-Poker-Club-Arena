import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  listeners: new Map<string, (event: any) => void>(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: vi.fn((name: string, callback: (event: any) => void) => {
      mocks.listeners.set(name, callback);
      return () => mocks.listeners.delete(name);
    }),
  },
}));
import {
  readServerCashSessionProfit,
  useServerCashSessionProfit,
} from '../../src/hooks/useServerCashSessionProfit';

const identity = (hands = 2, started = '2026-10-14T12:00:00Z') => ({
  data: { started_at: started, hands_played: hands },
  error: null,
});
function page(rows: Array<{ hand_id: string; net: number | string | null }>, count = rows.length) {
  const chain: Record<string, any> = {};
  for (const method of ['select', 'eq', 'is', 'gte', 'order']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.range = vi.fn(async () => ({ data: rows, count, error: null }));
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.rpc.mockResolvedValue(identity());
  mocks.from.mockImplementation(() =>
    page([
      { hand_id: 'one', net: '24.30' },
      { hand_id: 'two', net: '-5.00' },
    ])
  );
});

describe('server-owned cash session profit', () => {
  it('a reload reads the same whole sitting, even when it is more than an hour old', async () => {
    localStorage.clear();
    const first = renderHook(() => useServerCashSessionProfit('hero', 'table', true));
    await waitFor(() => expect(first.result.current.table?.net).toBe(19.3));
    first.unmount();
    localStorage.clear();
    const reloaded = renderHook(() => useServerCashSessionProfit('hero', 'table', true));
    await waitFor(() =>
      expect(reloaded.result.current.table).toEqual({
        net: 19.3,
        hands: 2,
        startedAt: Date.parse('2026-10-14T12:00:00Z'),
      })
    );
    const query = mocks.from.mock.results[0].value;
    expect(query.eq).toHaveBeenCalledWith('user_id', 'hero');
    expect(query.eq).toHaveBeenCalledWith('table_id', 'table');
    expect(query.is).toHaveBeenCalledWith('tournament_id', null);
    reloaded.unmount();
  });

  it('reads every page of a long session and adds cents exactly', async () => {
    mocks.rpc.mockResolvedValue(identity(1001));
    mocks.from
      .mockImplementationOnce(() =>
        page(
          Array.from({ length: 1000 }, (_, i) => ({ hand_id: String(i), net: '0.10' })),
          1001
        )
      )
      .mockImplementationOnce(() => page([{ hand_id: '1000', net: '-20.13' }], 1001));
    expect(await readServerCashSessionProfit('table', 'hero')).toMatchObject({
      hands: 1001,
      net: 79.87,
    });
    expect(mocks.from.mock.results[1].value.range).toHaveBeenCalledWith(1000, 1999);
  });

  it('never turns missing or invalid hand evidence into a zero or partial total', async () => {
    mocks.from.mockImplementationOnce(() => page([{ hand_id: 'one', net: 12 }], 1));
    await expect(readServerCashSessionProfit('table', 'hero')).rejects.toThrow(
      'Coverage Incomplete'
    );
    mocks.from.mockImplementationOnce(() =>
      page([
        { hand_id: 'one', net: null },
        { hand_id: 'two', net: 1 },
      ])
    );
    await expect(readServerCashSessionProfit('table', 'hero')).rejects.toThrow('Evidence Invalid');
  });

  it('rejects duplicate pages and a different sitting that replaced the original one', async () => {
    mocks.from.mockImplementationOnce(() =>
      page([
        { hand_id: 'one', net: 1 },
        { hand_id: 'one', net: 1 },
      ])
    );
    await expect(readServerCashSessionProfit('table', 'hero')).rejects.toThrow('Evidence Invalid');
    mocks.rpc
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(identity(2, '2026-10-16T12:00:00Z'));
    await expect(readServerCashSessionProfit('table', 'hero')).rejects.toThrow(
      'Changed During Read'
    );
  });

  it('updates from settled-hand events and reconnects, with no aggregation timer', async () => {
    const view = renderHook(() => useServerCashSessionProfit('hero', 'table', true));
    await waitFor(() => expect(view.result.current.table?.net).toBe(19.3));
    mocks.from.mockImplementation(() =>
      page([
        { hand_id: 'one', net: 30 },
        { hand_id: 'two', net: -2 },
      ])
    );
    act(() => mocks.listeners.get('HAND_COMPLETED')?.({ payload: { tableId: 'table' } }));
    await waitFor(() => expect(view.result.current.table?.net).toBe(28));
    mocks.from.mockImplementation(() =>
      page([
        { hand_id: 'one', net: 31 },
        { hand_id: 'two', net: -2 },
      ])
    );
    act(() => mocks.listeners.get('WS_CONNECTED')?.({ payload: { url: 'table' } }));
    await waitFor(() => expect(view.result.current.table?.net).toBe(29));
    act(() => mocks.listeners.get('SESSION_ENDED')?.({ payload: { tableId: 'table' } }));
    expect(view.result.current.table).toBeNull();
    view.unmount();
    expect(mocks.listeners.size).toBe(0);
  });

  it('discards an old account response and never flashes its total for the replacement account', async () => {
    let finish!: (value: ReturnType<typeof identity>) => void;
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = renderHook(({ user }) => useServerCashSessionProfit(user, 'table', true), {
      initialProps: { user: 'old' },
    });
    view.rerender({ user: 'new' });
    expect(view.result.current.table).toBeUndefined();
    await waitFor(() => expect(view.result.current.table?.net).toBe(19.3));
    await act(async () => {
      finish(identity(0));
    });
    expect(view.result.current.table?.net).toBe(19.3);
    view.unmount();
  });
});
