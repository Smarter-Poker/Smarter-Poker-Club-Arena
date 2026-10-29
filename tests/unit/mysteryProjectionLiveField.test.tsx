import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  row: vi.fn(),
  entries: vi.fn(),
  report: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: m.report }));
vi.mock('../../src/services/tournamentStandingsUpdates', () => ({
  subscribeTournamentStandings: (id: string, fn: () => void) => {
    m.listeners.set(id, fn);
    return () => {
      if (m.listeners.get(id) === fn) m.listeners.delete(id);
    };
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let id = '',
        cursor: string | null = null,
        limit = 1000;
      const b: any = {
        select: () => b,
        eq: (key: string, value: string) => {
          id = value;
          return b;
        },
        order: () => b,
        limit: (value: number) => {
          limit = value;
          return b;
        },
        gt: (_key: string, value: string) => {
          cursor = value;
          return b;
        },
        maybeSingle: () => m.row(id),
        then: (resolve: any) => Promise.resolve(m.entries(id, cursor, limit)).then(resolve),
      };
      if (table !== 'tournaments' && table !== 'tournament_players') throw new Error(table);
      return b;
    },
  },
}));
import { useMysteryBountyProjection } from '../../src/hooks/useMysteryBountyProjection';
const settings = (pool = 10000) => ({
  data: {
    bounty_pool: pool,
    bounty_pool_paid: 0,
    mystery_bounty_pool_percent: 100,
    mystery_bounty_regular_pool_percent: 0,
    mystery_bounty_top_percent: 10,
    mystery_bounty_profile: 'classic',
    mystery_bounty_activation: 'percent_field',
    mystery_bounty_activation_value: 50,
    payout_structure: [100],
  },
  error: null,
});
const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `entry-${String(i).padStart(5, '0')}`,
    rebuys: 0,
  }));
let field = rows(1001);
beforeEach(() => {
  vi.resetAllMocks();
  m.listeners.clear();
  field = rows(1001);
  m.row.mockResolvedValue(settings());
  m.entries.mockImplementation((_id, cursor, limit) => ({
    data: field.filter((r) => !cursor || r.id > cursor).slice(0, limit),
    count: field.length,
    error: null,
  }));
});
afterEach(cleanup);
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
describe('the mystery projection follows its complete live field', () => {
  it('includes entrants after the first 1000 in the projected chest count', async () => {
    const hook = renderHook(() => useMysteryBountyProjection('event', true, 1));
    await flush();
    expect(hook.result.current?.drawCount).toBe(500);
    expect(m.entries.mock.calls.map((c) => c[1])).toEqual([null, 'entry-00999']);
  });
  it('does not publish a truncated field when a later page fails', async () => {
    m.entries.mockImplementation((_id, cursor) =>
      cursor
        ? { data: null, error: new Error('offline') }
        : { data: field.slice(0, 1000), error: null, count: 1001 }
    );
    const hook = renderHook(() => useMysteryBountyProjection('event', true, 1));
    await flush();
    expect(hook.result.current).toBeNull();
    expect(m.report).toHaveBeenCalled();
  });
  it('updates from the existing tournament event without waiting for a polling interval', async () => {
    field = rows(20);
    const hook = renderHook(() => useMysteryBountyProjection('event', true, 1));
    await flush();
    expect(hook.result.current?.drawCount).toBe(9);
    field = rows(30);
    await act(async () => {
      m.listeners.get('event')?.();
    });
    expect(hook.result.current?.drawCount).toBe(14);
  });
  it('clears the previous event while the next event is still loading', async () => {
    field = rows(20);
    const hook = renderHook(({ id }) => useMysteryBountyProjection(id, true, 1), {
      initialProps: { id: 'first' },
    });
    await flush();
    expect(hook.result.current?.drawCount).toBe(9);
    m.row.mockReturnValue(new Promise(() => {}));
    hook.rerender({ id: 'second' });
    await flush();
    expect(hook.result.current).toBeNull();
  });
  it('coalesces events during a pending read and publishes the fresh continuation', async () => {
    let release!: (value: ReturnType<typeof settings>) => void;
    m.row.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const hook = renderHook(() => useMysteryBountyProjection('event', true, 1));
    await flush();
    await act(async () => {
      m.listeners.get('event')?.();
      m.listeners.get('event')?.();
    });
    expect(m.row).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(settings(5000));
    });
    await flush();
    expect(m.row).toHaveBeenCalledTimes(2);
    expect(hook.result.current?.poolCents).toBe(1000000);
  });
  it('keeps a verified current projection when an event refresh fails', async () => {
    field = rows(20);
    const hook = renderHook(() => useMysteryBountyProjection('event', true, 1));
    await flush();
    const prior = hook.result.current;
    m.row.mockResolvedValue({ data: null, error: new Error('offline') });
    await act(async () => {
      m.listeners.get('event')?.();
    });
    expect(hook.result.current).toBe(prior);
    expect(m.report).toHaveBeenCalled();
  });
});
