vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { BonusRefusal } from '../../src/services/DiamondBonusService';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
/**
 * PLINKO PLAYS ITSELF (owner ruling, 2026-09-21): "NO GAMES SHOULD EVER
 * REQUIRE A USER TO CHECK ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY."
 *
 * Every state that used to wait for a press - a won game waiting for Drop, a
 * ticket the server refused, a ticket, quote or club that did not load - now
 * moves on by itself, and the player can still leave any game that cannot
 * start. The clock is fake wherever time is the thing under test, so nothing
 * here depends on how busy the machine is.
 */
const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  start: vi.fn(),
  latest: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: backend }));
vi.mock('../../src/services/DiamondBonusService', () => ({
  DiamondBonusService: backend,
  // The real refusal's shape: why, and whether the sealed ticket was the reason.
  BonusRefusal: class extends Error {
    constructor(
      message: string,
      readonly ticketGone = false
    ) {
      super(message);
    }
  },
  parsePlinkoBonus: (v: unknown) => v,
}));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
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
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => backend.resolve(id),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useMeasuredWidth', () => ({ useMeasuredWidth: () => [null, 320] }));
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({
  default: ({
    batchPathBits,
    onLanded,
  }: {
    batchPathBits: number[] | null;
    onLanded: () => void;
  }) => (batchPathBits ? <button onClick={onLanded}>Finish Drops</button> : null),
}));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({ title, detail }: { title: string; detail: string }) => (
    <div role="dialog" aria-label={title}>
      {detail}
    </div>
  ),
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));

const CLUB = '00000000-0000-0000-0000-000000000003';
const AWARD_ID = '00000000-0000-0000-0000-000000000077';
/** Sealed tickets, dealt in this order. */
const TICKETS = ['a', 'b', 'c', 'd'].map((hex) => ({
  ok: true,
  commit_id: `00000000-0000-0000-0000-00000000000${hex}`,
  server_seed_hash: hex.repeat(64),
}));
const TABLES = [
  {
    name: 'Diamond',
    version: 5,
    multipliers_cents: PLINKO_TABLES[5].multipliersCents,
    max_multiplier_cents: 2000,
  },
  {
    name: 'Super',
    version: 4,
    multipliers_cents: PLINKO_TABLES[4].multipliersCents,
    max_multiplier_cents: 2000,
  },
];
const state = {
  available: true,
  frozen: false,
  tables: TABLES,
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  config: { max_rounds_per_player_per_day: 500 },
  player: { spendable: 0, is_member: true, rounds_today: 0, seconds_until_next: 0 },
};
const award = {
  id: AWARD_ID,
  game: 'plinko',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
const AWARD_BUDGET = {
  base: 200,
  doubled: false,
  denomination: 20,
  award: { id: AWARD_ID, entryDiamonds: 100, boostMultiplier: 2 },
};
/** The wheel won this player a Super Plinko game, quoted by the server. */
const won = (gameState: object = state) =>
  backend.awardState.mockResolvedValue({
    enabled: true,
    award,
    gameState,
    quote: { guarantee: 'super', minimumPayoutChips: 10, mode: null, plinkoTable: 4 },
  });
/** Wheel awards are off at this club, so the page quotes a direct entry itself. */
const DIRECT_STATE = {
  ...state,
  bets: [{ bet_diamonds: 100, cap_cents: 2000, playable: true }],
  player: { ...state.player, spendable: 100 },
};
const direct = () =>
  backend.awardState.mockResolvedValue({
    enabled: false,
    award: null,
    gameState: null,
    quote: null,
  });
const receipt = (payout: number) => ({
  ...fixtures.receipts.plinko,
  table_version: 4,
  payout_chips: payout,
});
const TICKET_REFUSED = 'This Ticket Can No Longer Open A Game';

/** Moves the fake clock, then lets every answer and every retry due at once
 * (useAutoSettle's first try is at 0 ms) land. */
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
/** Answer the Double Down offer. A won game never starts over it: it spends
 * the player's own diamonds, so the countdown waits for the answer (or for the
 * offer to keep the bonus by itself). */
const answerOffer = async (name: 'Keep My Bonus' | 'Add Diamonds' = 'Keep My Bonus') => {
  const offer = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
  fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
  fireEvent.click(screen.getByRole('button', { name }));
  await advance();
};
const fakeClock = () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
};
/** The line above the board that says what the game is doing. */
const statusLine = () =>
  screen.getAllByRole('status').find((node) => node.classList.contains('sc-copy'));
