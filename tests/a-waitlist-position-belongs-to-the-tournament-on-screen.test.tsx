/**
 * The XMTT lobby fetched waitlist positions for a list it was no longer showing.
 *
 * The effect that loads "Position #N" - the only thing that puts a LEAVE
 * WAITLIST button on screen - was keyed on `tournaments.length`:
 *
 *     }, [user?.id, tournaments.length]);
 *
 * A lobby is a live list. It is polled every 30 seconds and refreshed on
 * TOURNAMENT_REGISTERED / TOURNAMENT_CANCELLED, and its membership turns over
 * constantly: one event closing registration as another opens leaves the count
 * at exactly what it was and every id different. A count is not an identity,
 * so the effect did not re-run, the incoming tournament's position was never
 * fetched, and a player queued for it had no way out of a queue they cannot
 * otherwise leave.
 *
 * The write compounded it. `setWaitlistPositions(prev => ({ ...prev, [t.id]:
 * result.position }))` only ever ADDS keys, and it was guarded by `if (result)`
 * so a "you are not on this waitlist any more" answer wrote nothing at all.
 * The map therefore only grew: a position, once read, was rendered for as long
 * as its tournament stayed listed, whether or not the player was still in the
 * queue - and survived the tournament leaving the lobby entirely.
 *
 * These tests drive the page's own 30-second poll and swap what the database
 * returns underneath it, which is the turnover described above. Each one holds
 * the tournament COUNT constant where the old dependency would have noticed a
 * change, so nothing here passes by accident on the unfixed effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import XMTTPage from '../src/pages/XMTTPage';

const POLL_MS = 30_000;

const lobby = vi.hoisted(() => ({
  /** What the tournaments query answers with right now. */
  rows: [] as Array<Record<string, unknown>>,
  /** userId -> tournamentId -> position, or null for "not on this waitlist". */
  positions: {} as Record<string, number | null>,
  user: { id: 'player-1' },
  getPosition: vi.fn(),
  getPositions: vi.fn(),
  readLobby: vi.fn(),
}));

const tournament = (id: string, name: string) => ({
  format_contract: 'mtt-v1',
  id,
  name,
  status: 'registering',
  type: 'MTT',
  buy_in: 100,
  buy_in_fee: 10,
  max_players: null,
  registered_count: 12,
  start_time: '2026-10-01T18:00:00.000Z',
  created_at: '2026-09-01T18:00:00.000Z',
  prize_pool: 1200,
});

vi.mock('../src/lib/supabase', () => {
  const build = (table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['select', 'eq', 'in', 'or', 'order', 'limit', 'not', 'filter']) {
      builder[method] = vi.fn(chain);
    }
    builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    builder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    builder.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: table === 'tournaments' ? lobby.rows : [], error: null }).then(
        resolve
      );
    return builder;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => build(table)),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

vi.mock('../src/services/xmttLobbyReads', () => ({
  XMTT_PAGE_SIZE: 50,
  readXmttLobby: (...args: unknown[]) => lobby.readLobby(...args),
  readXmttWaitlistPositions: (...args: unknown[]) => lobby.getPositions(...args),
}));

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: lobby.user, loading: false }),
}));

vi.mock('../src/utils/resolvePageClubId', () => ({
  resolvePageClubId: vi.fn(async (options) => options.routeClubId || 'club-uuid'),
  hasUnresolvableClubParam: vi.fn(() => false),
  pickPreferredClubId: vi.fn(() => 'club-uuid'),
}));

vi.mock('../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn(async (id: string) => id),
  resolveClubUUIDSync: vi.fn((id: string) => id),
  isUUID: vi.fn(() => true),
}));

vi.mock('../src/utils/unionScope', () => ({
  clubGamesOrFilter: vi.fn(async () => 'club_id.eq.club-uuid'),
  resolveClubUnionId: vi.fn(async () => null),
}));

vi.mock('../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register: vi.fn(), isRegistering: false }),
}));

