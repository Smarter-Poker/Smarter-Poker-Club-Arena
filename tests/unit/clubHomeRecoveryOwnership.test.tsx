import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LobbyTournamentRow } from '../../src/components/lobby/lobbyEntries';

type QueryResult<T> = {
  data: T | null;
  error: { code: string; message: string } | null;
};
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type TournamentFixture = LobbyTournamentRow & {
  club_id: string;
  union_id: string | null;
};
type ClubFixture = {
  id: string;
  club_id: number;
  name: string;
  member_count: number;
  owner_id: string;
  union_id: string | null;
  is_union: boolean | null;
};

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
  authenticated: false,
  unionLookup: { data: null, error: null } as QueryResult<{ union_id: string }>,
  tournamentReads: [] as Deferred<QueryResult<TournamentFixture[]>>[],
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: h.from,
    rpc: h.rpc,
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
  getAuthUser: vi.fn(async () => ({
    data: { user: h.authenticated ? { id: 'viewer' } : null },
    error: null,
  })),
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
vi.mock('../../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
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
import ClubHomePage, { CLUB_HOME_CACHE_VER } from '../../src/pages/ClubHomePage';
import { CLUB_HOME_CACHE_PREFIX } from '../../src/utils/clearUserCaches';

const deferred = <T = any,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
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
  h.authenticated = false;
  h.unionLookup = { data: null, error: null };
  h.tournamentReads.length = 0;
  h.resolveClub.mockImplementation(async (id) => id);
  h.rpc.mockResolvedValue({ data: 0, error: null });
  h.from.mockImplementation((table: string) => {
    let result = table === 'clubs' ? deferred() : null;
    if (result) h.clubReads.push(result);
    const q: any = {};
    for (const method of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit', 'in', 'lte'])
      q[method] = () => q;
    q.select = (columns: string) => {
      if (h.deferOccupancy && table === 'tables' && columns.startsWith('id, current_players')) {
        result = deferred();
        h.occupancyReads.push(result);
      }
      if (
        h.authenticated &&
        table === 'tournaments' &&
        columns.startsWith('format_contract, id, name, game_type')
      ) {
        const read = deferred<QueryResult<TournamentFixture[]>>();
        result = read;
        h.tournamentReads.push(read);
      }
      return q;
    };
    q.maybeSingle = () => {
      if (result) return result.promise;
      if (h.authenticated && table === 'union_clubs') return Promise.resolve(h.unionLookup);
      if (h.authenticated && table === 'club_members') {
        return Promise.resolve({ data: { role: 'member', status: 'active' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
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
    // The key is BUILT from the version the page actually reads. Hardcoding it
    // meant a deliberate cache bump (v3 -> v4, 2026-09-09) silently orphaned
    // this fixture: the page found nothing, rendered nothing, and four pins
    // went red for a reason that had nothing to do with what they guard.
    `${CLUB_HOME_CACHE_PREFIX}${CLUB_HOME_CACHE_VER}_club-a`,
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

const UNION_CACHE_KEY = 'ca_union_of_club-a';
const QUERY_FAILURE = { code: '57014', message: 'statement timeout' };
const tournamentFixture = (
  id = 'known-tournament',
  name = 'Known Tournament',
  unionId: string | null = null
): TournamentFixture => ({
  format_contract: 'mtt-v2',
  id,
  name,
  club_id: 'club-a',
  union_id: unionId,
  game_type: 'mtt',
  variant: 'nlh',
  buy_in_amount: 10,
  buy_in_fee: 1,
  guaranteed_prize: 100,
  start_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  status: 'REGISTERING',
  current_players: 3,
  max_players: 500,
  starting_chips: 10_000,
});

async function mountWarmTournaments({
  unionId = null,
  clubUnionId = null,
  isUnion = false,
}: {
  unionId?: string | null;
  clubUnionId?: string | null;
  isUnion?: boolean | null;
} = {}) {
  h.authenticated = true;
  h.unionLookup = { data: unionId ? { union_id: unionId } : null, error: null };
  const club: ClubFixture = {
    id: 'club-a',
    club_id: 1,
    name: 'Test Club',
    member_count: 1,
    owner_id: 'owner',
    union_id: clubUnionId,
    is_union: isUnion,
  };
  const row = tournamentFixture('known-tournament', 'Known Tournament', unionId);
  const view = mount();
  await flush();
  await act(async () => h.clubReads[0].resolve({ data: club, error: null }));
  expect(h.tournamentReads).toHaveLength(1);
  await act(async () => h.tournamentReads[0].resolve({ data: [row], error: null }));
  expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
  return { view, club, row };
}

async function startTournamentReload(club: ClubFixture) {
  const clubReadIndex = h.clubReads.length;
  const tournamentReadIndex = h.tournamentReads.length;
  act(() => h.bus.get('CLUB_JOINED')!());
  await flush();
  expect(h.clubReads).toHaveLength(clubReadIndex + 1);
  await act(async () => h.clubReads[clubReadIndex].resolve({ data: club, error: null }));
  expect(h.tournamentReads).toHaveLength(tournamentReadIndex + 1);
  return h.tournamentReads[tournamentReadIndex];
}

async function finishTournamentReload(club: ClubFixture, result: QueryResult<TournamentFixture[]>) {
  const read = await startTournamentReload(club);
  await act(async () => read.resolve(result));
}

describe('the mounted lobby reconciles warm tournament inventory', () => {
  it.each([
    {
      label: 'standalone club',
      unionId: null,
      clubUnionId: null,
      isUnion: false,
      lookupFails: false,
    },
    {
      label: 'live union membership',
      unionId: 'union-a',
      clubUnionId: null,
      isUnion: false,
      lookupFails: false,
    },
    {
      label: 'legacy standalone club with nullable is_union',
      unionId: null,
      clubUnionId: null,
      isUnion: null,
      lookupFails: false,
    },
    {
      label: 'fresh club union fallback',
      unionId: 'union-a',
      clubUnionId: 'union-a',
      isUnion: false,
      lookupFails: true,
    },
  ])('clears stale cards after a confirmed empty read for $label', async (scope) => {
    const { club } = await mountWarmTournaments(scope);
    if (scope.lookupFails) {
      h.unionLookup = { data: null, error: QUERY_FAILURE };
      sessionStorage.removeItem(UNION_CACHE_KEY);
    }
    await finishTournamentReload(club, { data: [], error: null });
    expect(screen.queryAllByText('Known Tournament')).toHaveLength(0);
  });

  it.each([
    { label: 'failed tournament query', result: { data: [], error: QUERY_FAILURE } },
    { label: 'null tournament query data', result: { data: null, error: null } },
  ])('preserves warm cards after $label', async ({ result }) => {
    const { club } = await mountWarmTournaments();
    await finishTournamentReload(club, result);
    expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
  });

  it('preserves cards while scope is unresolved, then clears them after scope recovers', async () => {
    const { club } = await mountWarmTournaments({ unionId: 'union-a' });
    sessionStorage.removeItem(UNION_CACHE_KEY);
    h.unionLookup = { data: null, error: QUERY_FAILURE };
    await finishTournamentReload(club, { data: [], error: null });
    expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
    h.unionLookup = { data: { union_id: 'union-a' }, error: null };
    await finishTournamentReload(club, { data: [], error: null });
    expect(screen.queryAllByText('Known Tournament')).toHaveLength(0);
  });

  it('preserves cards when the scope fallback comes only from cache', async () => {
    const { club } = await mountWarmTournaments({ unionId: 'union-a' });
    expect(sessionStorage.getItem(UNION_CACHE_KEY)).toBe('union-a');
    h.unionLookup = { data: null, error: QUERY_FAILURE };
    await finishTournamentReload(club, { data: [], error: null });
    expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
  });

  it('does not classify a union house with no membership row as standalone', async () => {
    const { club } = await mountWarmTournaments({ isUnion: true });
    await finishTournamentReload(club, { data: [], error: null });
    expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
  });

  it('preserves cards when the union cache cannot be read', async () => {
    const { club } = await mountWarmTournaments();
    const storage = sessionStorage;
    const cacheRead = vi.fn((key: string) => {
      if (key === UNION_CACHE_KEY) throw new Error('storage unavailable');
      return storage.getItem(key);
    });
    vi.stubGlobal('sessionStorage', {
      getItem: cacheRead,
      setItem: storage.setItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      clear: storage.clear.bind(storage),
      key: storage.key.bind(storage),
      get length() {
        return storage.length;
      },
    });
    try {
      await finishTournamentReload(club, { data: [], error: null });
      expect(cacheRead).toHaveBeenCalledWith(UNION_CACHE_KEY);
      expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves a realtime insert against an older empty query and queues one authoritative read', async () => {
    const { club } = await mountWarmTournaments();
    const read = await startTournamentReload(club);
    const onTournamentChange = h.channels[0].on.mock.calls.find(
      ([_event, config]: any[]) => config.table === 'tournaments'
    )[2];
    const inserted = tournamentFixture('new-tournament', 'New Tournament');
    await act(async () => {
      onTournamentChange({ eventType: 'INSERT', new: inserted });
      read.resolve({ data: [], error: null });
    });
    expect(screen.queryAllByText('Known Tournament').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('New Tournament').length).toBeGreaterThan(0);
    expect(h.clubReads).toHaveLength(3);
    expect(h.tournamentReads).toHaveLength(2);
    await act(async () => h.clubReads[2].resolve({ data: club, error: null }));
    expect(h.tournamentReads).toHaveLength(3);
    await act(async () => h.tournamentReads[2].resolve({ data: [inserted], error: null }));
    expect(screen.queryAllByText('Known Tournament')).toHaveLength(0);
    expect(screen.queryAllByText('New Tournament').length).toBeGreaterThan(0);
    expect(h.clubReads).toHaveLength(3);
  });

  it('clears stale cards without a queued read when only an unknown completed tournament updates', async () => {
    const { club } = await mountWarmTournaments();
    const read = await startTournamentReload(club);
    const onTournamentChange = h.channels[0].on.mock.calls.find(
      ([_event, config]: any[]) => config.table === 'tournaments'
    )[2];
    await act(async () => {
      onTournamentChange({
        eventType: 'UPDATE',
        new: { ...tournamentFixture('completed-tournament'), status: 'COMPLETED' },
      });
      read.resolve({ data: [], error: null });
    });
    expect(screen.queryAllByText('Known Tournament')).toHaveLength(0);
    expect(h.clubReads).toHaveLength(2);
    expect(h.tournamentReads).toHaveLength(2);
  });
});
