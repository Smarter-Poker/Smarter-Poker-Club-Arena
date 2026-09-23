/**
 * A FINISHED ROUND READS AS ITSELF UNTIL ITS RECEIPT TAKES THE PLAYER BACK
 * (review 2026-09-22), on Diamond Mines and Donkey Cross.
 *
 *  - While the last pick was revealed, the setup panel under the board told
 *    the player to "Win This Game On Diamond Spins To Play.": it described the
 *    next round, which this page never plays (the receipt returns the player to
 *    the wheel), and with a second award pending it opened that award's Double
 *    Down offer over the reveal. The setup stays off screen from the moment a
 *    round opens until its receipt has taken the player back.
 *  - The Guaranteed bay read "Pending" beside a booked loss: it described the
 *    next entry, not the round on the board. It shows that round's own floor.
 *  - A round finished on the page it was won for, then reopened from its wheel
 *    link, showed an idle board, no booked chips and no receipt: the server
 *    returned the finished round with the award and the page never read it.
 *    It is shown, and its receipt takes the player back to the wheel. Only the
 *    award the link names is replayed; a visit without a link never replays an
 *    old round on entry.
 *  - An open round read back from the server showed a freshly drawn seed under
 *    "Your Seed", not the seed that round was sealed with.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn(() => () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import type ChoiceScene from '../../src/components/games/ChoiceScene';
import { CHOICE_MODE } from '../../src/utils/diamondChoiceMath';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  act: vi.fn(),
  start: vi.fn(),
  rpc: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
  search: { value: '' },
}));
vi.mock('../../src/services/DiamondChoiceService', async (original) => ({
  ...(await original<typeof import('../../src/services/DiamondChoiceService')>()),
  DiamondChoiceService: { state: backend.state, act: backend.act },
  parseChoiceRound: (value: unknown) => value,
}));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: { start: backend.start },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: backend.rpc } }));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => backend.navigate,
  useLocation: () => ({ search: backend.search.value }),
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/components/games/ChoiceScene', async () => {
  const { default: MinesGrid } = await import('../../src/components/games/MinesGrid');
  return {
    default: (props: ComponentProps<typeof ChoiceScene>) =>
      props.game === 'mines' ? (
        <MinesGrid {...props} />
      ) : (
        <section aria-label={`Scene ${props.phase}`}>
          <button onClick={props.onSettled}>Finish Scene</button>
        </section>
      ),
  };
});
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({
    title,
    detail,
    onOpen,
  }: {
    title: string;
    detail: string;
    onOpen: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      {detail}
      <button onClick={onOpen}>Finish Prize</button>
    </div>
  ),
}));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));

type Game = 'crossing' | 'mines';
const CLUB = '00000000-0000-0000-0000-000000000003';
const AWARD_ID = '00000000-0000-0000-0000-000000000077';
const NEXT_AWARD_ID = '00000000-0000-0000-0000-000000000078';
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
  open_round: null as unknown,
  history: [] as unknown[],
  max_steps: 11,
  prizes: fixtures.receipts[game].prizes.slice(0, 11),
  rounds_today: 0,
  daily_limit: 500,
  diamonds_today: 0,
  seconds_until_next: 0,
  ...overrides,
});
const award = (game: Game, id = AWARD_ID, status = 'pending') => ({
  id,
  game,
  club_id: CLUB,
  base_diamonds: 100,
  entry_diamonds: 100,
  boost_multiplier: 1,
  status,
});
const awardRead = (game: Game, id = AWARD_ID) => ({
  enabled: true,
  award: award(game, id),
  gameState: state(game),
  quote: {
    guarantee: 'standard',
    minimumPayoutChips: 0.1,
    mode: CHOICE_MODE[game],
    plinkoTable: 5,
  },
});
const opened = (game: Game) => ({
  ...fixtures.receipts[game],
  status: 'open',
  picked: [] as number[],
  proof: null,
  payout_chips: 0,
  minimum_payout_chips: 0.1,
  award_id: AWARD_ID,
});
/** Tile 8 (cell 7) is a mine on the fixture board [5, 7, 16, 23, 24]. */
const lost = (game: Game) => ({
  ...fixtures.receipts[game],
  status: 'lost',
  picked: game === 'mines' ? [7] : [0],
  payout_chips: 0.1,
  minimum_payout_chips: 0.1,
  award_id: AWARD_ID,
});
let dealt = 0;
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
const text = () => document.body.textContent ?? '';
const bay = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;
/** Answers the offer with Play Without, then presses Start: the two taps a
 *  won game takes (R1, R9). */
const keepAndStart = async () => {
  const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
  fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Play Without' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
  await settle();
  expect(backend.start).toHaveBeenCalledTimes(1);
};
/** Plays the losing move: the mine on tile 8, or the first street. */
const loseTheRound = async (game: Game) => {
  backend.act.mockResolvedValueOnce(lost(game));
  fireEvent.click(
    game === 'mines'
      ? screen.getByRole('button', { name: 'Tile 8' })
      : screen.getByRole('button', { name: /^Cross Street/ })
  );
  await settle();
};
/** The crossing's reveal belongs to the scene: the console prints the finished
 *  round once the scene says it has landed and settled. Mines has no reveal to
 *  wait on - its own board turns the tile over on the answer. */
