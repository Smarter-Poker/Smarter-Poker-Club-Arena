/**
 * The club lobby, two repairs (integration I4, 2026-09-23).
 *
 * - The club tag line is typed by the owner, so it is data, and data is Title
 *   Cased where it is printed (skill v1.5.0). It printed raw.
 * - Closing the opening wizard re-reads the setup state once, through the
 *   page's existing load path and with no timer, so a close that followed a
 *   setup the server already holds ("Already Completed") resolves the
 *   checklist step without a reload. It used to stay on Start Setup.
 *
 * The harness is the reduced shape of clubHomeOpeningChecklistMounted.phase2.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  register: vi.fn(),
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
  fetchRemoteViewPrefs: async () => null,
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
        Promise.resolve({
          data: table === 'tournaments' ? h.tournaments : table === 'tables' ? h.tables : [],
          error: null,
        })
      ).then(resolve, reject);
    return q;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mountLobby(query = '') {
  const read = h.clubReads.length;
  render(
    <MemoryRouter initialEntries={['/clubs/club-a' + query]}>
      <Routes>
        <Route path="/clubs/:clubId" element={<ClubHomePage />} />
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
}

const wizardRow = () => screen.getByText('Club Defaults').closest('article') as HTMLElement;

describe('the club tag line', () => {
  it('prints Title Cased, as every string a player reads', async () => {
    h.tagline = 'all sharks welcome, bring your A game';
    h.setupReads = [DONE];
    await mountLobby();

    const line = document.querySelector('.club-lobby-command-top__tagline');
    expect(line?.textContent).toBe('All Sharks Welcome, Bring Your A Game');
  });
});

describe('closing the opening wizard', () => {
  it('reads the setup state once more, so a setup already held resolves the step', async () => {
    h.setupReads = [NOT_DONE, DONE];
    await mountLobby();
    expect(h.setupCalls).toBe(1);
    fireEvent.click(within(wizardRow()).getByRole('button', { name: 'Open Setup' }));
    expect(screen.getByRole('dialog', { name: 'Opening Setup Stub' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close Opening Setup Stub' }));
    await settle();

    expect(screen.queryByRole('dialog', { name: 'Opening Setup Stub' })).toBeNull();
    expect(h.setupCalls).toBe(2);
    expect(within(wizardRow()).getByRole('button', { name: 'Done' })).toBeTruthy();

    /* One read per close, and nothing on a timer afterwards. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(h.setupCalls).toBe(2);
  });
});

/** Live certification uses a reserved cash-only club, so the optional live
 * MTT case may have no input. This mounts the real owning page with synthetic
 * read results, every admitted status, and its actual React Router callback.
 * No database fixture, registration, chips or fabricated live result. */
describe('the tournament row reviews every lobby-admitted status', () => {
  it.each(['REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON', 'BAGGED'])(
    '%s selects its own screen without registering',
    async (status) => {
      h.setupReads = [DONE];
      h.tournaments = [
        {
          id: 'event-a',
          club_id: 'club-a',
          name: 'Synthetic MTT',
          format_contract: 'mtt-v1',
          variant: 'mtt',
          game_type: 'NLH',
          status,
          start_time: new Date().toISOString(),
          started_at: new Date().toISOString(),
          current_players: 2,
          max_players: null,
          buy_in_amount: 10,
          buy_in_fee: 1,
          starting_chips: 1000,
          table_size: 9,
          blind_structure: [],
          is_private: true,
        },
      ];
      await mountLobby();
      fireEvent.click(screen.getByRole('button', { name: 'Tournaments', exact: true }));
      fireEvent.click(screen.getByRole('tab', { name: "MTT'S", exact: true }));
      await flush();
      const row = document.querySelector('.lt-row[data-kind="mtt"][data-id="event-a"]');
      expect(row, 'the actual lobby did not render the synthetic admitted event').not.toBeNull();
      fireEvent.click(row!);
      await flush();
      expect(screen.queryByTestId('tournament-destination')).toBeNull();
      const panel = screen.getByRole('dialog');
      expect(panel.querySelector('.glp__arena-card')).not.toBeNull();
      fireEvent.click(within(panel).getByRole('button', { name: 'Details', exact: true }));
      await flush();
      expect(screen.getByTestId('tournament-destination')).toBeTruthy();
      expect(h.register).not.toHaveBeenCalled();
      expect(
        h.rpc.mock.calls.some(([name]) => /register|buyin|buy_in|purchase/i.test(String(name)))
      ).toBe(false);
    }
  );
});

