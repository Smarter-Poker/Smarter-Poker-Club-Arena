/**
 * A MOVE THE SERVER ANSWERED IS AN ANSWER (review 2026-09-22), on Donkey Cross
 * and Diamond Mines.
 *
 * fn_choice_act refuses a move with {ok:false,error} and changes nothing on the
 * round: during the maintenance break it answers "The Platform Is In Its
 * Maintenance Break". The page read every such answer as a lost one: it said
 * "Confirming Your Move", read the round back, found it unchanged and dropped
 * the message, so the break was never shown and the player was left pressing a
 * live tile that the server kept refusing. An error that carries a SQLSTATE is
 * the database's answer too: that execution rolled back.
 *
 * The page now shows the server's reason, reads the game again (so the break
 * shows and the page's own break reads run) and, when the break is over, takes
 * the reason down by itself. Only an answer that never arrived is confirmed by
 * reading the round back. The move door here is the real DiamondChoiceService
 * against a mocked PostgREST rpc, so the rule the page acts on is the one that
 * ships.
 *
 * The console's second plate used to read "Refresh" whenever no win could be
 * booked, and pressing it re-read the game by hand. No game asks a player to
 * refresh anything: the plate is Book The Win, live only once a win can be
 * booked.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn(() => () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import type ChoiceScene from '../../src/components/games/ChoiceScene';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  move: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../src/services/DiamondChoiceService', async (original) => {
  const real = await original<typeof import('../../src/services/DiamondChoiceService')>();
  // Only the game read is scripted; every move goes through the real door.
  return { ...real, DiamondChoiceService: { ...real.DiamondChoiceService, state: backend.state } };
});
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'fn_choice_act') return backend.move(args);
      if (name === 'fn_diamond_game_commit')
        return {
          error: null,
          data: {
            ok: true,
            commit_id: '00000000-0000-0000-0000-000000000009',
            server_seed_hash: 'a'.repeat(64),
          },
        };
      throw new Error(`Unexpected rpc ${name}`);
    },
  },
}));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => backend.navigate,
  useLocation: () => ({ search: '' }),
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
// Mines plays on its real board; the road is a stub that reports its phase.
vi.mock('../../src/components/games/ChoiceScene', async () => {
  const { default: MinesGrid } = await import('../../src/components/games/MinesGrid');
  return {
    default: (props: ComponentProps<typeof ChoiceScene>) =>
      props.game === 'mines' ? (
        <MinesGrid {...props} />
      ) : (
        <section aria-label={`Scene ${props.phase} ${props.picked.length}`}>
          <button onClick={props.onSettled}>Finish Scene</button>
        </section>
      ),
  };
});
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));

type Game = 'crossing' | 'mines';
const BREAK = 'The Platform Is In Its Maintenance Break';
const opened = (game: Game) => ({
  ...fixtures.receipts[game],
  status: 'open',
  picked: [] as number[],
  proof: null,
  payout_chips: 0,
});
/** The first safe move of each game: tile 9 on the fixture board, the first street. */
const FIRST: Record<Game, number> = { mines: 8, crossing: 0 };
const moved = (game: Game) => ({ ...opened(game), picked: [FIRST[game]] });
const state = (game: Game, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  available: true,
  frozen: false,
  reason: null,
  is_member: true,
  diamonds: 10000,
  member_chips: 0,
  diamonds_per_chip: 100,
  bets: [100],
  open_round: opened(game) as unknown,
  history: [] as unknown[],
  max_steps: fixtures.receipts[game].max_steps,
  prizes: fixtures.receipts[game].prizes,
  rounds_today: 0,
  daily_limit: 500,
  diamonds_today: 0,
  seconds_until_next: 0,
  ...overrides,
});
const PLAY_ON: Record<Game, string> = {
  mines: 'Reveal A Tile Or Book The Win.',
  crossing: 'Cross The Next Street Or Book The Win.',
};
/** The control that makes the next move in each game. */
const nextMove = (game: Game) =>
  game === 'mines'
    ? screen.getByRole('button', { name: 'Tile 9' })
    : screen.getByRole('button', { name: 'Cross Street' });