const drop = () => screen.getByRole('button', { name: 'Drop Diamonds' });
const dropsIn = (seconds: number) =>
  screen.getByRole('button', { name: `Dropping In ${seconds}s` });
/** Whether the exit guard holds the player, as of the latest render. */
const holding = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)?.[0];
const requests = () => backend.start.mock.calls.map(([request]) => request);

beforeEach(() => {
  vi.clearAllMocks();
  // Answers queued for one test never reach the next one.
  for (const mock of Object.values(backend)) mock.mockReset();
  sessionStorage.clear();
  backend.resolve.mockImplementation(async (id: string) => id);
  backend.latest.mockResolvedValue(null);
  backend.getState.mockResolvedValue(DIRECT_STATE);
  let dealt = 0;
  backend.commit.mockImplementation(async () => TICKETS[dealt++ % TICKETS.length]);
  // A start stays in flight unless a test answers it.
  backend.start.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a won Plinko game starts itself', () => {
  it('drops after five seconds, not before, and only once', async () => {
    fakeClock();
    won();
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    expect(dropsIn(5)).toBeEnabled();
    // A game that can start holds the player until it has.
    expect(holding()).toBe(true);
    await advance(4000);
    expect(dropsIn(1)).toBeEnabled();
    await advance(999);
    expect(backend.start).not.toHaveBeenCalled();
    await advance(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        clubId: CLUB,
        commitId: TICKETS[0].commit_id,
        serverSeedHash: TICKETS[0].server_seed_hash,
        tableVersion: 4,
        budget: AWARD_BUDGET,
      }),
      'player-a'
    );
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(holding()).toBe(true);
  });

  it('starts the five seconds again when the player doubles down', async () => {
    fakeClock();
    const ordinary = { ...award, base_diamonds: 2500, entry_diamonds: 2500, boost_multiplier: 1 };
    backend.awardState.mockImplementation(async (_club, _game, doubled) => ({
      enabled: true,
      award: ordinary,
      gameState: {
        ...state,
        bets: [{ bet_diamonds: doubled ? 5000 : 2500, cap_cents: 2000, playable: true }],
        player: { ...state.player, spendable: 10000 },
      },
      quote: {
        guarantee: 'standard',
        minimumPayoutChips: doubled ? 50 : 25,
        mode: null,
        plinkoTable: 5,
      },
    }));
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    await advance(3000);
    expect(dropsIn(2)).toBeEnabled();
    // Reopening the offer stops the clock; the new answer is a new entry.
    fireEvent.click(screen.getByRole('button', { name: 'Double Down Your Bonus' }));
    await advance();
    await answerOffer('Add Diamonds');
    expect(dropsIn(5)).toBeEnabled();
    await advance(4999);
    expect(backend.start).not.toHaveBeenCalled();
    await advance(1);
    expect(requests()).toEqual([
      expect.objectContaining({
        tableVersion: 5,
        budget: {
          base: 2500,
          doubled: true,
          denomination: 500,
          award: { id: AWARD_ID, entryDiamonds: 2500, boostMultiplier: 1 },
        },
      }),
    ]);
  });

  it('starts the five seconds again while the player types a seed, and drops that seed', async () => {
    fakeClock();
    won();
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    await advance(3000);
    expect(dropsIn(2)).toBeEnabled();
    const seed = screen.getByLabelText('Your Seed');
    fireEvent.change(seed, { target: { value: '' } });
    await advance(10000);
    // An empty seed cannot be sent, so nothing counts down and nothing starts.
    expect(drop()).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.change(seed, { target: { value: 'my-own-seed' } });
    await advance();
    expect(dropsIn(5)).toBeEnabled();
    await advance(4999);
    expect(backend.start).not.toHaveBeenCalled();
    await advance(1);
    expect(requests()).toEqual([expect.objectContaining({ seed: 'my-own-seed' })]);
  });

  it('never drops a Double Down chosen for an earlier award on this one', async () => {
    fakeClock();
    // The setup remembers the last choice, made here for another award.
    sessionStorage.setItem(
      `diamond-spins-budget:player-a:${CLUB}:plinko`,
      JSON.stringify({
        base: 200,
        doubled: true,
        denomination: 30,
        award: {
          id: '00000000-0000-0000-0000-000000000066',
          entryDiamonds: 100,
          boostMultiplier: 2,
        },
      })
    );
    backend.awardState.mockImplementation(async (_club, _game, doubled) => ({
      enabled: true,
      award,
      gameState: {
        ...state,
        bets: [{ bet_diamonds: doubled ? 300 : 200, cap_cents: 2000, playable: true }],
        player: { ...state.player, spendable: 10000 },
      },
      quote: {
        guarantee: 'super',
        minimumPayoutChips: doubled ? 15 : 10,
        mode: null,
        plinkoTable: 4,
      },
    }));
    render(<DiamondPlinkoPage />);
    await advance();
    // Nobody answers the offer, so it keeps the bonus by itself: the choice
    // that costs nothing. Then the won game counts down and drops.
    await advance(2000);
    await advance(8000);
    expect(backend.start).not.toHaveBeenCalled();
    await advance(5000);
    // The window dropped the award alone: no diamonds of the player's own.
    expect(requests()).toEqual([expect.objectContaining({ budget: AWARD_BUDGET })]);
  });

  it.each([
    ['during the maintenance break', { frozen: true }],
    ["at today's limit", { player: { ...state.player, rounds_today: 500 } }],
    ['where Plinko is closed', { available: false }],
  ])('never holds the player on a won game that cannot start: %s', async (_when, change) => {
    fakeClock();
    won({ ...state, ...change });
    render(<DiamondPlinkoPage />);
    await advance();
    expect(screen.getByRole('heading', { name: 'Super Plinko' })).toBeVisible();
    expect(holding()).toBe(false);
    expect(drop()).toBeDisabled();
    await advance(60000);
    expect(backend.start).not.toHaveBeenCalled();
    expect(holding()).toBe(false);
  });

  it('holds the player while a drop is in flight', async () => {
    direct();
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    // Nothing won and nothing in flight: nothing to hold.
    expect(holding()).toBe(false);
    fireEvent.click(drop());
    await act(async () => {});
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(holding()).toBe(true);
  });
});

