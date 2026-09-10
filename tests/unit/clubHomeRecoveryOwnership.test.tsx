import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  resolveClub: vi.fn(),
  setCurrentClub: vi.fn(),
  factories: new Map<string, () => void>(),
  channels: [] as any[],
  poolStops: [] as ReturnType<typeof vi.fn>[],
  hitStops: [] as ReturnType<typeof vi.fn>[],
  bus: new Map<string, (event?: any) => void>(),
  clubReads: [] as any[],
  occupancyReads: [] as any[],
  deferOccupancy: false,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: h.from,
    rpc: h.rpc,
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
  getAuthUser: vi.fn(async () => ({ data: { user: null }, error: null })),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    registerChannelFactory: (key: string, factory: () => void) => h.factories.set(key, factory),
    removeChannelFactory: (key: string) => h.factories.delete(key),
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const channel = { on: vi.fn(), subscribe: vi.fn(), status: (_s: string) => {} };
      channel.on.mockReturnValue(channel);
      channel.subscribe.mockImplementation((cb) => {
        channel.status = cb;
        return channel;
      });
      h.channels.push(channel);
      return channel;
    },
    subscribeDebounced: (key: string, cb: () => void) => {
      h.bus.set(key, cb);
      return () => h.bus.delete(key);
    },
    subscribe: () => () => {},
    emit: vi.fn(),
  },
  busToast: vi.fn(),
}));
vi.mock('../../src/lib/bbjPoolFeed', () => ({
  watchBbjPool: (_club: string, cb: (s: any) => void) => {
    const stop = vi.fn();
    h.poolStops.push(stop);
    cb({ mainBalance: 12, poolId: 'pool' });
    return stop;
  },
}));
vi.mock('../../src/lib/bbjHitFeed', () => ({
  watchBbjHits: () => {
    const stop = vi.fn();
    h.hitStops.push(stop);
    return stop;
  },
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: vi.fn() }));
vi.mock('../../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register: vi.fn(), isRegistering: false }),
}));
vi.mock('../../src/utils/clubIdResolver', async (original) => ({
  ...(await original<any>()),
  resolveClubUUID: h.resolveClub,
  resolveClubUUIDSync: () => null,
  resolveClubIdFilter: (id: string) => ({ column: 'id', value: id }),
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: Object.assign((selector: any = (state: any) => state) => selector({ user: null }), {
    getState: () => ({ user: null, setCurrentClub: h.setCurrentClub }),
  }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/lobby/lobbyViewPrefs', async (original) => ({
  ...(await original<any>()),
  fetchRemoteViewPrefs: async () => null,
}));
import ClubHomePage from '../../src/pages/ClubHomePage';

const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => act(async () => {});
function mount(club = 'club-a') {
  return render(
    <MemoryRouter initialEntries={[`/clubs/${club}`]}>
      <Link to="/clubs/club-b">Change Club</Link>
      <Routes>
        <Route path="/clubs/:clubId" element={<ClubHomePage />} />
      </Routes>
    </MemoryRouter>
  );
}
const rebuild = async () => {
  act(() => h.factories.get('club-tables-club-a')!());
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  h.factories.clear();
  h.bus.clear();
  h.channels.length = 0;
  h.poolStops.length = 0;
  h.hitStops.length = 0;
  h.clubReads.length = 0;
  h.occupancyReads.length = 0;
  h.deferOccupancy = false;
  h.resolveClub.mockImplementation(async (id) => id);
  h.rpc.mockResolvedValue({ data: 0, error: null });
  h.from.mockImplementation((table: string) => {
    let result = table === 'clubs' ? deferred() : null;
    if (result) h.clubReads.push(result);
    const q: any = {};
    for (const method of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit', 'in'])
      q[method] = () => q;
    q.select = (columns: string) => {
      if (h.deferOccupancy && table === 'tables' && columns.startsWith('id, current_players')) {
        result = deferred();
        h.occupancyReads.push(result);
      }
      return q;
    };
    q.maybeSingle = () => result?.promise ?? Promise.resolve({ data: null, error: null });
    q.then = (resolve: any, reject: any) =>
      (result?.promise ?? Promise.resolve({ data: [], error: null })).then(resolve, reject);
    return q;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the mounted club lobby owns its recovery', () => {
  it('replaces jackpot watchers when the channel factory rebuilds', async () => {
    const view = mount();
    await flush();
    await rebuild();
    expect(h.poolStops).toHaveLength(2);
    expect(h.poolStops[0]).toHaveBeenCalledOnce();
    expect(h.hitStops[0]).toHaveBeenCalledOnce();
    view.unmount();
    expect(h.poolStops[1]).toHaveBeenCalledOnce();
    expect(h.hitStops[1]).toHaveBeenCalledOnce();
    expect(h.factories.size).toBe(0);
  });

  it('keeps one occupancy timer after recovery and none after unmount', async () => {
    const view = mount();
    await flush();
    await rebuild();
    await rebuild();
    h.from.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(h.from.mock.calls.filter(([table]) => table === 'tables')).toHaveLength(1);
    view.unmount();
    h.from.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(h.from).not.toHaveBeenCalled();
  });

  it('refreshes once after a rebuilt channel subscribes', async () => {
    mount();
    await flush();
    act(() => h.channels[0].status('SUBSCRIBED'));
    await act(async () => h.clubReads[0].resolve({ data: null, error: null }));
    await rebuild();
    act(() => h.channels[1].status('SUBSCRIBED'));
    await flush();
    expect(h.clubReads).toHaveLength(2);
  });

  it('retains a recovery request that arrives during a read', async () => {
    mount();
    await flush();
    act(() => {
      h.channels[0].status('SUBSCRIBED');
      h.channels[0].status('CHANNEL_ERROR');
      h.channels[0].status('SUBSCRIBED');
      h.channels[0].status('SUBSCRIBED');
    });
    expect(h.clubReads).toHaveLength(1);
    await act(async () => h.clubReads[0].resolve({ data: null, error: null }));
    expect(h.clubReads).toHaveLength(2);
  });

  it('ignores status callbacks from a replaced channel', async () => {
    mount();
    await flush();
    act(() => h.channels[0].status('SUBSCRIBED'));
    await act(async () => h.clubReads[0].resolve({ data: null, error: null }));
    await rebuild();
    act(() => h.channels[0].status('SUBSCRIBED'));
    await flush();
    expect(h.clubReads).toHaveLength(1);
  });

  it('does not let the previous club release the current read lock', async () => {
    mount();
    await flush();
    fireEvent.click(screen.getByText('Change Club'));
    await flush();
    expect(h.clubReads).toHaveLength(2);
    await act(async () => h.clubReads[0].resolve({ data: null, error: null }));
    act(() => h.bus.get('CLUB_JOINED')!());
    expect(h.clubReads).toHaveLength(2);
    await act(async () => h.clubReads[1].resolve({ data: null, error: null }));
    expect(h.clubReads).toHaveLength(3);
  });

  it('allows only the latest overlapping channel rebuild to attach feeds', async () => {
    mount();
    await flush();
    const older = deferred();
    const newer = deferred();
    h.resolveClub.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await rebuild();
    await rebuild();
    await act(async () => newer.resolve('club-a'));
    await act(async () => older.resolve('club-a'));
    expect(h.channels).toHaveLength(2);
    expect(h.poolStops).toHaveLength(2);
  });

  it('does not restore club context after unmount during UUID resolution', async () => {
    const pending = deferred();
    h.resolveClub.mockReturnValue(pending.promise);
    const view = mount();
    await flush();
    view.unmount();
    await act(async () => pending.resolve('club-a'));
    expect(h.setCurrentClub).not.toHaveBeenCalled();
    expect(h.channels).toHaveLength(0);
  });
});

async function mountCachedTable(patch: Record<string, unknown> = {}) {
  const table = {
    id: 'known-table',
    name: 'Known Table',
    club_id: 'club-a',
    game_variant: 'nlh',
    status: 'waiting',
    current_players: 1,
    max_players: 9,
    small_blind: 1,
    big_blind: 2,
    ...patch,
  };
  localStorage.setItem(
    'club_home_cache_v3_club-a',
    JSON.stringify({
      at: Date.now(),
      data: {
        club: { id: 'club-a', club_id: 1, name: 'Test Club', member_count: 1 },
        tables: [table],
      },
    })
  );
  h.deferOccupancy = true;
  const view = mount();
  await flush();
  await act(async () => h.clubReads[0].resolve({ data: null, error: null }));
  return { view, table };
}

const tickOccupancy = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });

describe('the mounted lobby recovers occupancy snapshots', () => {
  it('keeps one request in flight while an occupancy read is slow', async () => {
    await mountCachedTable();
    await tickOccupancy();
    expect(h.occupancyReads).toHaveLength(1);
    await tickOccupancy();
    expect(h.occupancyReads).toHaveLength(1);
  });

  it('requests missing inventory even when React already has a table update queued', async () => {
    const { table } = await mountCachedTable();
    await tickOccupancy();
    const onTableChange = h.channels[0].on.mock.calls.find(
      ([_event, config]: any[]) => config.table === 'tables'
    )[2];
    await act(async () => {
      onTableChange({ eventType: 'UPDATE', new: { ...table, current_players: 2 } });
      h.occupancyReads[0].resolve({
        data: [
          { ...table, current_players: 2 },
          { ...table, id: 'new-table', current_players: 3 },
        ],
        error: null,
      });
    });
    expect(h.clubReads).toHaveLength(2);
  });

  it('requests authority for an omitted known table without deleting its visible card', async () => {
    await mountCachedTable();
    expect(screen.queryAllByText('Known Table').length).toBeGreaterThan(0);
    await tickOccupancy();
    await act(async () => h.occupancyReads[0].resolve({ data: [], error: null }));
    expect(screen.queryAllByText('Known Table').length).toBeGreaterThan(0);
    expect(h.clubReads).toHaveLength(2);
  });

  it('releases a failed occupancy read so the next visible tick can recover', async () => {
    const { table } = await mountCachedTable();
    await tickOccupancy();
    await act(async () =>
      h.occupancyReads[0].resolve({
        data: null,
        error: { code: '57014', message: 'statement timeout' },
      })
    );
    expect(screen.queryAllByText('Known Table').length).toBeGreaterThan(0);
    await tickOccupancy();
    expect(h.occupancyReads).toHaveLength(2);
    await act(async () => h.occupancyReads[1].resolve({ data: [table], error: null }));
    expect(h.clubReads).toHaveLength(1);
  });

  it('does not mistake a narrower setup scope for removal of cached union inventory', async () => {
    await mountCachedTable({ club_id: 'club-b', union_id: 'union-a' });
    await tickOccupancy();
    await act(async () => h.occupancyReads[0].resolve({ data: [], error: null }));
    expect(h.clubReads).toHaveLength(1);
    expect(screen.queryAllByText('Known Table').length).toBeGreaterThan(0);
  });

  it('does not treat absence from a capped snapshot as removal proof', async () => {
    const { table } = await mountCachedTable();
    await tickOccupancy();
    const data = Array.from({ length: 200 }, (_, i) => ({
      ...table,
      id: `empty-${i}`,
      current_players: 0,
    }));
    await act(async () => h.occupancyReads[0].resolve({ data, error: null }));
    expect(h.clubReads).toHaveLength(1);
    expect(screen.queryAllByText('Known Table').length).toBeGreaterThan(0);
  });
});