describe('Find Your Game starts with two separate sections', () => {
  it('requires a choice, separates controls and results, switches and closes', async () => {
    h.setupReads = [DONE];
    h.tables = [
      {
        id: 'cash-a',
        club_id: 'club-a',
        name: 'Cash Fixture',
        game_variant: 'nlh',
        status: 'running',
        max_players: 6,
        current_players: 2,
        small_blind: 1,
        big_blind: 2,
        min_buy_in: 40,
        max_buy_in: 200,
      },
    ];
    h.tournaments = [
      {
        id: 'event-a',
        club_id: 'club-a',
        name: 'Tournament Fixture',
        format_contract: 'mtt-v1',
        variant: 'mtt',
        game_type: 'NLH',
        status: 'REGISTERING',
        start_time: new Date().toISOString(),
        current_players: 2,
        buy_in_amount: 10,
        buy_in_fee: 1,
        starting_chips: 1000,
        table_size: 9,
      },
    ];
    await mountLobby();
    const cash = screen.getByRole('button', { name: 'Cash Games', exact: true });
    const tournaments = screen.getByRole('button', { name: 'Tournaments', exact: true });
    expect(cash.getAttribute('aria-expanded')).toBe('false');
    expect(tournaments.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('tablist', { name: 'Game Type' })).toBeNull();
    expect(document.querySelector('.club-home__games')?.hasAttribute('hidden')).toBe(true);
    expect(screen.queryByText('Live Club Schedule')).toBeNull();
    expect(document.querySelector('.lobby-controls__total')).toBeNull();

    fireEvent.click(cash);
    await flush();
    const names = () =>
      within(screen.getByRole('tablist', { name: 'Game Type' }))
        .getAllByRole('tab')
        .map((t) => t.textContent);
    expect(names()).toEqual(['ALL', 'NLH', 'PLO', 'LIMIT']);
    expect(
      within(screen.getByLabelText('Game Status'))
        .getAllByRole('button')
        .map((t) => t.textContent)
    ).toEqual(['All', 'Running']);
    expect(document.querySelector('.lt-row[data-id="cash-a"]')).not.toBeNull();
    expect(document.querySelector('.lt-row[data-id="event-a"]')).toBeNull();
    expect(document.querySelector('.club-home__games')?.hasAttribute('hidden')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'PLO', exact: true }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Filters And Sort', exact: true }));
    await flush();
    const filterTabs = within(screen.getByRole('dialog', { name: 'Advanced Filters' })).getByRole(
      'group',
      { name: 'Game Type' }
    );
    expect(
      within(filterTabs)
        .getAllByRole('button')
        .map((t) => t.textContent)
    ).not.toContain("MTT'S");
    fireEvent.click(screen.getByRole('button', { name: 'Close Game Filters' }));
    await flush();
    fireEvent.click(tournaments);
    await flush();
    expect(names()).toEqual(["MTT'S", 'SPINS', "SIT N GO'S", 'SATELLITES']);
    expect(document.querySelector('.lt-row[data-id="event-a"]')).not.toBeNull();
    expect(document.querySelector('.lt-row[data-id="cash-a"]')).toBeNull();
    expect(cash.getAttribute('aria-expanded')).toBe('false');
    expect(tournaments.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(tournaments);
    await flush();
    expect(screen.queryByRole('tablist', { name: 'Game Type' })).toBeNull();
    expect(document.querySelector('.club-home__games')?.hasAttribute('hidden')).toBe(true);
    expect(h.register).not.toHaveBeenCalled();
  });
});

it('opens the saved cash section and tab immediately on return', async () => {
  h.setupReads = [DONE];
  localStorage.setItem(
    'ca_lobby_view_viewer:club-a',
    JSON.stringify({ tab: 'OMAHA', sortByTab: {}, favoritesOnly: false })
  );
  await mountLobby();
  expect(screen.getByRole('button', { name: 'Cash Games', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(screen.getByRole('tab', { name: 'PLO', exact: true }).getAttribute('aria-selected')).toBe(
    'true'
  );
});

it('shows only recorded MTT and SNG satellites when Satellites is selected', async () => {
  h.setupReads = [DONE];
  const row = {
    club_id: 'club-a',
    game_type: 'NLH',
    status: 'REGISTERING',
    start_time: new Date().toISOString(),
    current_players: 0,
    buy_in_amount: 10,
    buy_in_fee: 1,
    starting_chips: 1000,
    table_size: 9,
  };
  h.tournaments = [
    {
      ...row,
      id: 'sat-mtt',
      name: 'MTT Qualifier',
      format_contract: 'mtt-v1',
      tournament_type: 'SATELLITE',
    },
    {
      ...row,
      id: 'sat-sng',
      name: 'SNG Qualifier',
      format_contract: 'seat-first-satellite-v1',
      max_players: 2,
    },
    { ...row, id: 'regular-mtt', name: 'Satellite Name Only', format_contract: 'mtt-v1' },
    { ...row, id: 'regular-sng', name: 'Regular SNG', format_contract: 'sng-v1', max_players: 6 },
  ];
  await mountLobby();
  fireEvent.click(screen.getByRole('button', { name: 'Tournaments', exact: true }));
  fireEvent.click(screen.getByRole('tab', { name: 'SATELLITES', exact: true }));
  await flush();
  for (const id of ['sat-mtt', 'sat-sng'])
    expect(document.querySelector(`.lt-row[data-id="${id}"]`)).not.toBeNull();
  for (const id of ['regular-mtt', 'regular-sng'])
    expect(document.querySelector(`.lt-row[data-id="${id}"]`)).toBeNull();
  expect(h.register).not.toHaveBeenCalled();
});
