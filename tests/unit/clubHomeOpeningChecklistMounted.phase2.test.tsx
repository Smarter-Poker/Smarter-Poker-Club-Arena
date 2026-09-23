/**
 * Create A Club, Phase 2 (2026-09-20): the opening checklist, mounted in the
 * real club lobby.
 *
 * - The lobby and the checklist resolve skips from ONE state, so the moment
 *   the last open step is skipped the checklist and the lobby's
 *   `data-opening-checklist` layout attribute drop together.
 * - The checklist is the owner's: a co-owner or admin never gets a list whose
 *   owner-only steps they could never finish.
 * - A failed read of the setup state is retried once at once and once more on
 *   the page's next natural refresh, and never on a timer.
 * - (2026-09-23) The owner's skips and the completion latch live on the
 *   server. The checklist waits for the latch to be read, a latched club never
 *   shows it (nor the layout attribute, the wizard or the setup read), the
 *   latch is asked for once when every step is resolved, and any failure falls
 *   back to today's local behaviour.
 *
 * The harness is the reduced shape of clubHomeRecoveryOwnership.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type SetupRead = {
  data: { completed_at: string | null } | null;
  error: { code: string; message: string } | null;
};
type RpcReply = { data: unknown; error: { code: string; message: string } | null };

const h = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  clubReads: [] as any[],
  role: 'owner',
  ownerId: 'viewer',
  setupReads: [] as SetupRead[],
  setupCalls: 0,
  /* The server's checklist store for club-a. */
  serverSkips: [] as string[],
  latch: null as string | null,
  stateReplies: [] as Promise<RpcReply>[],
  latchReplies: [] as Promise<RpcReply>[],
  stateCalls: 0,
  latchCalls: 0,
  skipCalls: [] as Array<Record<string, unknown>>,
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

import ClubHomePage from '../../src/pages/ClubHomePage';
import { reportError } from '../../src/utils/errorReporter';

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

const FAILED: SetupRead = { data: null, error: { code: '57014', message: 'statement timeout' } };
const DONE: SetupRead = { data: { completed_at: '2026-09-20T11:00:00Z' }, error: null };
const LATCHED_AT = '2026-09-23T10:00:00.123456+00:00';
const SKIP_KEY = 'club-launch-skips:club-a:viewer';
const OPTIONAL = [
  'identity',
  'tagline',
  'nlh',
  'plo',
  'limit',
  'mtt',
  'spin',
  'heads-up',
  'first-player',
  'first-agent',
];
const checklistState = (): RpcReply => ({
  data: { clubId: 'club-a', completedAt: h.latch, skippedTaskIds: [...h.serverSkips] },
  error: null,
});

/** A club created after the checklist shipped: standalone, one member, the
    placeholder crest creation stores, no tag line, no games, no agent. */
