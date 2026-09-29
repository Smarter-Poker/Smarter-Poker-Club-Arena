/**
 * Create A Club, Phase 2 (2026-09-20): the club lobby's create control fails
 * CLOSED on union scope.
 *
 * `unionIdForCreate` is undefined until the union_clubs lookup answers, and it
 * stays undefined for the whole session when that lookup errors with nothing to
 * fall back on. The old gate, Boolean(is_union || union_id || lookup), read
 * undefined as "standalone" and showed the owner and staff of a
 * union_clubs-only club a Create control. This mounts the real page.
 *
 * The harness is the reduced shape of clubHomeRecoveryOwnership.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Result<T> = { data: T | null; error: { code: string; message: string } | null };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const h = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  clubReads: [] as any[],
  unionLookup: null as null | Promise<unknown>,
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
    subscribeDebounced: () => () => {},
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

/** Owned by the viewer, and carrying NO union marker of its own: exactly the
    shape of a club that is attached to a union through union_clubs alone. */
const CLUB = {
  id: 'club-a',
  club_id: 1,
  name: 'Test Club',
  member_count: 4,
  owner_id: 'viewer',
  union_id: null,
  is_union: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  h.clubReads.length = 0;
  h.unionLookup = null;
  h.rpc.mockResolvedValue({ data: 0, error: null });
  h.from.mockImplementation((table: string) => {
    const result = table === 'clubs' ? deferred() : null;
    if (result) h.clubReads.push(result);
    const q: any = {};
    for (const method of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit', 'in', 'lte'])
      q[method] = () => q;
    q.maybeSingle = () => {
      if (result) return result.promise;
      if (table === 'union_clubs') return h.unionLookup;
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

async function mountOnNlhTab() {
  render(
    <MemoryRouter initialEntries={['/clubs/club-a']}>
      <Routes>
        <Route path="/clubs/:clubId" element={<ClubHomePage />} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
  await act(async () => h.clubReads[0].resolve({ data: CLUB, error: null }));
  await flush();
  /* The ALL tab never has a create control; NLH is a tab that does. */
  fireEvent.click(screen.getByRole('tab', { name: /NLH/ }));
  await flush();
}

const createControl = () => screen.queryByLabelText('Create Games');

describe('club lobby create control and union scope', () => {
  it('shows the control once the lookup positively resolves to no union', async () => {
    h.unionLookup = Promise.resolve({ data: null, error: null } as Result<{ union_id: string }>);
    await mountOnNlhTab();

    expect(createControl()).not.toBeNull();
  });

  it('shows nothing while the union lookup is still unresolved, then opens on a clean answer', async () => {
    /* A returning visitor: the lobby paints from the boot cache while the
       lookup is in flight, which is the window the old gate failed open in. */
    localStorage.setItem(
      `${CLUB_HOME_CACHE_PREFIX}${CLUB_HOME_CACHE_VER}_club-a`,
      JSON.stringify({ at: Date.now(), data: { club: CLUB, tables: [] } })
    );
    const lookup = deferred<Result<{ union_id: string }>>();
    h.unionLookup = lookup.promise;
    await mountOnNlhTab();

    expect(screen.getByRole('tab', { name: /NLH/ })).toBeTruthy();
    expect(createControl()).toBeNull();

    await act(async () => lookup.resolve({ data: null, error: null }));
    await flush();
    expect(createControl()).not.toBeNull();
  });

  it('shows nothing for the whole session when the union lookup errors', async () => {
    h.unionLookup = Promise.resolve({
      data: null,
      error: { code: '57014', message: 'statement timeout' },
    });
    await mountOnNlhTab();

    expect(screen.getByRole('tab', { name: /NLH/ })).toBeTruthy();
    expect(createControl()).toBeNull();
  });

  it('shows nothing for a club linked to a union through union_clubs alone', async () => {
    h.unionLookup = Promise.resolve({ data: { union_id: 'union-a' }, error: null });
    await mountOnNlhTab();

    expect(createControl()).toBeNull();
  });
});