vi.mock('../src/components/common/Toast', () => {
  const noop = vi.fn();
  return {
    useToast: () => ({
      getToasts: () => [],
      showToast: noop,
      success: noop,
      error: noop,
      warning: noop,
      info: noop,
      clock: noop,
      removeToast: noop,
    }),
    ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

/**
 * Only the waitlist read is replaced; the rest of TournamentService is real, so
 * nothing else about the page is being faked out from under the test.
 */
vi.mock('../src/services/TournamentService', async () => {
  const actual = await vi.importActual<typeof import('../src/services/TournamentService')>(
    '../src/services/TournamentService'
  );
  return {
    ...actual,
    tournamentService: {
      ...(actual.tournamentService as unknown as Record<string, unknown>),
      getTournamentWaitlistPosition: lobby.getPosition,
    },
  };
});

/** Lets the page's init, its poll and the awaits inside both settle. */
const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** One turn of the page's own 30-second lobby poll. */
const poll = () => settle(POLL_MS);

const positionsAsked = () => lobby.getPositions.mock.calls.flatMap((c) => c[0] as string[]);

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  lobby.user = { id: 'player-1' };
  lobby.rows = [];
  lobby.positions = {};
  lobby.getPosition.mockReset();
  lobby.getPositions.mockReset();
  lobby.readLobby.mockReset();
  lobby.readLobby.mockImplementation(async (_club, filter, limit) => {
    const rows =
      filter === 'all'
        ? lobby.rows
        : lobby.rows.filter((row) => String(row.status).toLowerCase() === filter);
    return {
      rows: rows.slice(0, limit),
      total: rows.length,
      counts: Object.fromEntries(
        ['registering', 'running', 'completed'].map((status) => [
          status,
          lobby.rows.filter((row) => String(row.status).toLowerCase() === status).length,
        ])
      ),
    };
  });
  lobby.getPositions.mockImplementation(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, lobby.positions[id] ?? null]))
  );
  lobby.getPosition.mockImplementation(async (tournamentId: string) => {
    const position = lobby.positions[tournamentId];
    return position == null ? null : { position, total: 40 };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function NavigateClub() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/xmtt?club=club-b')}>Other Club</button>;
}
const renderLobby = () =>
  render(
    <MemoryRouter initialEntries={['/xmtt']}>
      <NavigateClub />
      <XMTTPage />
    </MemoryRouter>
  );

describe('a waitlist position belongs to the tournament on screen', () => {
  it('reads the position of a tournament that replaced another one', async () => {
    lobby.rows = [tournament('t-sunday', 'Sunday Major')];
    lobby.positions = { 't-sunday': 3, 't-monday': 7 };

    renderLobby();
    await settle();

    expect(screen.getByText('Sunday Major')).toBeInTheDocument();
    expect(screen.getByText('Position #3')).toBeInTheDocument();

    // Sunday closes, Monday opens. ONE tournament before, ONE after - the
    // count the old effect watched never moves.
    lobby.rows = [tournament('t-monday', 'Monday Major')];
    await poll();

    expect(screen.getByText('Monday Major')).toBeInTheDocument();
    expect(positionsAsked()).toContain('t-monday');
    expect(screen.getByText('Position #7')).toBeInTheDocument();
  });

  it('forgets the position of a tournament that left the lobby', async () => {
    lobby.rows = [tournament('t-sunday', 'Sunday Major'), tournament('t-turbo', 'Turbo Nightly')];
    lobby.positions = { 't-sunday': 3, 't-turbo': 5, 't-monday': 7 };

    renderLobby();
    await settle();
    expect(screen.getByText('Position #3')).toBeInTheDocument();
    expect(screen.getByText('Position #5')).toBeInTheDocument();

    // Sunday leaves, Monday arrives. Two before, two after.
    lobby.rows = [tournament('t-turbo', 'Turbo Nightly'), tournament('t-monday', 'Monday Major')];
    await poll();

    expect(screen.queryByText('Sunday Major')).not.toBeInTheDocument();
    expect(screen.queryByText('Position #3')).not.toBeInTheDocument();
    expect(screen.getByText('Position #5')).toBeInTheDocument();
    expect(screen.getByText('Position #7')).toBeInTheDocument();
  });

  it('drops a position the server has stopped reporting', async () => {
    lobby.rows = [tournament('t-sunday', 'Sunday Major')];
    lobby.positions = { 't-sunday': 3 };

    renderLobby();
    await settle();
    expect(screen.getByText('Position #3')).toBeInTheDocument();

    // The player is seated from the queue elsewhere - another device, the
    // engine promoting them - so the waitlist read now answers "nobody". The
    // tournament itself is still listed; only the answer changed.
    lobby.positions = { 't-sunday': null, 't-monday': 7 };
    lobby.rows = [tournament('t-sunday', 'Sunday Major'), tournament('t-monday', 'Monday Major')];
    await poll();

    expect(screen.getByText('Sunday Major')).toBeInTheDocument();
    expect(screen.getByText('Position #7')).toBeInTheDocument();
    // The merge kept this number on screen for a queue the player had left.
    expect(screen.queryByText('Position #3')).not.toBeInTheDocument();
  });

  it('does not re-read positions when a poll returns the same tournaments', async () => {
    lobby.rows = [tournament('t-sunday', 'Sunday Major')];
    lobby.positions = { 't-sunday': 3 };

    renderLobby();
    await settle();
    const afterFirstLoad = lobby.getPositions.mock.calls.length;
    expect(afterFirstLoad).toBe(1);

    // A fresh array of the same events. Keying on identity rather than on the
    // ids themselves would refetch every 30 seconds, forever.
    lobby.rows = [tournament('t-sunday', 'Sunday Major')];
    await poll();

    expect(lobby.getPositions.mock.calls.length).toBe(afterFirstLoad);
    expect(screen.getByText('Position #3')).toBeInTheDocument();
  });
  it('mounts a bounded first page and keeps all one thousand events accessible', async () => {
    lobby.rows = Array.from({ length: 1000 }, (_, i) => tournament(`t-${i}`, `Event ${i}`));
    renderLobby();
    await settle();
    expect(screen.getAllByText(/^Event /)).toHaveLength(50);
    expect(screen.getByText('1,000')).toBeInTheDocument();
    expect(positionsAsked()).toHaveLength(50);
    expect(lobby.getPositions).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await settle();
    expect(screen.getAllByText(/^Event /)).toHaveLength(100);
    expect(screen.getByText('Event 99')).toBeInTheDocument();
    expect(screen.queryByText('Event 100')).not.toBeInTheDocument();
  });

  it('resets the displayed page on a filter change while keeping the server count', async () => {
    lobby.rows = Array.from({ length: 160 }, (_, i) => ({
      ...tournament(`t-${i}`, `Event ${i}`),
      status: i < 80 ? 'registering' : 'completed',
    }));
    renderLobby();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await settle();
    expect(screen.getAllByText(/^Event /)).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: 'Completed (80)' }));
    await settle();
    expect(screen.getAllByText(/^Event /)).toHaveLength(50);
    expect(screen.getByText('Event 80')).toBeInTheDocument();
    expect(screen.queryByText('Event 0')).not.toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('retains a known legacy exit and reports a failed batch as unknown', async () => {
    lobby.rows = [tournament('t-old', 'Old Event')];
    lobby.positions = { 't-old': 4 };
    renderLobby();
    await settle();
    expect(screen.getByText('Position #4')).toBeInTheDocument();
    lobby.getPositions.mockRejectedValueOnce(new Error('offline'));
    lobby.rows = [tournament('t-old', 'Old Event'), tournament('t-new', 'New Event')];
    await poll();
    expect(screen.getByText('Position #4')).toBeInTheDocument();
    expect(screen.getByText(/Waitlist Status Unavailable/)).toBeInTheDocument();
  });

  it('ignores a delayed position answer for a replaced page', async () => {
    let finish!: (value: Record<string, number>) => void;
    lobby.rows = [tournament('t-old', 'Old Event')];
    lobby.getPositions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    renderLobby();
    await settle();
    lobby.rows = [tournament('t-new', 'New Event')];
    lobby.positions = { 't-new': 7 };
    await poll();
    await act(async () => {
      finish({ 't-old': 3 });
    });
    expect(screen.getByText('Position #7')).toBeInTheDocument();
    expect(screen.queryByText('Position #3')).not.toBeInTheDocument();
  });
  it('discards a prior club response after routed navigation', async () => {
    let finish!: (value: unknown) => void;
    lobby.readLobby.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = renderLobby();
    await settle();
    lobby.rows = [tournament('t-new', 'New Club Event')];
    fireEvent.click(screen.getByRole('button', { name: 'Other Club' }));
    await settle();
    expect(screen.getByText('New Club Event')).toBeInTheDocument();
    await act(async () =>
      finish({
        rows: [tournament('t-old', 'Old Club Event')],
        total: 1,
        counts: { registering: 1, running: 0, completed: 0 },
      })
    );
    expect(screen.queryByText('Old Club Event')).not.toBeInTheDocument();
    expect(screen.getByText('New Club Event')).toBeInTheDocument();
    view.unmount();
  });

  it('never carries a prior account position into the next account', async () => {
    let finish!: (value: Record<string, number>) => void;
    lobby.rows = [tournament('t-one', 'Shared Event')];
    lobby.getPositions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = renderLobby();
    await settle();
    lobby.user = { id: 'player-2' };
    lobby.positions = {};
    view.rerender(
      <MemoryRouter>
        <NavigateClub />
        <XMTTPage />
      </MemoryRouter>
    );
    await settle();
    await act(async () => finish({ 't-one': 9 }));
    expect(screen.queryByText('Position #9')).not.toBeInTheDocument();
    expect(lobby.getPositions.mock.calls.at(-1)?.[1]).toBe('player-2');
  });

  it('does not accept a waitlist answer after its abort deadline', async () => {
    let finish!: (value: Record<string, number>) => void;
    lobby.rows = [tournament('t-one', 'Shared Event')];
    lobby.getPositions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    renderLobby();
    await settle();
    const signal = lobby.getPositions.mock.calls[0][2] as AbortSignal;
    await settle(15_000);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ 't-one': 9 }));
    expect(screen.queryByText('Position #9')).not.toBeInTheDocument();
    expect(screen.getByText(/Waitlist Status Unavailable/)).toBeInTheDocument();
    lobby.positions = { 't-one': 4 };
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await settle();
    expect(screen.getByText('Position #4')).toBeInTheDocument();
  });

  it('discards a delayed prior filter and keeps the new filter loading until its read', async () => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    lobby.readLobby.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    const view = renderLobby();
    await settle();
    // Establish a first page, then leave its replacement observation unresolved.
    await act(async () =>
      finishOld({
        rows: [tournament('t-one', 'First Event')],
        total: 1,
        counts: { registering: 1, running: 0, completed: 0 },
      })
    );
    lobby.readLobby.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    await poll();
    lobby.readLobby.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Completed (0)' }));
    await settle();
    expect(screen.queryByText('First Event')).not.toBeInTheDocument();
    expect(screen.queryByText('No Tournaments')).not.toBeInTheDocument();
    await act(async () =>
      finishOld({
        rows: [tournament('t-old', 'Late Event')],
        total: 1,
        counts: { registering: 1, running: 0, completed: 0 },
      })
    );
    expect(screen.queryByText('Late Event')).not.toBeInTheDocument();
    await act(async () =>
      finishNew({ rows: [], total: 0, counts: { registering: 1, running: 0, completed: 0 } })
    );
    expect(screen.getByText('No Tournaments')).toBeInTheDocument();
    view.unmount();
  });

  it('retains the loaded list when a later observation fails', async () => {
    lobby.rows = [tournament('t-old', 'Retained Event')];
    renderLobby();
    await settle();
    lobby.readLobby.mockRejectedValueOnce(new Error('denied'));
    await poll();
    expect(screen.getByText('Retained Event')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Tournament List Unavailable');
  });
});