const newClub = () => ({
  id: 'club-a',
  club_id: 1,
  name: 'Test Club',
  member_count: 1,
  owner_id: h.ownerId,
  union_id: null,
  is_union: false,
  opening_checklist_started_at: '2026-09-20T10:00:00Z',
  logo_url: '/hub/club-arena/club-logos/preset-09.webp',
  avatar_url: null,
  tagline: null,
  chip_treasury: 100000,
  spins_enabled: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  h.clubReads.length = 0;
  h.role = 'owner';
  h.ownerId = 'viewer';
  h.setupReads = [];
  h.setupCalls = 0;
  h.serverSkips = [];
  h.latch = null;
  h.stateReplies = [];
  h.latchReplies = [];
  h.stateCalls = 0;
  h.latchCalls = 0;
  h.skipCalls = [];
  h.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'fn_club_opening_checklist_state') {
      h.stateCalls += 1;
      return h.stateReplies.shift() ?? Promise.resolve(checklistState());
    }
    if (name === 'fn_club_opening_checklist_skip') {
      h.skipCalls.push(args);
      const id = String(args.p_task_id);
      h.serverSkips = args.p_skipped
        ? [...new Set([...h.serverSkips, id])]
        : h.serverSkips.filter((s) => s !== id);
      return Promise.resolve(checklistState());
    }
    if (name === 'fn_club_opening_checklist_complete') {
      h.latchCalls += 1;
      const queued = h.latchReplies.shift();
      if (queued) return queued;
      h.latch ??= LATCHED_AT;
      return Promise.resolve(checklistState());
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
        return Promise.resolve({ data: { role: h.role, status: 'active' }, error: null });
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

const lobby = () => document.querySelector('.club-lobby-machine') as HTMLElement;
const wizardRow = () =>
  screen.getByText('Complete The Opening Setup Wizard').closest('article') as HTMLElement;

describe('the lobby and the checklist resolve skips from one state', () => {
  it('drops the checklist and the lobby layout attribute in the same render', async () => {
    h.setupReads = [DONE];
    /* Skips an older build kept in this browser: moved to the server once. */
    localStorage.setItem(
      SKIP_KEY,
      JSON.stringify([
        'identity',
        'tagline',
        'nlh',
        'plo',
        'limit',
        'mtt',
        'spin',
        'heads-up',
        'first-player',
      ])
    );
    await mountLobby();

    expect(screen.getByText('New Club Opening Checklist')).toBeTruthy();
    expect(lobby().getAttribute('data-opening-checklist')).toBe('true');
    expect(h.skipCalls).toHaveLength(9);
    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
    expect(h.latchCalls).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Skip Configure Your First Agent' }));

    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
    expect(lobby().hasAttribute('data-opening-checklist')).toBe(false);

    /* Every step is resolved: the server is asked, once, to latch it. */
    await settle();
    expect(h.skipCalls.at(-1)).toEqual({
      p_club_id: 'club-a',
      p_task_id: 'first-agent',
      p_skipped: true,
    });
    expect(h.latchCalls).toBe(1);
    expect(h.latch).toBe(LATCHED_AT);
  });

  it('counts the placeholder crest as no picture, so the picture step stays open', async () => {
    h.setupReads = [DONE];
    await mountLobby();

    const row = screen.getByText('Choose A Club Profile Picture').closest('article') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Add Picture' })).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'Skip Choose A Club Profile Picture' })
    ).toBeTruthy();
  });
});

describe('the opening checklist is the owner’s', () => {
  it('is not shown to a co-owner, whose setup and agent state is never loaded', async () => {
    h.ownerId = 'club-owner';
    h.role = 'co_owner';
    await mountLobby();

    expect(screen.getByText('Find Your Game')).toBeTruthy();
    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
    expect(lobby().hasAttribute('data-opening-checklist')).toBe(false);
    expect(h.setupCalls).toBe(0);
    /* The checklist store answers the owner alone, so it is never asked. */
    expect(h.stateCalls).toBe(0);
  });

  it('is shown to the owner, with the setup wizard as its one required step', async () => {
    await mountLobby();

    expect(screen.getByText('New Club Opening Checklist')).toBeTruthy();
    expect(within(wizardRow()).queryByRole('button', { name: /^Skip/ })).toBeNull();
    expect(within(wizardRow()).getByRole('button', { name: 'Start Setup' })).toBeTruthy();
  });
});

describe('a failed setup-state read', () => {
  it('is retried once at once', async () => {
    h.setupReads = [FAILED, DONE];
    await mountLobby();

    expect(h.setupCalls).toBe(2);
    expect(within(wizardRow()).getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('is asked once more on the next natural refresh, never on a timer', async () => {
    h.setupReads = [FAILED, FAILED, DONE];
    await mountLobby();

    expect(h.setupCalls).toBe(2);
    expect(within(wizardRow()).getByRole('button', { name: 'Start Setup' })).toBeTruthy();

    /* A minute passes with the tab visible and nothing happening: no timer
       asks again. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(h.setupCalls).toBe(2);

    /* The page's own natural refresh: the tab comes back after 30 s. */
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();

    expect(h.setupCalls).toBe(3);
    expect(within(wizardRow()).getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});

describe('the checklist is finished once (server latch, 2026-09-23)', () => {
  it('never shows on a latched club: no checklist, no layout attribute, no setup read', async () => {
    /* The club still has open steps by live data (one member, no games):
       before the latch, this is exactly the checklist that came back. */
    h.latch = '2026-09-21T09:00:00+00:00';
    await mountLobby();

    expect(screen.getByText('Find Your Game')).toBeTruthy();
    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
    expect(screen.queryByText('Complete The Opening Setup Wizard')).toBeNull();
    expect(lobby().hasAttribute('data-opening-checklist')).toBe(false);
    expect(h.stateCalls).toBe(1);
    expect(h.setupCalls).toBe(0);
    expect(h.latchCalls).toBe(0);
  });

  it('draws nothing, and reads no setup, until the latch has been read', async () => {
    const pending = deferred<RpcReply>();
    h.stateReplies = [pending.promise];
    await mountLobby();

    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
    expect(lobby().hasAttribute('data-opening-checklist')).toBe(false);
    expect(h.setupCalls).toBe(0);

    await act(async () => pending.resolve(checklistState()));
    await settle();
    expect(screen.getByText('New Club Opening Checklist')).toBeTruthy();
    expect(h.setupCalls).toBe(1);
  });

  it('asks for the latch once, the first time every step is resolved, and never again', async () => {
    h.setupReads = [DONE];
    h.serverSkips = [...OPTIONAL];
    await mountLobby();

    expect(h.latchCalls).toBe(1);
    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
    expect(lobby().hasAttribute('data-opening-checklist')).toBe(false);

    /* A minute with nothing happening, then the page's own natural refresh:
       no timer asks again and the checklist does not come back. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(h.latchCalls).toBe(1);
    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
  });

  it('a failed latch is reported, asked once, and leaves today behaviour in place', async () => {
    h.setupReads = [DONE];
    h.serverSkips = [...OPTIONAL];
    h.latchReplies = [
      Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } }),
    ];
    await mountLobby();

    expect(h.latchCalls).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: '57014' }),
      'ClubLaunchSkips.latch_failed'
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(h.latchCalls).toBe(1);
    /* Every step is resolved, so it is hidden exactly as before the latch. */
    expect(screen.queryByText('New Club Opening Checklist')).toBeNull();
  });

  it('writes a skip to the server, and the skip survives a reload', async () => {
    await mountLobby();
    fireEvent.click(screen.getByRole('button', { name: 'Skip Choose A Club Profile Picture' }));
    await settle();

    expect(h.skipCalls).toEqual([{ p_club_id: 'club-a', p_task_id: 'identity', p_skipped: true }]);
    expect(localStorage.getItem(SKIP_KEY)).toBeNull();

    cleanup();
    await mountLobby();
    const row = screen.getByText('Choose A Club Profile Picture').closest('article') as HTMLElement;
    expect(within(row).getByText('Skipped')).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'Undo Skip Choose A Club Profile Picture' })
    ).toBeTruthy();
  });

  it('falls back to today behaviour when the store cannot answer, and says so', async () => {
    h.stateReplies = [
      Promise.resolve({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      }),
    ];
    localStorage.setItem(SKIP_KEY, JSON.stringify(['identity']));
    await mountLobby();

    expect(screen.getByText('New Club Opening Checklist')).toBeTruthy();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PGRST202' }),
      'ClubLaunchSkips.server_read_failed'
    );
    const row = screen.getByText('Choose A Club Profile Picture').closest('article') as HTMLElement;
    expect(within(row).getByText('Skipped')).toBeTruthy();
    expect(h.skipCalls).toEqual([]);
  });
});
