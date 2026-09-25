/**
 * THE SETUP'S OWN EXITS WORK WHENEVER NOTHING IS IN FLIGHT (review 2026-09-22).
 *
 * The exit guard holds a Donkey Cross or Diamond Mines page while a won game
 * could start, so the game can start itself. It also swallowed the setup's own
 * exits: the Double Down offer's Buy More, shown to a player short of the
 * diamonds to double, answered "Finish Your Bonus Game Before Leaving." and went
 * nowhere, and so did Buy More and Earn Diamonds under the award. Each exit now
 * lets go of the hold and leaves.
 *
 * It can only do that when no money is in flight: the setup is disabled while a
 * start is out, while a saved wager settles and while a refused ticket is
 * re-sent, and it is not on screen while a round is open. Those cases are
 * pinned below too. The guard and the router are real here; the clock is fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import { CHOICE_MODE } from '../../src/utils/diamondChoiceMath';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  act: vi.fn(),
  start: vi.fn(),
  rpc: vi.fn(),
  awardState: vi.fn(),
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
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/components/games/ChoiceScene', () => ({
  default: ({ phase }: { phase: string }) => <section aria-label={`Scene ${phase}`} />,
}));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));

type Game = 'crossing' | 'mines';
const CLUB = '00000000-0000-0000-0000-000000000003';
const BLOCKED = 'Finish Your Bonus Game Before Leaving.';
const state = (game: Game, diamonds: number) => ({
  ok: true,
  available: true,
  frozen: false,
  reason: null,
  is_member: true,
  diamonds,
  member_chips: 0,
  diamonds_per_chip: 100,
  bets: [100],
  open_round: null as unknown,
  history: [],
  max_steps: game === 'mines' ? 11 : 12,
  prizes: game === 'mines' ? fixtures.receipts.mines.prizes.slice(0, 11) : Array(12).fill(1),
  rounds_today: 0,
  daily_limit: 500,
  diamonds_today: 0,
  seconds_until_next: 0,
});
/** A wheel award for the game: 100 diamonds funded, 100 spun, so doubling costs 100. */
const award = (game: Game) => ({
  id: '00000000-0000-0000-0000-000000000077',
  game,
  club_id: CLUB,
  base_diamonds: 100,
  entry_diamonds: 100,
  boost_multiplier: 1,
  status: 'pending',
});
const won = (game: Game, diamonds: number) => {
  backend.awardState.mockResolvedValue({
    enabled: true,
    award: award(game),
    gameState: state(game, diamonds),
    quote: {
      guarantee: 'standard',
      minimumPayoutChips: 0.1,
      mode: CHOICE_MODE[game],
      plinkoTable: 5,
    },
  });
  backend.state.mockResolvedValue(state(game, diamonds));
};
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
const mount = async (game: Game) => {
  render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB}/${game}`]}>
      <Routes>
        <Route path={`/clubs/:clubId/${game}`} element={<DiamondChoicePage game={game} />} />
        <Route path="/marketplace" element={<h1>Marketplace Page</h1>} />
        <Route path="/clubs/:clubId/earn-diamonds" element={<h1>Earn Diamonds Page</h1>} />
        <Route path="/clubs/:clubId/wheel" element={<h1>Wheel Page</h1>} />
        <Route path="/clubs/:clubId/diamond-games" element={<h1>Diamond Spins Page</h1>} />
      </Routes>
    </MemoryRouter>
  );
  await settle();
};
const offer = () => screen.getByRole('dialog', { name: 'Double Your Diamonds' });
const revealOffer = () => fireEvent.animationEnd(offer().querySelector('[data-motion="keep"]')!);

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  backend.state.mockReset();
  backend.act.mockReset();
  backend.awardState.mockReset();
  // A start stays out unless a test answers it.
  backend.start.mockReset().mockReturnValue(new Promise(() => {}));
  let dealt = 0;
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

describe.each(['mines', 'crossing'] as const)(
  '%s: the setup exits while a won game could start',
  (game) => {
    it("takes a player short of the diamonds to double from the offer's Buy More to the marketplace", async () => {
      won(game, 40);
      await mount(game);
      revealOffer();
      expect(
        within(offer()).getByText(/You Need 60 More Diamonds To Add Them/)
      ).toBeInTheDocument();
      fireEvent.click(within(offer()).getByRole('button', { name: 'Buy More' }));
      await settle();
      expect(screen.getByRole('heading', { name: 'Marketplace Page' })).toBeInTheDocument();
      expect(screen.queryByText(BLOCKED)).toBeNull();
      expect(backend.start).not.toHaveBeenCalled();
    });

    it.each([
      ['Buy More', 'Marketplace Page'],
      ['Earn Diamonds', 'Earn Diamonds Page'],
    ])('leaves by %s while the answered award waits on its plate', async (exit, page) => {
      won(game, 10000);
      await mount(game);
      revealOffer();
      fireEvent.click(within(offer()).getByRole('button', { name: 'Play Without' }));
      await advance(1000);
      // The offer is answered, so the hold is armed and Start is the player's.
      expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: exit }));
      await settle();
      expect(screen.getByRole('heading', { name: page })).toBeInTheDocument();
      // Gone without pressing Start: nothing ran behind the player.
      await advance(10000);
      expect(backend.start).not.toHaveBeenCalled();
    });
  }
);

describe('money in flight keeps the exits shut', () => {
  it('while a start is out, every exit is disabled and the page holds the player', async () => {
    won('mines', 10000);
    await mount('mines');
    revealOffer();
    fireEvent.click(within(offer()).getByRole('button', { name: 'Play Without' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await settle();
    expect(backend.start).toHaveBeenCalledTimes(1);
    for (const exit of ['Buy More', 'Earn Diamonds', 'Playing Without Extra Diamonds: Change'])
      expect(screen.getByRole('button', { name: exit })).toBeDisabled();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Diamond Spins/ }));
    await settle();
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Diamond Spins Page' })).toBeNull();
  });

  it('while a saved wager settles, every exit is disabled and the page holds the player', async () => {
    won('crossing', 10000);
    sessionStorage.setItem(
      `diamond-spins-pending:player-a:${CLUB}:crossing`,
      JSON.stringify({
        clubId: CLUB,
        game: 'crossing',
        mode: CHOICE_MODE.crossing,
        budget: {
          base: 100,
          doubled: false,
          denomination: 10,
          award: { id: award('crossing').id, entryDiamonds: 100, boostMultiplier: 1 },
        },
        commitId: '00000000-0000-0000-0000-0000000000aa',
        serverSeedHash: 'f'.repeat(64),
        seed: 'saved-seed',
        maxSteps: 12,
      })
    );
    await mount('crossing');
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Settling')).toBeInTheDocument();
    for (const exit of ['Buy More', 'Earn Diamonds'])
      expect(screen.getByRole('button', { name: exit })).toBeDisabled();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Diamond Spins/ }));
    await settle();
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Diamond Spins Page' })).toBeNull();
  });

  it('while a round is open, the setup and its exits are not on screen at all', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: null,
      gameState: null,
      quote: null,
    });
    backend.state.mockResolvedValue({
      ...state('mines', 10000),
      open_round: {
        ...fixtures.receipts.mines,
        status: 'open',
        picked: [],
        proof: null,
        payout_chips: 0,
      },
    });
    await mount('mines');
    expect(screen.getByRole('region', { name: 'Scene open' })).toBeInTheDocument();
    for (const exit of ['Buy More', 'Earn Diamonds', 'Spin The Wheel'])
      expect(screen.queryByRole('button', { name: exit })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Diamond Spins/ }));
    await settle();
    expect(screen.getByText(BLOCKED)).toBeInTheDocument();
  });
});
