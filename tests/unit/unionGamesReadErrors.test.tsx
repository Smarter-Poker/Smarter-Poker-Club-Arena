import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ReadKey = 'unions' | 'union_clubs' | 'tournaments' | 'tables' | 'bbj';
type ReadResult = { data: unknown; error: Error | null };

const mocks = vi.hoisted(() => ({
  results: {} as Record<ReadKey, ReadResult>,
  reportError: vi.fn(),
}));

function queryFor(key: ReadKey): any {
  let historical = false;
  const chain: any = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'in' && key === 'tournaments') {
          return () => {
            historical = true;
            return chain;
          };
        }
        if (property === 'range') {
          return (from: number, to: number) =>
            Promise.resolve({
              ...mocks.results[key],
              data: Array.isArray(mocks.results[key].data)
                ? (mocks.results[key].data as unknown[]).slice(from, to + 1)
                : mocks.results[key].data,
            });
        }
        if (property === 'then') {
          return (resolve: (value: ReadResult) => unknown) =>
            Promise.resolve(
              historical && !mocks.results[key].error
                ? { data: [], error: null }
                : mocks.results[key]
            ).then(resolve);
        }
        if (property === 'maybeSingle' || property === 'single') {
          return () => Promise.resolve(mocks.results[key]);
        }
        return () => chain;
      },
    }
  );
  return chain;
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => queryFor(table as Exclude<ReadKey, 'bbj'>),
    rpc: () => queryFor('bbj'),
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'appointed-admin' } }),
}));
vi.mock('../../src/hooks/useUnionRouteId', () => ({
  useUnionRouteId: () => ({ unionId: 'union-id', unionRef: 'union-slug' }),
}));
vi.mock('../../src/services/UnionService', () => ({
  unionService: { isUnionAdmin: vi.fn(async () => true) },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/hooks/useTournamentRegistration', () => ({
  useTournamentRegistration: () => ({ register: vi.fn(), isRegistering: false }),
}));
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { unregisterPlayer: vi.fn() },
  tournamentUnregisterSuccessText: vi.fn(),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));
vi.mock('../../src/core/MasterBus', () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() } as any;
  channel.on.mockReturnValue(channel);
  return {
    masterBus: {
      subscribeDebounced: vi.fn(() => vi.fn()),
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({
  default: ({ status, actions }: { status: string; actions: React.ReactNode }) => (
    <header>
      <span>{status}</span>
      {actions}
    </header>
  ),
}));
vi.mock('../../src/components/club/GameCreationActions', () => ({
  default: () => <button type="button">Create Game</button>,
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({
  default: () => <div role="status">Loading Union Games</div>,
}));

import UnionGamesPage from '../../src/pages/UnionGamesPage';

const goodResults = (): Record<ReadKey, ReadResult> => ({
  unions: { data: { id: 'union-id', name: 'Test Union' }, error: null },
  union_clubs: { data: [{ club_id: 'club-id' }], error: null },
  tournaments: { data: [], error: null },
  tables: { data: [], error: null },
  bbj: { data: null, error: null },
});

describe.each<ReadKey>(['unions', 'union_clubs', 'tournaments', 'tables', 'bbj'])(
  'Union Games %s read failure',
  (failedRead) => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.results = goodResults();
      mocks.results[failedRead] = { data: null, error: new Error(`${failedRead} unavailable`) };
    });

    it('shows a fail-closed alert instead of a false zero/live board', async () => {
      render(
        <MemoryRouter>
          <UnionGamesPage />
        </MemoryRouter>
      );

      expect(await screen.findByRole('alert', {}, { timeout: 2_000 })).toHaveTextContent(
        'Union Games Could Not Be Loaded'
      );
      expect(screen.queryByText('UNION GAMES // LIVE')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
      await waitFor(() =>
        expect(mocks.reportError).toHaveBeenCalledWith(
          failedRead === 'tournaments'
            ? expect.objectContaining({
                message: expect.stringContaining('tournaments unavailable'),
              })
            : mocks.results[failedRead].error,
          'UnionGamesPage.load'
        )
      );
    });
  }
);

describe('Union Games complete tournament board', () => {
  it('renders tomorrow beyond the former 50-row cap, every page and truthful entry details', async () => {
    vi.clearAllMocks();
    mocks.results = goodResults();
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: `event-${i}`,
      name: `Future Event ${i}`,
      status: 'REGISTERING',
      start_time: '2026-10-30T17:00:00Z',
      buy_in_amount: 9,
      buy_in_fee: 1,
      current_players: 0,
      max_players: null,
    }));
    mocks.results.tournaments.data = [
      ...rows,
      {
        id: 'tomorrow',
        name: 'Tomorrow Bounty Freezeout',
        status: 'REGISTERING',
        start_time: '2026-10-29T01:00:00Z',
        buy_in_amount: 36,
        buy_in_fee: 4,
        guaranteed_prize: 5000,
        starting_chips: 20000,
        is_bounty: true,
        bounty_amount: 10,
        is_rebuy: false,
        is_reentry: false,
        add_on_available: false,
        current_players: 7,
        max_players: null,
      },
    ];
    render(
      <MemoryRouter>
        <UnionGamesPage />
      </MemoryRouter>
    );
    const event = await screen.findByText('Tomorrow Bounty Freezeout', {}, { timeout: 5000 });
    const card = event.parentElement!.parentElement!.parentElement!;
    expect(card).toHaveTextContent('40');
    expect(card).toHaveTextContent('5.0K GTD');
    expect(card).toHaveTextContent('20.0K Starting Stack');
    expect(card).toHaveTextContent('10 Bounty');
    expect(card).toHaveTextContent('Freezeout');
    expect(screen.getByText('Future Event 1000')).toBeInTheDocument();
  });
});
