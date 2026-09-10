import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  playerRefresh: null as null | (() => void),
  leaderboard: vi.fn(),
  awards: vi.fn(),
  report: vi.fn(),
}));
type Reply = { data: unknown; error: unknown };
function chain(table: string) {
  const args: Record<string, unknown> = {};
  const query: Record<string, any> = {
    then: (ok: (value: Reply) => unknown, fail: (error: unknown) => unknown) =>
      Promise.resolve(mocks.query(table, args)).then(ok, fail),
  };
  for (const method of ['select', 'eq', 'in', 'gte', 'order', 'limit', 'maybeSingle']) {
    query[method] = (...values: unknown[]) => {
      if (method === 'eq' || method === 'gte') args[String(values[0])] = values[1];
      else args[method] = values[0];
      return query;
    };
  }
  return query;
}
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: chain,
    rpc: vi.fn(async () => ({ data: {}, error: null })),
  },
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: () => {
      const channel = {
        on: (_event: string, options: { table: string }, callback: () => void) => {
          if (options.table === 'tournament_players') mocks.playerRefresh = callback;
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    },
    removeRegisteredChannel: vi.fn(),
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'hero' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({ default: () => null }));
vi.mock('../../src/components/tournament/TournamentPaymentStatus', () => ({
  default: ({ tournamentId }: { tournamentId: string }) => (
    <div data-testid="payment-event">{tournamentId}</div>
  ),
}));
vi.mock('../../src/services/MysteryBountyService', async (original) => ({
  ...(await original<typeof import('../../src/services/MysteryBountyService')>()),
  MysteryBountyService: { getLeaderboard: mocks.leaderboard, getAllAwards: mocks.awards },
}));
import TournamentResultsPage from '../../src/pages/tournament/TournamentResultsPage';

const tournament = (id: string, extra = {}) => ({
  id,
  name: `Event ${id}`,
  variant: 'freezeout',
  tournament_type: 'mtt',
  game_type: 'NLH',
  buy_in_amount: 9,
  buy_in_fee: 1,
  prize_pool: 90,
  current_players: 10,
  max_players: 10,
  status: 'COMPLETED',
  started_at: null,
  ended_at: null,
  is_xmtt: false,
  is_bounty: false,
  is_pko: false,
  is_mystery_bounty: false,
  spin_multiplier: null,
  ...extra,
});
const winner = (name: string, prize = 90) => ({
  user_id: name,
  username: name,
  position: 1,
  prize,
  bounty_winnings: 0,
  bounties_collected: 0,
  status: 'winner',
});
const success = (data: unknown): Reply => ({ data, error: null });
function deferred() {
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(path = '/tournament-results') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TournamentResultsPage />
    </MemoryRouter>
  );
}
async function select(id: string) {
  fireEvent.click(await screen.findByText(`Event ${id}`));
}

beforeEach(() => {
  mocks.query
    .mockReset()
    .mockImplementation((table) =>
      success(table === 'tournaments' ? [tournament('A'), tournament('B')] : [])
    );
  mocks.leaderboard.mockReset().mockResolvedValue([]);
  mocks.awards.mockReset().mockResolvedValue({ rows: [] });
  mocks.report.mockClear();
  mocks.playerRefresh = null;
});
afterEach(cleanup);