const moveSent = (game: Game) => expect(nextMove(game)).toBeInTheDocument();
const text = () => document.body.textContent ?? '';
const settle = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
};
/** Presses the move and records every screen the page shows on its way to the answer. */
const press = async (game: Game) => {
  const seen: string[] = [];
  fireEvent.click(nextMove(game));
  for (let i = 0; i < 8; i++) {
    seen.push(text());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  await settle();
  return seen;
};
const actions = () => backend.move.mock.calls.map(([args]) => args.p_action);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  backend.awardState
    .mockReset()
    .mockResolvedValue({ enabled: true, award: null, gameState: null, quote: null });
  backend.state.mockReset();
  backend.move.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(['mines', 'crossing'] as const)('%s: a move the server refused', (game) => {
  it('shows the break the server named and plays on by itself once the break is over', async () => {
    backend.state.mockResolvedValue(state(game));
    render(<DiamondChoicePage game={game} />);
    await settle();
    expect(screen.getByText(PLAY_ON[game])).toBeInTheDocument();
    // The break begins; the server refuses the move and changes nothing.
    backend.state.mockResolvedValue(state(game, { frozen: true }));
    backend.move.mockResolvedValue({ error: null, data: { ok: false, error: BREAK } });
    const reads = backend.state.mock.calls.length;
    const seen = await press(game);
    expect(seen.some((screenText) => screenText.includes('Confirming Your Move'))).toBe(false);
    expect(screen.getByText(BREAK)).toBeInTheDocument();
    expect(backend.move).toHaveBeenCalledTimes(1);
    // The game was read again, so the page knows the break is on.
    expect(backend.state.mock.calls.length).toBeGreaterThan(reads);
    moveSent(game);
    if (game === 'mines') expect(screen.queryByRole('button', { name: 'Tile 9, Gem' })).toBeNull();
    // The break goes on: the reason stays, and nothing is sent again by itself.
    await advance(20_000);
    expect(screen.getByText(BREAK)).toBeInTheDocument();
    expect(backend.move).toHaveBeenCalledTimes(1);
    // The break ends. The page's own break read sees it, and the reason goes.
    backend.state.mockResolvedValue(state(game));
    await advance(15_000);
    expect(screen.queryByText(BREAK)).toBeNull();
    expect(screen.getByText(PLAY_ON[game])).toBeInTheDocument();
    // The player's next move is taken.
    backend.move.mockResolvedValue({ error: null, data: moved(game) });
    backend.state.mockResolvedValue(state(game, { open_round: moved(game) }));
    await press(game);
    expect(backend.move).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(BREAK)).toBeNull();
    if (game === 'mines')
      expect(screen.getByRole('button', { name: 'Tile 9, Gem' })).toBeInTheDocument();
    else expect(screen.getByRole('region', { name: 'Scene open 1' })).toBeInTheDocument();
  });

  it('shows a refusal the database raised, and never replays it', async () => {
    backend.state.mockResolvedValue(state(game));
    render(<DiamondChoicePage game={game} />);
    await settle();
    backend.move.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Prize Exceeds Its Reservation' },
    });
    const seen = await press(game);
    expect(seen.some((screenText) => screenText.includes('Confirming Your Move'))).toBe(false);
    expect(screen.getByText('The Game Could Not Take That Move')).toBeInTheDocument();
    await advance(60_000);
    expect(backend.move).toHaveBeenCalledTimes(1);
    expect(screen.getByText('The Game Could Not Take That Move')).toBeInTheDocument();
    moveSent(game);
  });

  it('confirms a move whose answer never arrived by reading the round back, with no press', async () => {
    backend.state.mockResolvedValue(state(game));
    render(<DiamondChoicePage game={game} />);
    await settle();
    // The move committed; its answer was lost on the way back.
    backend.move.mockRejectedValue(new TypeError('Failed To Fetch'));
    backend.state.mockResolvedValue(state(game, { open_round: moved(game) }));
    const seen = await press(game);
    expect(seen.some((screenText) => screenText.includes('Confirming Your Move'))).toBe(true);
    expect(screen.queryByText('Confirming Your Move')).toBeNull();
    if (game === 'mines')
      expect(screen.getByRole('button', { name: 'Tile 9, Gem' })).toBeInTheDocument();
    else expect(screen.getByRole('region', { name: 'Scene open 1' })).toBeInTheDocument();
    await advance(60_000);
    expect(backend.move).toHaveBeenCalledTimes(1);
  });
});

describe('the second plate books the win and nothing else', () => {
  it('reads Book The Win before a round and before the first safe move, and never offers Refresh', async () => {
    backend.awardState.mockResolvedValue({
      enabled: false,
      award: null,
      gameState: null,
      quote: null,
    });
    backend.state.mockResolvedValue(state('mines', { open_round: null }));
    render(<DiamondChoicePage game="mines" />);
    await settle();
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    const reads = backend.state.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Book The Win' }));
    await settle();
    expect(backend.state.mock.calls.length).toBe(reads);
    expect(backend.move).not.toHaveBeenCalled();
  });

  it('comes alive after the first safe move and books the win', async () => {
    backend.state.mockResolvedValue(state('mines'));
    render(<DiamondChoicePage game="mines" />);
    await settle();
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    backend.move.mockResolvedValueOnce({ error: null, data: moved('mines') });
    backend.state.mockResolvedValue(state('mines', { open_round: moved('mines') }));
    await press('mines');
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    const booked = {
      ...fixtures.receipts.mines,
      picked: [FIRST.mines],
      payout_chips: fixtures.receipts.mines.prizes[0],
    };
    backend.move.mockResolvedValueOnce({ error: null, data: booked });
    backend.state.mockResolvedValue(state('mines', { open_round: null, history: [booked] }));
    fireEvent.click(screen.getByRole('button', { name: 'Book The Win' }));
    await settle();
    expect(actions()).toEqual(['pick', 'cashout']);
    expect(screen.getByText(/Chips Booked/)).toBeInTheDocument();
  });
});
