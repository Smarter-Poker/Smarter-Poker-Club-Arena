/** Mounted lobby navigation regression: real router, synthetic reads, no purchases. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type SetupRead = {
  data: { completed_at: string | null } | null;
  error: { code: string; message: string } | null;
};

const h = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  clubReads: [] as any[],
  setupReads: [] as SetupRead[],
  setupCalls: 0,
  tagline: null as string | null,
  tournaments: [] as any[],
  tables: [] as any[],
  /* When set, the tournament list read waits on it (a slow tournaments query). */
  tournamentGate: null as Promise<void> | null,
  register: vi.fn(),
  remoteView: vi.fn(),
  remoteFilters: vi.fn(),
  pushView: vi.fn(),
  pushFilters: vi.fn(),
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
// This lobby test owns no engine fixture. Keep its scope on the rendered tag
// line and setup reread instead of letting speculative table warm-up contact a
// developer engine on localhost:8080 and print a connection error.
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
vi.mock('../../src/utils/ChunkPreloader', () => ({
  prefetchIntent: vi.fn(),
  preloadRoute: vi.fn(),
}));
vi.mock('../../src/hooks/useMaintenanceBreak', () => ({
  useMaintenanceBreak: () => ({
    maintenanceBreak: { active: false, phase: 'idle', breakEndsAtMs: null, reason: '' },
  }),
}));
vi.mock('../../src/components/wallet/DynamicWallet', () => ({ default: () => null }));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: vi.fn() }));
vi.mock('../../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register: h.register, isRegistering: false }),
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
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/lobby/lobbyViewPrefs', async (original) => ({
  ...(await original<any>()),
  fetchRemoteViewPrefs: h.remoteView,
  pushRemoteViewPrefs: h.pushView,
}));
vi.mock('../../src/components/lobby/AdvancedFilters', async (original) => ({
  ...(await original<any>()),
  fetchRemoteFilters: h.remoteFilters,
  pushRemoteFilters: h.pushFilters,
}));
/* The wizard itself is proven elsewhere; here only its close matters. */
vi.mock('../../src/components/club/ClubOpeningWizard', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Opening Setup Stub">
      <button type="button" onClick={onClose}>
        Close Opening Setup Stub
      </button>
    </div>
  ),
}));

import ClubHomePage from '../../src/pages/ClubHomePage';
import { emptyFilterValue, FILTER_SPECS } from '../../src/components/lobby/advancedFilterSpec';

const deferred = <T = any,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => act(async () => {});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
  }
};

const NOT_DONE: SetupRead = { data: { completed_at: null }, error: null };
const DONE: SetupRead = { data: { completed_at: '2026-09-23T11:00:00Z' }, error: null };