describe('a wager settles itself', () => {
  it('replays a wager this tab saved and never settled, with no press, and books it once', async () => {
    fakeClock();
    won();
    const saved = {
      clubId: CLUB,
      game: 'plinko',
      budget: AWARD_BUDGET,
      commitId: TICKETS[3].commit_id,
      serverSeedHash: TICKETS[3].server_seed_hash,
      seed: 'saved-seed',
      tableVersion: 4,
    };
    sessionStorage.setItem(`diamond-spins-pending:player-a:${CLUB}:plinko`, JSON.stringify(saved));
    backend.start.mockResolvedValueOnce(receipt(3.25));
    render(<DiamondPlinkoPage />);
    await advance();
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(saved, 'player-a');
    expect(screen.getByRole('dialog', { name: '3.25 Chips' })).toBeInTheDocument();
    // No ticket was dealt until the saved wager had settled, so no second
    // wager could have started beside it, and nothing starts under its result.
    expect(backend.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      backend.start.mock.invocationCallOrder[0]
    );
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('re-deals a ticket the server refused and drops the same wager again, with no press', async () => {
    fakeClock();
    won();
    backend.start
      .mockRejectedValueOnce(new BonusRefusal(TICKET_REFUSED, true))
      .mockResolvedValueOnce(receipt(3.25));
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    fireEvent.click(dropsIn(5));
    await advance();
    // One extra start: the same entry, seed and table on the fresh ticket.
    const [first, second] = requests();
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(first.commitId).toBe(TICKETS[0].commit_id);
    expect(second).toEqual({
      ...first,
      commitId: TICKETS[1].commit_id,
      serverSeedHash: TICKETS[1].server_seed_hash,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Finish Drops' }));
    await advance();
    expect(screen.getByRole('dialog', { name: '3.25 Chips' })).toBeInTheDocument();
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('keeps a refused ticket’s restart owed until Drop would be accepted', async () => {
    fakeClock();
    direct();
    let quoteAgain!: (value: unknown) => void;
    backend.getState.mockResolvedValueOnce(DIRECT_STATE).mockReturnValueOnce(
      new Promise((resolve) => {
        quoteAgain = resolve;
      })
    );
    backend.start.mockRejectedValueOnce(new BonusRefusal(TICKET_REFUSED, true));
    render(<DiamondPlinkoPage />);
    await advance();
    fireEvent.click(drop());
    await advance();
    // A fresh ticket is dealt and the entry quoted again; until that quote
    // lands the page could not drop, so the restart is still owed, not spent.
    expect(backend.commit).toHaveBeenCalledTimes(2);
    expect(backend.getState).toHaveBeenCalledTimes(2);
    await advance(10000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      quoteAgain(DIRECT_STATE);
    });
    await advance();
    const [first, second] = requests();
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(second).toEqual({
      ...first,
      commitId: TICKETS[1].commit_id,
      serverSeedHash: TICKETS[1].server_seed_hash,
    });
  });

  it('sends a refused ticket again at most twice, then leaves Drop to the player', async () => {
    fakeClock();
    won();
    backend.start.mockRejectedValue(new BonusRefusal(TICKET_REFUSED, true));
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    await advance(5000);
    // The window's own start and two restarts, each on its own fresh ticket.
    expect(backend.start).toHaveBeenCalledTimes(3);
    expect(new Set(requests().map((request) => request.commitId)).size).toBe(3);
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(3);
    expect(statusLine()).toHaveTextContent(TICKET_REFUSED);
    expect(drop()).toBeEnabled();
  });
});

describe('a read that fails asks again by itself', () => {
  it('deals a ticket again after a failed deal, then enables Drop', async () => {
    fakeClock();
    won();
    backend.commit
      .mockRejectedValueOnce(new Error('Offline'))
      .mockRejectedValueOnce(new Error('Offline'));
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    expect(statusLine()).toHaveTextContent('Preparing Your Ticket');
    expect(drop()).toBeDisabled();
    await advance(1000);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    await advance(1999);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(backend.commit).toHaveBeenCalledTimes(3);
    expect(statusLine()).not.toHaveTextContent('Preparing Your Ticket');
    expect(dropsIn(5)).toBeEnabled();
    await advance(4000);
    expect(backend.commit).toHaveBeenCalledTimes(3);
    // A deal that answered starts the schedule afresh: the next failed deal
    // is tried again after one second, not after the old count's wait.
    backend.start.mockRejectedValueOnce(new BonusRefusal('Plinko Is Busy'));
    backend.commit.mockRejectedValueOnce(new Error('Offline'));
    await advance(1000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.commit).toHaveBeenCalledTimes(4);
    await advance(1000);
    expect(backend.commit).toHaveBeenCalledTimes(5);
    expect(drop()).toBeEnabled();
  });

  it('reconnects to Plinko after a failed club read', async () => {
    fakeClock();
    won();
    backend.resolve
      .mockRejectedValueOnce(new Error('Offline'))
      .mockRejectedValueOnce(new Error('Offline'));
    render(<DiamondPlinkoPage />);
    await advance();
    expect(statusLine()).toHaveTextContent('Reconnecting To Plinko');
    await advance(1000);
    expect(backend.resolve).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(backend.resolve).toHaveBeenCalledTimes(3);
    expect(statusLine()).not.toHaveTextContent('Reconnecting To Plinko');
    await answerOffer();
    expect(dropsIn(5)).toBeEnabled();
    await advance(4000);
    expect(backend.resolve).toHaveBeenCalledTimes(3);
  });

  it('checks a direct entry again after a failed quote', async () => {
    fakeClock();
    direct();
    backend.getState.mockRejectedValueOnce(new Error('Offline'));
    render(<DiamondPlinkoPage />);
    await advance();
    expect(statusLine()).toHaveTextContent('Checking Your Entry');
    expect(drop()).toBeDisabled();
    await advance(1000);
    expect(backend.getState).toHaveBeenCalledTimes(2);
    expect(statusLine()).not.toHaveTextContent('Checking Your Entry');
    expect(drop()).toBeEnabled();
    await advance(60000);
    expect(backend.getState).toHaveBeenCalledTimes(2);
  });
});
