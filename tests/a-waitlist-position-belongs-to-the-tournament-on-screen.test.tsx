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
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import XMTTPage from '../src/pages/XMTTPage';

const POLL_MS = 30_000;

const lobby = vi.hoisted(() => ({
  /** What the tournaments query answers with right now. */
  rows: [] as Array<Record<string, unknown>>,
  /** userId -> tournamentId -> position, or null for "not on this waitlist". */
  positions: {} as Record<string, number | null>,
  getPosition: vi.fn(),
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

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-1' }, loading: false }),
}));

vi.mock('../src/utils/resolvePageClubId', () => ({
  resolvePageClubId: vi.fn(async () => 'club-uuid'),
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

const positionsAsked = () => lobby.getPosition.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  vi.useFakeTimers();
  lobby.rows = [];
  lobby.positions = {};
  lobby.getPosition.mockReset();
  lobby.getPosition.mockImplementation(async (tournamentId: string) => {
    const position = lobby.positions[tournamentId];
    return position == null ? null : { position, total: 40 };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const renderLobby = () =>
  render(
    <MemoryRouter initialEntries={['/xmtt']}>
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
    const afterFirstLoad = lobby.getPosition.mock.calls.length;
    expect(afterFirstLoad).toBe(1);

    // A fresh array of the same events. Keying on identity rather than on the
    // ids themselves would refetch every 30 seconds, forever.
    lobby.rows = [tournament('t-sunday', 'Sunday Major')];
    await poll();

    expect(lobby.getPosition.mock.calls.length).toBe(afterFirstLoad);
    expect(screen.getByText('Position #3')).toBeInTheDocument();
  });
});
