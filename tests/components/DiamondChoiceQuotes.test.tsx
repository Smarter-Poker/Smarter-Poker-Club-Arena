import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  start: vi.fn(),
  rpc: vi.fn(),
  navigate: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('../../src/utils/diamondChoiceMath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/diamondChoiceMath')>()),
  verifyChoiceRound: backend.verify,
}));
vi.mock('../../src/services/DiamondChoiceService', () => ({
  DiamondChoiceService: { state: backend.state },
  parseChoiceRound: (value: unknown) => value,
}));
vi.mock('../../src/services/DiamondBonusService', () => ({
  DiamondBonusService: { start: backend.start },
  BonusRefusal: class extends Error {},
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: backend.rpc } }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => backend.navigate,
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/components/games/ChoiceScene', () => ({ default: () => null }));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock('../../src/components/console/DeckConsole', () => ({
  DeckConsole: ({
    children,
    primary,
    bays,
  }: {
    children?: ReactNode;
    primary: {
      label: string;
      disabled?: boolean;
      onClick?: () => void;
    };
    bays: Array<{ label: string; disabled?: boolean; onPress?: () => void }>;
  }) => (
    <section>
      {children}
      {bays
        .filter((bay) => bay.onPress)
        .map((bay) => (
          <button key={bay.label} disabled={bay.disabled} onClick={bay.onPress}>
            {bay.label}
          </button>
        ))}
      <button disabled={primary.disabled} onClick={primary.onClick}>
        {primary.label}
      </button>
    </section>
  ),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const state = {
  ok: true,
  available: true,
  frozen: false,
  is_member: true,
  diamonds: 10000,
  member_chips: 0,
  diamonds_per_chip: 100,
  bets: [100],
  open_round: null,
  history: [],
  max_steps: 12,
  prizes: Array(12).fill(1),
  rounds_today: 0,
  daily_limit: 500,
  diamonds_today: 0,
  seconds_until_next: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  backend.state.mockReset().mockResolvedValue(state);
  backend.start.mockReset().mockReturnValue(new Promise(() => {}));
  backend.verify.mockReset();
  backend.rpc.mockResolvedValue({
    error: null,
    data: {
      ok: true,
      commit_id: '00000000-0000-0000-0000-000000000009',
      server_seed_hash: 'a'.repeat(64),
    },
  });
  sessionStorage.clear();
});
afterEach(cleanup);

describe('choice-game entry quotes belong to the selected settings', () => {
  it.each([
    { game: 'mines' as const, picked: [], current: '0.00', next: '2.17' },
    { game: 'mines' as const, picked: [2, 4], current: '5.33', next: '15.20' },
    { game: 'crossing' as const, picked: [], current: '0.00', next: '2.17' },
    { game: 'crossing' as const, picked: [0, 1], current: '5.33', next: '15.20' },
  ])(
    'shows current and next potential prizes for $game after $picked',
    async ({ game, picked, current, next }) => {
      backend.state.mockResolvedValue({
        ...state,
        // The active round owns these quotes. A refreshed lobby quote must not
        // replace either amount while the player decides whether to continue.
        prizes: [999, 999, 999],
        open_round: {
          ...fixtures.receipts.mines,
          game,
          mode: game === 'mines' ? '5' : 'steady',
          status: 'open',
          bet_diamonds: 100,
          max_steps: 3,
          picked,
          prizes: [2.17, 5.33, 15.2],
          proof: null,
        },
      });
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(screen.getByText('Current Prize').nextElementSibling).toHaveTextContent(current);
      expect(screen.getByText('Next Prize').nextElementSibling).toHaveTextContent(next);
      expect(screen.queryByText('999.00')).not.toBeInTheDocument();
    }
  );

  it('does not show a previous proof verdict while starting another round', async () => {
    const proof = deferred<boolean>();
    backend.verify.mockReturnValue(proof.promise);
    backend.state.mockResolvedValue({ ...state, history: [fixtures.receipts.mines] });
    render(<DiamondChoicePage game="mines" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Verify Revealed Outcome' }));
    expect(backend.verify).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    expect(backend.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      proof.resolve(true);
    });
    expect(
      screen.queryByText('The Revealed Outcome And Chip Prize Match The Sealed Round.')
    ).not.toBeInTheDocument();
  });
  it.each([
    { game: 'mines' as const, label: 'Mines', older: '10', newer: '15' },
    { game: 'crossing' as const, label: 'Difficulty', older: 'bold', newer: 'extreme' },
  ])(
    'keeps a late $game difficulty quote from replacing the newest round limit',
    async ({ game, label, older, newer }) => {
      const previous = deferred<typeof state>(),
        latest = deferred<typeof state>();
      backend.state.mockImplementation((_club, _game, mode) =>
        mode === older ? previous.promise : mode === newer ? latest.promise : Promise.resolve(state)
      );
      render(<DiamondChoicePage game={game} />);
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: `Change ${label}` }));
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: `Change ${label}` }));
      await act(async () => {});
      await act(async () => {
        latest.resolve({ ...state, max_steps: 8, prizes: Array(8).fill(2) });
      });
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
      await act(async () => {
        previous.resolve({ ...state, max_steps: 10, prizes: Array(10).fill(1.5) });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
      expect(backend.start).toHaveBeenCalledTimes(1);
      expect(backend.start.mock.calls[0][0]).toMatchObject({ game, mode: newer, maxSteps: 8 });
    }
  );
  it('does not start a new amount using an earlier entry quote', async () => {
    const next = deferred<typeof state>();
    backend.state.mockImplementation((_club, _game, _mode, amount) =>
      amount === 200 ? next.promise : Promise.resolve(state)
    );
    render(<DiamondChoicePage game="mines" />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Entry Diamonds'), { target: { value: '200' } });
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    expect(backend.start).not.toHaveBeenCalled();
    await act(async () => {
      next.resolve(state);
    });
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
  });
});