/** A new standalone club the viewer owns, exactly as the checklist harness has it. */
const newClub = () => ({
  id: 'club-a',
  club_id: 1,
  name: 'Test Club',
  member_count: 1,
  owner_id: 'viewer',
  union_id: null,
  is_union: false,
  opening_checklist_started_at: '2026-09-20T10:00:00Z',
  logo_url: '/hub/club-arena/club-logos/preset-09.webp',
  avatar_url: null,
  tagline: h.tagline,
  chip_treasury: 100000,
  spins_enabled: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  h.clubReads.length = 0;
  h.setupReads = [];
  h.setupCalls = 0;
  h.tagline = null;
  h.tournaments = [];
  h.tables = [];
  h.tournamentGate = null;
  h.remoteView.mockResolvedValue(null);
  h.remoteFilters.mockResolvedValue(null);
  h.rpc.mockImplementation((name: string) => {
    if (name === 'fn_club_opening_checklist_state') {
      return Promise.resolve({
        data: { clubId: 'club-a', completedAt: null, skippedTaskIds: [] },
        error: null,
      });
    }
    return Promise.resolve({ data: 0, error: null });
  });
  h.from.mockImplementation((table: string) => {
    const result = table === 'clubs' ? deferred() : null;
    if (result) h.clubReads.push(result);
    const q: any = {};
    for (const method of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit', 'in', 'lte'])
      q[method] = () => q;
    q.maybeSingle = () => {
      if (result) return result.promise;
      if (table === 'club_opening_setups') {
        h.setupCalls += 1;
        return Promise.resolve(h.setupReads.shift() ?? { data: null, error: null });
      }
      if (table === 'union_clubs') return Promise.resolve({ data: null, error: null });
      if (table === 'club_members') {
        return Promise.resolve({ data: { role: 'owner', status: 'active' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    q.then = (resolve: any, reject: any) =>
      (
        result?.promise ??
        (table === 'tournaments' && h.tournamentGate
          ? h.tournamentGate.then(() => ({ data: h.tournaments, error: null }))
          : Promise.resolve({
              data: table === 'tournaments' ? h.tournaments : table === 'tables' ? h.tables : [],
              error: null,
            }))
      ).then(resolve, reject);
    return q;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The router's current query string, for asserting what ?game says. */
function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

async function mountLobby(deepLink: boolean | string = true, openCash = true) {
  const read = h.clubReads.length;
  const game = deepLink === true ? 'anchor' : deepLink || null;
  render(
    <MemoryRouter initialEntries={[game ? `/clubs/club-a?game=${game}` : '/clubs/club-a']}>
      <SearchProbe />
      <Routes>
        <Route path="/clubs/:clubId" element={<ClubHomePage />} />
        <Route
          path="/lightning/:id"
          element={<div data-testid="lightning-destination">Lightning Entry</div>}
        />
        <Route
          path="/tournaments/:id"
          element={<div data-testid="tournament-destination">Tournament Review</div>}
        />
      </Routes>
    </MemoryRouter>
  );
  await flush();
  await act(async () => h.clubReads[read].resolve({ data: newClub(), error: null }));
  await settle();
  if (!deepLink && openCash) {
    fireEvent.click(screen.getByRole('button', { name: 'Cash Games', exact: true }));
    await settle();
  }
}

it('keeps Join Lightning navigation after selected-panel URL effects settle, without a purchase', async () => {
  h.setupReads = [DONE];
  h.tables = [
    {
      id: 'anchor',
      club_id: 'club-a',
      name: 'PLO5 Lightning Games',
      game_variant: 'plo5',
      game_type: 'cash',
      status: 'running',
      lifecycle: 'live',
      max_players: 6,
      current_players: 3,
      small_blind: 1,
      big_blind: 2,
      min_buy_in: 200,
      max_buy_in: 400,
      cluster_id: 'cluster',
      cluster_mode: 'lightning',
      cluster_must_move: true,
      cluster_enabled: true,
      cluster_template: 'madness',
      cluster_handedness: 6,
      role: 'main',
      main_index: 1,
    },
  ];
  await mountLobby();
  const join = screen.getByRole('button', { name: 'Join Lightning', exact: true });
  fireEvent.click(join);
  await settle();
  expect(screen.getByTestId('lightning-destination')).toBeTruthy();
  expect(
    h.rpc.mock.calls.some(([name]) => name === 'fn_cash_game_join' || name === 'atomic_table_buyin')
  ).toBe(false);
});

const ordinaryTable = (id: string, variant: string, name: string) => ({
  id,
  club_id: 'club-a',
  name,
  game_variant: variant,
  game_type: 'cash',
  status: 'running',
  lifecycle: 'live',
  max_players: 6,
  current_players: 3,
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 100,
  max_buy_in: 400,
});

for (const lateRead of ['view', 'filters'] as const) {
  it(`keeps an explicitly selected card when saved ${lateRead} arrive late, without saving a preference`, async () => {
    h.setupReads = [DONE];
    h.tables = [
      ordinaryTable('anchor', 'nlh', 'Holdem Chosen'),
      ordinaryTable('omaha', 'plo5', 'Omaha Other'),
      ordinaryTable('pineapple', 'pineapple', 'Pineapple Other'),
    ];
    const late = deferred<any>();
    if (lateRead === 'view') h.remoteView.mockReturnValue(late.promise);
    else h.remoteFilters.mockReturnValue(late.promise);
    await mountLobby(false);
    if (lateRead === 'filters') {
      fireEvent.click(screen.getByRole('tab', { name: 'NLH', exact: true }));
      await settle();
    }
    h.pushView.mockClear();
    h.pushFilters.mockClear();
    fireEvent.click(document.querySelector('.lt-row[data-id="anchor"]')!);
    await flush();
    expect(screen.getByRole('dialog', { name: 'Holdem Chosen Lobby' })).toBeTruthy();
    await act(async () =>
      late.resolve(
        lateRead === 'view'
          ? { tab: 'OMAHA', sortByTab: {}, favoritesOnly: false }
          : { HOLDEM: { ...emptyFilterValue(FILTER_SPECS.HOLDEM), games: ['pineapple'] } }
      )
    );
    await settle();
    expect(screen.getByRole('dialog', { name: 'Holdem Chosen Lobby' })).toBeTruthy();
    expect(h.pushView).not.toHaveBeenCalled();
    expect(h.pushFilters).not.toHaveBeenCalled();
    // An explicit tab change still filters the chosen game out and closes it.
    fireEvent.click(screen.getByRole('tab', { name: 'PLO', exact: true }));
    await flush();
    expect(screen.queryByRole('dialog', { name: 'Holdem Chosen Lobby' })).toBeNull();
  });
}

it('applies saved view held for an open card when it closes, and a later tap saves the newer row', async () => {
  h.setupReads = [DONE];
  h.tables = [
    ordinaryTable('anchor', 'nlh', 'Holdem Chosen'),
    ordinaryTable('omaha', 'plo5', 'Omaha Other'),
  ];
  const late = deferred<any>();
  h.remoteView.mockReturnValue(late.promise);
  localStorage.setItem(
    'ca_lobby_view_viewer:club-a',
    JSON.stringify({ tab: 'HOLDEM', sortByTab: {}, favoritesOnly: false })
  );
  await mountLobby(false, false);
  fireEvent.click(document.querySelector('.lt-row[data-id="anchor"]')!);
  await flush();
  expect(screen.getByRole('dialog', { name: 'Holdem Chosen Lobby' })).toBeTruthy();
  // Another device saved PLO with Favorites on. It lands while the card is open.
  await act(async () => late.resolve({ tab: 'OMAHA', sortByTab: {}, favoritesOnly: true }));
  await settle();
  // The open card is left alone...
  expect(screen.getByRole('dialog', { name: 'Holdem Chosen Lobby' })).toBeTruthy();
  expect(h.pushView).not.toHaveBeenCalled();
  // ...and the held view applies once the player closes it.
  fireEvent.click(screen.getByRole('button', { name: 'Close Game Lobby', exact: true }));
  await settle();
  expect(screen.getByRole('tab', { name: 'PLO', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  // A later tap merges into the newer row: Favorites stays on in what is saved.
  h.pushView.mockClear();
  fireEvent.click(screen.getByRole('tab', { name: 'NLH', exact: true }));
  await settle();
  expect(h.pushView).toHaveBeenCalled();
  expect(h.pushView.mock.calls.at(-1)?.[1]).toMatchObject({ tab: 'HOLDEM', favoritesOnly: true });
});

/* ── A SHARED ?game=<id> LINK OPENS OFF-TAB GAMES (2026-10-25) ──────────────
   The link opened a card only if the game was on the first visible list: the
   player's saved tab, its filters and Favorites, and on a cached boot the
   cached tables alone. A link to anything else was dropped and ?game stripped. */
describe('a shared game link', () => {
  const saveTab = (tab: string, favoritesOnly = false) =>
    localStorage.setItem(
      'ca_lobby_view_viewer:club-a',
      JSON.stringify({ tab, sortByTab: {}, favoritesOnly })
    );
  const tab = (name: string) => screen.getByRole('tab', { name, exact: true });
  const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');
  const mtt = (id: string, name: string) => ({
    id,
    club_id: 'club-a',
    name,
    format_contract: 'mtt-v1',
    game_type: 'nlh',
    variant: 'freezeout',
    status: 'REGISTERING',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    buy_in_amount: 10,
    buy_in_fee: 1,
    current_players: 2,
    max_players: null,
    starting_chips: 10000,
  });

  it('opens a PLO table from a saved NLH tab on the PLO tab, saving nothing', async () => {
    h.setupReads = [DONE];
    saveTab('HOLDEM');
    h.tables = [
      ordinaryTable('holdem', 'nlh', 'Holdem Saved Tab'),
      ordinaryTable('omaha', 'plo5', 'Omaha Linked'),
    ];
    await mountLobby('omaha');
    expect(screen.getByRole('dialog', { name: 'Omaha Linked Lobby' })).toBeTruthy();
    expect(tab('PLO')).toHaveAttribute('aria-selected', 'true');
    expect(search().get('game')).toBe('omaha');
    expect(h.pushView).not.toHaveBeenCalled();
    expect(h.pushFilters).not.toHaveBeenCalled();
    // The saved tab is untouched, so the next visit opens on NLH again.
    expect(JSON.parse(localStorage.getItem('ca_lobby_view_viewer:club-a')!).tab).toBe('HOLDEM');
    // An explicit tab change still filters the linked game out and closes it.
    fireEvent.click(tab('NLH'));
    await flush();
    expect(screen.queryByRole('dialog', { name: 'Omaha Linked Lobby' })).toBeNull();
  });

  it('opens a game its own tab hides behind saved filters and Favorites, saving nothing', async () => {
    h.setupReads = [DONE];
    saveTab('HOLDEM', true);
    localStorage.setItem(
      'ca_advanced_filters_viewer:club-a',
      JSON.stringify({ OMAHA: { ...emptyFilterValue(FILTER_SPECS.OMAHA), games: ['plo4'] } })
    );
    h.tables = [
      ordinaryTable('holdem', 'nlh', 'Holdem Saved Tab'),
      ordinaryTable('plo4', 'plo4', 'Omaha Four'),
      ordinaryTable('omaha', 'plo5', 'Omaha Linked'),
    ];
    await mountLobby('omaha');
    expect(screen.getByRole('dialog', { name: 'Omaha Linked Lobby' })).toBeTruthy();
    expect(tab('PLO')).toHaveAttribute('aria-selected', 'true');
    expect(h.pushView).not.toHaveBeenCalled();
    expect(h.pushFilters).not.toHaveBeenCalled();
    // The exemption is for the link's own card: closed, the saved narrowing
    // governs the board again and the linked row leaves it.
    fireEvent.click(screen.getByRole('button', { name: 'Close Game Lobby', exact: true }));
    await settle();
    expect(document.querySelector('.lt-row[data-id="omaha"]')).toBeNull();
    expect(h.pushView).not.toHaveBeenCalled();
    expect(h.pushFilters).not.toHaveBeenCalled();
  });

  it('still drops a link to a game in neither list and removes ?game', async () => {
    h.setupReads = [DONE];
    saveTab('HOLDEM');
    h.tables = [ordinaryTable('holdem', 'nlh', 'Holdem Saved Tab')];
    h.tournaments = [mtt('event', 'Nightly Event')];
    await mountLobby('gone');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(search().has('game')).toBe(false);
    expect(screen.getByRole('button', { name: 'Cash Games', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(h.pushView).not.toHaveBeenCalled();
    expect(h.pushFilters).not.toHaveBeenCalled();
    // Dropped, not lying in wait: a game later appearing under that id on a
    // background refresh does not pop its card open over the lobby.
    h.tables = [...h.tables, ordinaryTable('gone', 'plo5', 'Late Arrival')];
    const reads = h.clubReads.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(h.clubReads.length).toBe(reads + 1);
    await act(async () => h.clubReads[reads].resolve({ data: newClub(), error: null }));
    await settle();
    expect(document.querySelector('.lt-row[data-id="gone"]')).toBeNull();
    fireEvent.click(tab('PLO'));
    await settle();
    expect(document.querySelector('.lt-row[data-id="gone"]')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a tournament the boot cache does not hold once tournaments load', async () => {
    h.setupReads = [DONE];
    const cachedTables = [ordinaryTable('holdem', 'nlh', 'Holdem Cached')];
    localStorage.setItem(
      'club_home_cache_v4_club-a',
      JSON.stringify({ at: Date.now(), data: { club: newClub(), tables: cachedTables } })
    );
    h.tables = cachedTables;
    h.tournaments = [mtt('event', 'Nightly Event')];
    const gate = deferred<void>();
    h.tournamentGate = gate.promise;
    await mountLobby('event');
    // No family opens until the requested tournament has answered.
    expect(document.querySelector('.lt-row[data-id="holdem"]')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => gate.resolve());
    await settle();
    expect(screen.getByRole('dialog', { name: 'Nightly Event Lobby' })).toBeTruthy();
    expect(search().get('game')).toBe('event');
    expect(h.pushView).not.toHaveBeenCalled();
    expect(h.pushFilters).not.toHaveBeenCalled();
  });
});

it('keeps an explicitly opened cash section when a late preference names a tournament', async () => {
  h.setupReads = [DONE];
  h.tables = [ordinaryTable('anchor', 'nlh', 'Cash Family')];
  const late = deferred<any>();
  h.remoteView.mockReturnValue(late.promise);
  await mountLobby(false);
  h.pushView.mockClear();
  await act(async () => late.resolve({ tab: 'MTT', sortByTab: {}, favoritesOnly: false }));
  await settle();
  expect(screen.getByRole('button', { name: 'Cash Games', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(screen.getByRole('tab', { name: 'ALL', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(screen.queryByRole('tab', { name: 'MTT', exact: true })).toBeNull();
  expect(document.querySelector('.lt-row[data-id="anchor"]')).not.toBeNull();
  expect(h.pushView).not.toHaveBeenCalled();
});

it('restores the remote tournament family over an older cached cash preference before interaction', async () => {
  h.setupReads = [DONE];
  localStorage.setItem(
    'ca_lobby_view_viewer:club-a',
    JSON.stringify({ tab: 'HOLDEM', sortByTab: {}, favoritesOnly: false })
  );
  const late = deferred<any>();
  h.remoteView.mockReturnValue(late.promise);
  await mountLobby(false, false);
  expect(screen.getByRole('button', { name: 'Cash Games', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await act(async () => late.resolve({ tab: 'MTT', sortByTab: {}, favoritesOnly: false }));
  await settle();
  expect(screen.getByRole('button', { name: 'Tournaments', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(screen.getByRole('tab', { name: 'MTT', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(h.pushView).not.toHaveBeenCalled();
});