const revealEnds = async () => {
  const finish = screen.queryByRole('button', { name: 'Finish Scene' });
  if (finish) fireEvent.click(finish);
  await settle();
};
const setupOnScreen = () =>
  ['Spin The Wheel', 'Buy More', 'Earn Diamonds', 'Playing Without Extra Diamonds: Change'].filter(
    (name) => screen.queryByRole('button', { name }) !== null
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  dealt = 0;
  backend.search.value = '';
  sessionStorage.clear();
  backend.awardState.mockReset();
  backend.state.mockReset();
  backend.act.mockReset();
  backend.start.mockReset();
  backend.rpc.mockReset().mockImplementation(async () => {
    dealt += 1;
    return {
      error: null,
      data: {
        ok: true,
        commit_id: `00000000-0000-0000-0000-${String(dealt).padStart(12, '0')}`,
        server_seed_hash: dealt.toString(16).padStart(64, 'a'),
      },
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(['mines', 'crossing'] as const)('%s: the round that just finished', (game) => {
  const play = async (nextAward: boolean) => {
    let spent = false;
    backend.awardState.mockImplementation(async () =>
      spent
        ? nextAward
          ? awardRead(game, NEXT_AWARD_ID)
          : { enabled: true, award: null, gameState: null, quote: null }
        : awardRead(game)
    );
    backend.state.mockResolvedValue(state(game));
    backend.start.mockImplementation(async () => {
      spent = true;
      return opened(game);
    });
    render(<DiamondChoicePage game={game} />);
    await settle();
    await keepAndStart();
    expect(setupOnScreen()).toEqual([]);
    backend.state.mockResolvedValue(state(game, { history: [lost(game)] }));
    await loseTheRound(game);
  };

  it('keeps the setup off screen while it is revealed, and shows its own floor', async () => {
    await play(false);
    // While the scene is still revealing the hit, the setup is off screen.
    expect(setupOnScreen()).toEqual([]);
    await revealEnds();
    // Mines books the chips, the crossing books its guarantee; both say so.
    expect(text()).toMatch(/0\.10 Chips (Are )?Booked/);
    expect(text()).not.toContain('Win This Game On Diamond Spins To Play.');
    expect(setupOnScreen()).toEqual([]);
    expect(bay('Guaranteed').textContent).toBe('0.10 Chips');
  });

  it("never opens a next award's Double Down offer over the reveal", async () => {
    await play(true);
    await advance(10_000);
    expect(screen.queryByRole('dialog', { name: 'Double Your Diamonds' })).toBeNull();
    expect(setupOnScreen()).toEqual([]);
    expect(bay('Guaranteed').textContent).toBe('0.10 Chips');
    // Nothing starts over the finished round either.
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
});

describe('a finished round reopened from its wheel link', () => {
  const redeemed = () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: { ...award('mines', AWARD_ID, 'redeemed'), result: lost('mines') },
      gameState: null,
      quote: null,
    });
    backend.state.mockResolvedValue(state('mines', { history: [lost('mines')] }));
  };

  it('shows its board, its booked chips and its receipt, then goes back to the wheel', async () => {
    backend.search.value = `?wheelAward=${AWARD_ID}`;
    redeemed();
    render(<DiamondChoicePage game="mines" />);
    await settle();
    expect(screen.getAllByRole('button', { name: /, Mine$/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Tile 8, Mine' })).toHaveAttribute(
      'data-hit',
      'true'
    );
    expect(text()).toContain('A Mine Ended This Round. All Mines Are Revealed. 0.10 Chips Booked.');
    expect(text()).not.toContain('Win This Game On Diamond Spins To Play.');
    expect(setupOnScreen()).toEqual([]);
    expect(bay('Guaranteed').textContent).toBe('0.10 Chips');
    // The board finishes turning over; the receipt follows and takes the player back.
    fireEvent.animationEnd(screen.getByLabelText('Diamond Mines Board'));
    await settle();
    const receipt = screen.getByRole('dialog', { name: '0.10 Chips' });
    // The receipt stays until the player taps: it no longer returns on a clock
    // (owner ruling 2026-09-21, R1).
    expect(receipt).toHaveTextContent('Your Prize Is Booked.');
    fireEvent.animationEnd(receipt.querySelector('[data-motion="keep"]')!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Back To The Wheel' }));
    expect(backend.navigate).toHaveBeenCalledWith(`/clubs/${CLUB}/wheel`, { replace: true });
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('is never replayed on a visit without the link', async () => {
    redeemed();
    render(<DiamondChoicePage game="mines" />);
    await settle();
    await advance(10_000);
    expect(screen.queryAllByRole('button', { name: /, Mine$/ })).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(text()).toContain('Win This Game On Diamond Spins To Play.');
    expect(backend.navigate).not.toHaveBeenCalled();
  });
});

describe('the seed on screen', () => {
  it('is the seed an open round read back from the server was sealed with', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: null,
      gameState: null,
      quote: null,
    });
    backend.state.mockResolvedValue(state('mines', { open_round: opened('mines') }));
    render(<DiamondChoicePage game="mines" />);
    await settle();
    expect(screen.getByRole('button', { name: 'Tile 8' })).toBeInTheDocument();
    expect(screen.getByLabelText('Your Seed')).toHaveValue(fixtures.receipts.mines.client_seed);
  });
});
