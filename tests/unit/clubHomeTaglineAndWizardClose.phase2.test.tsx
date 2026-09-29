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
vi.mock('../../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
vi.mock('../../src/hooks/useMaintenanceBreak', () => ({
  useMaintenanceBreak: () => ({
    maintenanceBreak: { active: false, phase: 'idle', breakEndsAtMs: null, reason: '' },
  }),
}));
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
      (result?.promise ?? Promise.resolve({ data: [], error: null })).then(resolve, reject);
    return q;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mountLobby() {
  const read = h.clubReads.length;
  render(
    <MemoryRouter initialEntries={['/clubs/club-a']}>
      <Routes>
        <Route path="/clubs/:clubId" element={<ClubHomePage />} />
      </Routes>
    </MemoryRouter>
  );
  await flush();
  await act(async () => h.clubReads[read].resolve({ data: newClub(), error: null }));
  await settle();
}

const wizardRow = () =>
  screen.getByText('Complete The Opening Setup Wizard').closest('article') as HTMLElement;

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
    fireEvent.click(within(wizardRow()).getByRole('button', { name: 'Start Setup' }));
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