describe('Tournament archive read identity', () => {
  it('reports list read failure instead of inventing an empty archive, and retries', async () => {
    mocks.query
      .mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
      .mockImplementation((table) => success(table === 'tournaments' ? [tournament('A')] : []));
    mount();
    await screen.findByText('Could Not Load Tournament Results. Please Retry.');
    expect(screen.queryByText('No Completed Tournaments Found')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Results' }));
    await screen.findByText('Event A');
  });

  it('cannot replace the current standings with a delayed previous event', async () => {
    const old = deferred();
    mocks.query.mockImplementation((table, args) =>
      table === 'tournaments'
        ? success([tournament('A'), tournament('B')])
        : table === 'tournament_players'
          ? args.tournament_id === 'A'
            ? old.promise
            : success([winner('Current Winner')])
          : success([])
    );
    mount();
    await select('A');
    await select('B');
    await screen.findByText('Current Winner');
    await act(async () => old.resolve(success([winner('Old Winner')])));
    expect(screen.queryByText('Old Winner')).toBeNull();
    expect(screen.getByText('Current Winner')).toBeTruthy();
    expect(screen.getByTestId('payment-event').textContent).toBe('B');
  });

  it('keeps the newest same-event realtime refresh when responses arrive out of order', async () => {
    const stale = deferred();
    let reads = 0;
    mocks.query.mockImplementation((table) =>
      table === 'tournaments'
        ? success([tournament('A')])
        : table === 'tournament_players'
          ? ++reads === 2
            ? stale.promise
            : success([winner(reads === 1 ? 'Initial Winner' : 'Latest Winner')])
          : success([])
    );
    mount();
    await select('A');
    await screen.findByText('Initial Winner');
    act(() => {
      mocks.playerRefresh!();
    });
    act(() => {
      mocks.playerRefresh!();
    });
    await screen.findByText('Latest Winner');
    await act(async () => stale.resolve(success([winner('Stale Winner')])));
    expect(screen.queryByText('Stale Winner')).toBeNull();
    expect(screen.getByText('Latest Winner')).toBeTruthy();
  });

  it('reports refused standings without old-event awards and retries without collapsing the event', async () => {
    let refused = true;
    mocks.query.mockImplementation((table, args) =>
      table === 'tournaments'
        ? success([tournament('A'), tournament('B')])
        : table === 'tournament_players'
          ? args.tournament_id === 'A'
            ? success([winner('Previous Winner')])
            : refused
              ? { data: null, error: { message: 'permission denied' } }
              : success([winner('Recovered Winner')])
          : success([])
    );
    mount();
    await select('A');
    await screen.findByText('Previous Winner');
    await select('B');
    await screen.findByText('Could Not Load These Standings. Please Retry.');
    expect(screen.queryByText('Previous Winner')).toBeNull();
    expect(screen.queryByText('No Standings Recorded Yet.')).toBeNull();
    refused = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry Standings' }));
    await screen.findByText('Recovered Winner');
    expect(screen.getByTestId('payment-event').textContent).toBe('B');
  });

  it('keeps hand tabs open, distinguishes read failure from no hands, and retries', async () => {
    let refused = true;
    mocks.query.mockImplementation((table) =>
      table === 'tournaments'
        ? success([tournament('A')])
        : table === 'hand_history' && refused
          ? { data: null, error: { message: 'offline' } }
          : success([])
    );
    mount();
    await select('A');
    fireEvent.click(await screen.findByRole('button', { name: 'Hand History (0)' }));
    await screen.findByText('Could Not Load These Hands. Please Retry.');
    expect(screen.queryByText('No Hands Recorded')).toBeNull();
    refused = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry Hands' }));
    await screen.findByText('No Hands Recorded');
  });

  it('does not insert an old event hand into the newly selected hand history', async () => {
    const old = deferred();
    const hand = (number: number) => ({
      id: String(number),
      hand_number: number,
      small_blind: 1,
      big_blind: 2,
      pot_size: 10,
      game_variant: 'NLH',
      community_cards: [],
      winners: [],
      players: [],
      created_at: '2026-09-10T00:00:00Z',
    });
    mocks.query.mockImplementation((table, args) =>
      table === 'tournaments'
        ? success([tournament('A'), tournament('B')])
        : table === 'hand_history'
          ? args.tournament_id === 'A'
            ? old.promise
            : success([hand(202)])
          : success([])
    );
    mount();
    await select('A');
    await select('B');
    fireEvent.click(await screen.findByRole('button', { name: 'Hand History (1)' }));
    await screen.findByText('Hand #202');
    await act(async () => old.resolve(success([hand(101)])));
    expect(screen.queryByText('Hand #101')).toBeNull();
    expect(screen.getByText('Hand #202')).toBeTruthy();
  });

  it('reports mystery failures and recovers without changing the selected event', async () => {
    mocks.query.mockImplementation((table) =>
      success(table === 'tournaments' ? [tournament('A', { is_mystery_bounty: true })] : [])
    );
    mocks.leaderboard.mockRejectedValueOnce(new Error('awards unavailable')).mockResolvedValue([]);
    mount();
    await select('A');
    await screen.findByText('Could Not Load These Mystery Awards. Please Retry.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Mystery Awards' }));
    await waitFor(() =>
      expect(screen.queryByText('Could Not Load These Mystery Awards. Please Retry.')).toBeNull()
    );
    expect(mocks.leaderboard).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('payment-event').textContent).toBe('A');
  });

  it('loads and renders a direct event link even when the filtered archive is empty', async () => {
    mocks.query.mockImplementation((table, args) =>
      table === 'tournaments'
        ? success(args.id ? tournament('Linked') : [])
        : table === 'tournament_players'
          ? success([winner('Linked Winner')])
          : success([])
    );
    mount('/tournament-results?id=Linked');
    await screen.findByText('Event Linked');
    await screen.findByText('Linked Winner');
    expect(screen.getByTestId('payment-event').textContent).toBe('Linked');
  });
});

describe('Biggest Hits uses recorded individual awards', () => {
  it.each([
    [0, 'Won 0'],
    [40, 'Won 40'],
    [null, 'Prize Not Confirmed'],
  ])(
    'renders a recorded %s prize without substituting the full Spin pool',
    async (prize, label) => {
      mocks.query.mockImplementation((table, args) =>
        table === 'tournaments'
          ? success(
              args.spin_multiplier
                ? [{ id: 'S', buy_in_amount: 1, spin_multiplier: 50, ended_at: null }]
                : []
            )
          : table === 'tournament_players'
            ? success([{ tournament_id: 'S', username: 'Spin Winner', prize }])
            : success([])
      );
      mount('/tournament-results?type=spin');
      await screen.findByText(`${label} On A 1 Spin`);
      expect(screen.queryByText('Won 50 On A 1 Spin')).toBeNull();
    }
  );
});
