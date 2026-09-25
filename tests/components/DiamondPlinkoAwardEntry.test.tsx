// The real hook returns the release a page's exits call before they leave.
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn(() => () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';
import { plinkoAllocations } from '../../src/utils/bonusGameBudget';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  start: vi.fn(),
  latest: vi.fn(),
  awardState: vi.fn(),
  wheelState: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: backend }));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: backend,
  BonusRefusal: class extends Error {},
  parsePlinkoBonus: (v: unknown) => v,
}));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/services/DiamondWheelService', () => ({
  default: { getStateV2: backend.wheelState },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => backend.navigate,
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
  useLocation: () => ({ search: '' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useMeasuredWidth', () => ({ useMeasuredWidth: () => [null, 320] }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({ soundService: { playWin: vi.fn() } }));
/**
 * The board stands in for the scene: whatever the page has released is shown
 * as a count, and Land Released lands every released ball at once, reporting
 * progress the way the real board does before it says the batch is down.
 */
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({
  default: ({
    batchPathBits,
    onProgress,
    onLanded,
  }: {
    batchPathBits: number[] | null;
    onProgress: (landed: number) => void;
    onLanded: () => void;
  }) =>
    batchPathBits ? (
      <button
        onClick={() => {
          onProgress(batchPathBits.length);
          onLanded();
        }}
      >
        Land Released ({batchPathBits.length})
      </button>
    ) : null,
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
/**
 * THE PLAYER CHOOSES, AND NOTHING STARTS BY ITSELF (Dan 2026-09-21).
 *
 * R6: "On Plinko the player must choose how many diamonds to drop and the
 * value of each drop. Today it is just defaulted at 10 diamonds." R9: after
 * Play Game, the next screen decides whether to double the diamonds, and for
 * Plinko the screen after that is the selector. R1: games can never auto
 * start. This file moves the 2026-09-19 pins that the value was the tenth and
 * that nothing on the page offered a choice: the selector is back, nothing is
 * pre-selected, Drop Diamonds waits for the choice, every further ball is the
 * player's own release, and the finished receipt stays until a tap.
 */
/** The two boards production has open since 2026-09-21: Super (4) carries every
 *  half-the-stake floor, Super Double (6) the two thirds a Super award with the
 *  Double Diamonds add-on paid. Diamond (5) is closed and is never offered. */
const SUPER_TABLE = {
  name: 'Super',
  version: 4,
  multipliers_cents: PLINKO_TABLES[4].multipliersCents,
  max_multiplier_cents: 2000,
};
const SUPER_DOUBLE_TABLE = {
  name: 'Super Double',
  version: 6,
  multipliers_cents: PLINKO_TABLES[6].multipliersCents,
  max_multiplier_cents: 2000,
};
const state = {
  available: true,
  frozen: false,
  tables: [SUPER_TABLE, SUPER_DOUBLE_TABLE],
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  config: { max_rounds_per_player_per_day: 500, diamonds_per_chip: 100 },
  player: { spendable: 0, is_member: true, rounds_today: 0, seconds_until_next: 0 },
};
/** The server's own guarantee for an award, exactly as `parseBonusGuarantee`
 *  returns it. The board follows the FLOOR, not the boost: Super (4) carries
 *  every half-the-stake floor, and only a Super award that took the add-on -
 *  whose floor is the two thirds it paid - is dealt Super Double (6). */
const quoteFor = (boost: 1 | 2, minimumPayoutChips: number, plinkoTable = 4) => ({
  guarantee: boost === 2 ? ('super' as const) : ('standard' as const),
  minimumPayoutChips,
  mode: null,
  plinkoTable,
});
/** A deck bay reads `<dt>label</dt><dd>value</dd>`, so the value is the next element. */
const bay = (label: string) => screen.getByText(label).nextElementSibling;
const selector = () => screen.getByRole('group', { name: 'Diamonds Per Drop' });
const choiceLabels = () =>
  within(selector())
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
const pressed = () =>
  within(selector())
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true');
const expectedChoices = (stake: number) =>
  plinkoAllocations(stake).map(
    (a) =>
      `${a.diamondsPerDrop.toLocaleString()} ${a.diamondsPerDrop === 1 ? 'Diamond' : 'Diamonds'} Per Drop, ${a.drops.toLocaleString()} ${a.drops === 1 ? 'Drop' : 'Drops'}`
  );
/** Screen one: answer the Double Your Diamonds offer. */
async function answerOffer(choice: 'Add The Diamonds' | 'Play Without') {
  const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
  fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
  fireEvent.click(within(offer).getByRole('button', { name: choice }));
  await act(async () => {});
}
const superAward = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'plinko',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
const ordinaryAward = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'plinko',
  base_diamonds: 2500,
  entry_diamonds: 2500,
  boost_multiplier: 1,
  status: 'pending',
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  backend.getState.mockResolvedValue(state);
  backend.latest.mockResolvedValue(null);
  backend.wheelState.mockResolvedValue({ pending_awards: [] });
  backend.commit.mockResolvedValue({
    ok: true,
    commit_id: '00000000-0000-0000-0000-000000000009',
    server_seed_hash: 'a'.repeat(64),
  });
  backend.start.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('Plinko starts only its earned funding, on the player choice', () => {
  it('drops the first diamond on Drop Diamonds, the rest on the player release, and shows the exact prize until a tap', async () => {
    backend.awardState.mockResolvedValue({
      enabled: false,
      award: null,
      gameState: null,
      quote: null,
    });
    backend.getState.mockResolvedValue({
      ...state,
      bets: [{ bet_diamonds: 100, cap_cents: 2000, playable: true }],
      player: { ...state.player, spendable: 100 },
    });
    backend.start.mockResolvedValue({
      ...fixtures.receipts.plinko,
      table_version: 4,
      payout_chips: 12.57,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    // Nothing is chosen for the player: Drop Diamonds waits for the choice.
    expect(choiceLabels()).toEqual(expectedChoices(100));
    expect(pressed()).toHaveLength(0);
    expect(bay('Per Drop')).toHaveTextContent('Choose');
    expect(bay('Drops')).toHaveTextContent('Choose');
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '10 Diamonds Per Drop, 10 Drops' }));
    expect(bay('Per Drop')).toHaveTextContent('10');
    expect(bay('Drops')).toHaveTextContent('10');
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    await act(async () => {});
    // ORDINARY PLAY IS DEALT ON THE BOARD ITS FLOOR CHOSE (contract 4). 100
    // diamonds at 100 a chip is a 1.00 chip stake with a 0.50 floor, which
    // Super (4) carries. The boost used to name Diamond (5), closed since
    // 2026-09-21, so this entry could not be dealt at all.
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tableVersion: 4,
        budget: expect.objectContaining({ denomination: 10 }),
      }),
      'player-a'
    );
    // The tap that started the game released the first diamond; nine are in hand.
    expect(screen.getByRole('button', { name: 'Land Released (1)' })).toBeInTheDocument();
    expect(screen.getByText(/9 Drops In Hand/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Land Released (1)' }));
    expect(bay('Drops')).toHaveTextContent('1/10');
    // Still nothing more falls until the player says so.
    expect(screen.getByRole('button', { name: 'Land Released (1)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Drop 2 Of 10' }));
    expect(screen.getByRole('button', { name: 'Land Released (2)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Drop All' }));
    expect(screen.getByRole('button', { name: 'Land Released (10)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dropping' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Land Released (10)' }));
    await act(async () => {});
    const receipt = screen.getByRole('dialog', { name: '12.57 Chips' });
    expect(receipt).toHaveTextContent('10 Drops Completed.');
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.animationEnd(receipt.querySelector('[data-motion="keep"]')!);
    fireEvent.click(within(receipt).getByRole('button', { name: 'Back To The Wheel' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel',
      { replace: true }
    );
  });
  it('walks a Super award through the offer, then the selector, then the Super table with the chosen value', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: superAward,
      gameState: state,
      quote: quoteFor(2, 10),
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Super Plinko' })).toBeVisible();
    // Screen one: the offer. No selector yet, and Drop Diamonds is not on offer.
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Diamonds Per Drop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
    await answerOffer('Play Without');
    // Screen two: the selector, with nothing pressed and the figures unknown.
    expect(choiceLabels()).toEqual(expectedChoices(200));
    expect(pressed()).toHaveLength(0);
    expect(bay('Per Drop')).toHaveTextContent('Choose');
    expect(bay('Drops')).toHaveTextContent('Choose');
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    // The Guaranteed bay is the server's own quote, in gold for a Super award.
    expect(bay('Guaranteed')).toHaveTextContent('10.00 Chips');
    expect(bay('Guaranteed')).toHaveAttribute('data-ink', 'gold');
    expect(
      screen.getAllByText('Super Plinko Pays At Least 10.00 Chips, Even If Every Drop Lands Low.')
        .length
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
    expect(bay('Per Drop')).toHaveTextContent('20');
    expect(bay('Drops')).toHaveTextContent('10');
    expect(screen.getByText('10 Drops × 20 Diamonds = 200 Diamonds')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    // `tableVersion` is the table the quote named, and `budget.denomination` is
    // what DiamondBonusService sends as `p_denom`: the player's own choice.
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tableVersion: 4,
        budget: {
          base: 200,
          doubled: false,
          denomination: 20,
          award: { id: superAward.id, entryDiamonds: 100, boostMultiplier: 2 },
        },
      }),
      'player-a'
    );
    // An earned entry is quoted by the award read alone: no legacy direct quote.
    expect(backend.getState).not.toHaveBeenCalled();
    expect(backend.latest).not.toHaveBeenCalled();
  });
  it('offers only the values that split a doubled 5,000 into 1 to 100 drops, and plays the board its floor chose', async () => {
    backend.latest.mockResolvedValue(fixtures.receipts.plinko);
    backend.getState.mockRejectedValue(new Error('Legacy direct entry is unavailable'));
    backend.awardState.mockImplementation(async (_club, _game, doubled) => ({
      enabled: true,
      award: ordinaryAward,
      gameState: {
        ...state,
        bets: [{ bet_diamonds: doubled ? 5000 : 2500, cap_cents: 2000, playable: true }],
        player: { ...state.player, spendable: 10000 },
      },
      quote: quoteFor(1, doubled ? 50 : 25),
    }));
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Diamond Plinko' })).toBeVisible();
    await answerOffer('Add The Diamonds');
    // 5,000 diamonds: 1 to 25 a drop would be more than 100 drops, so they are
    // not offered; the whole stake as one drop always is (the server's rule).
    expect(choiceLabels()).toEqual(expectedChoices(5000));
    expect(choiceLabels()).toEqual([
      '50 Diamonds Per Drop, 100 Drops',
      '100 Diamonds Per Drop, 50 Drops',
      '250 Diamonds Per Drop, 20 Drops',
      '500 Diamonds Per Drop, 10 Drops',
      '5,000 Diamonds Per Drop, 1 Drop',
    ]);
    expect(bay('Guaranteed')).toHaveTextContent('50.00 Chips');
    expect(bay('Guaranteed')).not.toHaveAttribute('data-ink', 'gold');
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '250 Diamonds Per Drop, 20 Drops' }));
    expect(screen.getByText('20 Drops × 250 Diamonds = 5,000 Diamonds')).toBeVisible();
    expect(screen.queryByText(/Chips Booked From/)).not.toBeInTheDocument();
    // The offer is answered and a value chosen, so Drop is the player's to press (R1).
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        tableVersion: 4,
        budget: {
          base: 2500,
          doubled: true,
          denomination: 250,
          award: { id: ordinaryAward.id, entryDiamonds: 2500, boostMultiplier: 1 },
        },
      }),
      'player-a'
    );
    expect(backend.getState).not.toHaveBeenCalled();
    expect(backend.latest).not.toHaveBeenCalled();
  });
  it('never starts by itself: two idle minutes on the offer, and two more on the selector, start nothing', async () => {
    vi.useFakeTimers();
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: superAward,
      gameState: state,
      quote: quoteFor(2, 10),
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.navigate).not.toHaveBeenCalled();
    await answerOffer('Play Without');
    fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeEnabled();
  });
  it('remembers the answered offer for this award across a remount, and asks again for another', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: superAward,
      gameState: state,
      quote: quoteFor(2, 10),
    });
    const first = render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answerOffer('Play Without');
    fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
    first.unmount();
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    // The refresh lands on the selector with the player's own choice still pressed.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pressed().map((b) => b.getAttribute('aria-label'))).toEqual([
      '20 Diamonds Per Drop, 10 Drops',
    ]);
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeEnabled();
    cleanup();
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: { ...superAward, id: '00000000-0000-0000-0000-000000000078' },
      gameState: state,
      quote: quoteFor(2, 10),
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
  });
  it('refuses an uncovered entry and explains how to remove the added diamonds', async () => {
    backend.awardState.mockImplementation(async (_club, _game, doubled) => ({
      enabled: true,
      award: ordinaryAward,
      gameState: {
        ...state,
        tables: [SUPER_TABLE],
        bets: [
          { bet_diamonds: doubled ? 5000 : 2500, cap_cents: doubled ? 1000 : 2000, playable: true },
        ],
        player: { ...state.player, spendable: 10000 },
      },
      quote: quoteFor(1, 25),
    }));
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answerOffer('Add The Diamonds');
    fireEvent.click(screen.getByRole('button', { name: '500 Diamonds Per Drop, 10 Drops' }));
    expect(screen.getByText(/This Bonus Does Not Cover A Doubled Entry/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('replays the one held request when a start is uncertain, and debits nothing twice', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: superAward,
      gameState: state,
      quote: quoteFor(2, 10),
    });
    backend.start.mockRejectedValueOnce(new Error('The Network Dropped'));
    backend.start.mockResolvedValue({
      ...fixtures.receipts.plinko,
      table_version: 4,
      payout_chips: 3.25,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answerOffer('Play Without');
    fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    await act(async () => {});
    // An uncertain start is never retried as a fresh wager, and nobody is
    // asked to check anything: the page replays the held request itself.
    // (The replay can land before the first assertion, so assert the outcome,
    // not the brief "Settling" state in between.)
    expect(screen.queryByRole('button', { name: 'Check Bonus' })).not.toBeInTheDocument();
    const held = backend.start.mock.calls[0][0];
    // The same request, sent again, and the receipt is booked once.
    await waitFor(() => expect(backend.start).toHaveBeenCalledTimes(2));
    expect(backend.start.mock.calls[1][0]).toEqual(held);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: '3.25 Chips' })).toBeInTheDocument()
    );
    expect(backend.start).toHaveBeenCalledTimes(2);
  });
  it('recovers a redeemed award without admitting a second wager, and offers the next waiting game', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: {
        ...superAward,
        status: 'redeemed',
        result: {
          ...fixtures.receipts.plinko,
          award_id: superAward.id,
          table_version: 4,
          payout_chips: 7.5,
        },
      },
      gameState: null,
      quote: null,
    });
    backend.wheelState.mockResolvedValue({
      pending_awards: [
        { id: superAward.id, game: 'plinko' },
        { id: '00000000-0000-0000-0000-000000000090', game: 'crash' },
      ],
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    const receipt = screen.getByRole('dialog', { name: '7.50 Chips' });
    expect(receipt).toHaveTextContent('10 Drops Completed.');
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeDisabled();
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.animationEnd(receipt.querySelector('[data-motion="keep"]')!);
    fireEvent.click(within(receipt).getByRole('button', { name: 'Play Next Bonus Game' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/crash?wheelAward=00000000-0000-0000-0000-000000000090',
      { replace: true }
    );
  });
  it('routes a direct visitor back to the wheel without admitting a new wager', async () => {
    backend.awardState.mockResolvedValue({
      enabled: true,
      award: null,
      gameState: null,
      quote: null,
    });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Spin The Wheel' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel'
    );
    expect(backend.start).not.toHaveBeenCalled();
  });
});
