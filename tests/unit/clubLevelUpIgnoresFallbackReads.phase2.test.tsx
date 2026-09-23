/**
 * Create A Club, Phase 2 (2026-09-20): a Level Up toast is never fired by a
 * number that did not really change.
 *
 * A union club's member count is the union's summed total. When that sum
 * cannot be read, the page keeps the club row's own, much smaller, count; the
 * next good read then "jumped" several levels and celebrated a level-up that
 * never happened. This mounts the real page and drives three authoritative
 * loads through the bus. The harness is the reduced shape of
 * clubHomeRecoveryOwnership.test.tsx.
 */
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type SumResult = {
  data: Array<{ member_count: number }> | null;
  error: { code: string; message: string } | null;
};

const h = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  clubReads: [] as any[],
  bus: new Map<string, (event?: any) => void>(),
  unionSum: null as null | SumResult,
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: h.from,
    rpc: h.rpc,
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
  getAuthUser: vi.fn(async () => ({ data: { user: { id: 'viewer' } }, error: null })),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    registerChannelFactory: vi.fn(),
    removeChannelFactory: vi.fn(),
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const channel: any = { on: vi.fn(), subscribe: vi.fn() };
      channel.on.mockReturnValue(channel);
      channel.subscribe.mockReturnValue(channel);
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
vi.mock('../../src/lib/bbjPoolFeed', () => ({ watchBbjPool: () => vi.fn() }));
vi.mock('../../src/lib/bbjHitFeed', () => ({ watchBbjHits: () => vi.fn() }));
vi.mock('../../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: vi.fn() }));
vi.mock('../../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register: vi.fn(), isRegistering: false }),
}));
vi.mock('../../src/utils/clubIdResolver', async (original) => ({
  ...(await original<any>()),
  resolveClubUUID: async (id: string) => id,
  resolveClubUUIDSync: () => null,
  resolveClubIdFilter: (id: string) => ({ column: 'id', value: id }),
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: Object.assign(
    (selector: any = (state: any) => state) => selector({ user: { id: 'viewer' } }),
    { getState: () => ({ user: { id: 'viewer' }, setCurrentClub: vi.fn() }) }
  ),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/lobby/lobbyViewPrefs', async (original) => ({
  ...(await original<any>()),
  fetchRemoteViewPrefs: async () => null,
}));

import ClubHomePage from '../../src/pages/ClubHomePage';

const deferred = <T = any,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => act(async () => {});
/* Runs a load to completion. Some awaits inside the load race a short timer,
   so the fake clock moves too - by far less than the 20 s occupancy poll and
   the 90 s refresh, so neither can start a load of its own. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
  }
};

/** A union's own club row. Its row count (12) is far below the union total. */
const UNION_CLUB = {
  id: 'club-a',
  club_id: 1,
  name: 'Test Union',
  member_count: 12,
  owner_id: 'viewer',
  union_id: null,
  is_union: true,
};
const good = (total: number): SumResult => ({ data: [{ member_count: total }], error: null });
const FAILED: SumResult = { data: null, error: { code: '57014', message: 'statement timeout' } };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  h.clubReads.length = 0;
  nextRead = 0;
  h.bus.clear();
  h.unionSum = null;
  h.rpc.mockImplementation(async (name: string) =>
    name === 'fn_batch_club_realtime_member_counts'
      ? (h.unionSum ?? FAILED)
      : { data: 0, error: null }
  );
  h.from.mockImplementation((table: string) => {
    const result = table === 'clubs' ? deferred() : null;
    if (result) h.clubReads.push(result);
    const q: any = {};
    for (const method of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit', 'in', 'lte'])
      q[method] = () => q;
    q.maybeSingle = () => {
      if (result) return result.promise;
      if (table === 'union_clubs') {
        return Promise.resolve({ data: { union_id: 'union-a' }, error: null });
      }
      if (table === 'club_members') {
        return Promise.resolve({ data: { role: 'owner', status: 'active' }, error: null });
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

/** The club read the next load() answers. The mount issues the first one. */
let nextRead = 0;

/** One authoritative load, run to completion, with this union-sum answer. */
async function load(sum: SumResult) {
  h.unionSum = sum;
  if (nextRead > 0) {
    act(() => h.bus.get('CLUB_JOINED')!());
    await flush();
  }
  expect(h.clubReads.length).toBe(nextRead + 1);
  /* A fresh row per read, as the database returns: the page writes the union
     total back onto the row it was handed. */
  await act(async () => h.clubReads[nextRead].resolve({ data: { ...UNION_CLUB }, error: null }));
  nextRead += 1;
  await settle();
}

const levelUps = () =>
  h.toast.success.mock.calls.filter(([text]) => String(text).startsWith('Level Up'));

async function mount() {
  render(
    <MemoryRouter initialEntries={['/clubs/club-a']}>
      <Routes>
        <Route path="/clubs/:clubId" element={<ClubHomePage />} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
}

describe('a Level Up toast needs a real change', () => {
  it('celebrates a real rise between two good union totals (the harness can see a toast)', async () => {
    await mount();
    await load(good(30));
    await load(good(60));

    expect(levelUps()).toHaveLength(1);
  });

  it('does not celebrate a good total that follows a failed union-sum read', async () => {
    await mount();
    await load(good(60));
    await load(FAILED); // falls back to the club row's own 12: a level DOWN, no toast
    await load(good(60)); // the same union, the same 60: not a level-up

    expect(
      h.rpc.mock.calls.filter(([name]) => name === 'fn_batch_club_realtime_member_counts')
    ).toHaveLength(3);
    expect(levelUps()).toHaveLength(0);
  });

  it('does not celebrate the first good total after a first load that failed', async () => {
    await mount();
    await load(FAILED);
    await load(good(60));

    expect(levelUps()).toHaveLength(0);
  });

  it('still celebrates once the counts are like-for-like again', async () => {
    await mount();
    await load(FAILED);
    await load(good(30));
    await load(good(60));

    expect(levelUps()).toHaveLength(1);
  });
});
