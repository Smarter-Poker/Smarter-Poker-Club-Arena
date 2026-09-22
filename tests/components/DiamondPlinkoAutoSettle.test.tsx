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
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
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
/** Answer screen one, the Double Your Diamonds offer (R9). Nothing starts over
 * it, and nothing starts after it: Drop Diamonds is the player's own (R1). */
const answerOffer = async (name: 'Play Without' | 'Add The Diamonds' = 'Play Without') => {
  const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
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
/** Release every drop still in hand, then let the board report them landed. */
const finishDrops = async () => {
  const all = screen.queryByRole('button', { name: 'Drop All' });
  if (all) fireEvent.click(all);
  await advance();
  fireEvent.click(screen.getByRole('button', { name: 'Finish Drops' }));
  await advance();
};
/** Screen two (R6): the player chooses what each drop plays before they can drop. */
const chooseDrops = async (perDrop: number, drops: number) => {
  fireEvent.click(
    screen.getByRole('button', {
      name: `${perDrop.toLocaleString()} Diamonds Per Drop, ${drops.toLocaleString()} Drops`,
    })
  );
  await advance();
};
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

describe('a won Plinko game waits for the player, and drops what they chose', () => {
  it('waits on its plate however long, then drops once when it is pressed', async () => {
    fakeClock();
    won();
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    await chooseDrops(20, 10);
    expect(drop()).toBeEnabled();
    // A game that can start holds the player until it has.
    expect(holding()).toBe(true);
    await advance(60000);
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(drop());
    await advance();
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

  it('drops the doubled entry after the player changes their Double Down answer', async () => {
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
    // Reopening the offer takes the plate back until the new answer is given.
    fireEvent.click(screen.getByRole('button', { name: 'Playing Without Extra Diamonds: Change' }));
    await advance();
    await answerOffer('Add The Diamonds');
    // The doubled stake is a new split, so the drop value is chosen again.
    await chooseDrops(500, 10);
    expect(drop()).toBeEnabled();
    await advance(60000);
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(drop());
    await advance();
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

  it('drops the seed the player typed, and never one they replaced', async () => {
    fakeClock();
    won();
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    await chooseDrops(20, 10);
    const seed = screen.getByLabelText('Your Seed');
    fireEvent.change(seed, { target: { value: '' } });
    await advance(10000);
    // An empty seed cannot be sent, and nothing sends one.
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.change(seed, { target: { value: 'my-own-seed' } });
    await advance();
    expect(drop()).toBeEnabled();
    await advance(60000);
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(drop());
    await advance();
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
    // The offer is this award's own question, whatever the last one answered.
    await advance(10000);
    expect(backend.start).not.toHaveBeenCalled();
    await answerOffer();
    await chooseDrops(20, 10);
    fireEvent.click(drop());
    await advance();
    // The player played the award alone: no diamonds of their own.
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
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: '10 Diamonds Per Drop, 10 Drops' }));
    await act(async () => {});
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
    await chooseDrops(20, 10);
    fireEvent.click(drop());
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
    await finishDrops();
    expect(screen.getByRole('dialog', { name: '3.25 Chips' })).toBeInTheDocument();
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('re-sends the refused wager on its fresh ticket without waiting for the page to re-quote', async () => {
    // Review 2026-09-21: the owed wager is the exact request the player sent.
    // It goes again as it was, on the fresh ticket; the server is the only
    // judge of whether it can still start, so a quote in flight on the page
    // neither delays it nor changes it.
    fakeClock();
    direct();
    backend.getState.mockResolvedValueOnce(DIRECT_STATE).mockReturnValueOnce(new Promise(() => {}));
    backend.start.mockRejectedValueOnce(new BonusRefusal(TICKET_REFUSED, true));
    render(<DiamondPlinkoPage />);
    await advance();
    await chooseDrops(10, 10);
    fireEvent.click(drop());
    await advance();
    expect(backend.commit).toHaveBeenCalledTimes(2);
    const [first, second] = requests();
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(second).toEqual({
      ...first,
      commitId: TICKETS[1].commit_id,
      serverSeedHash: TICKETS[1].server_seed_hash,
    });
    await advance(10000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('sends a refused ticket again at most twice, then leaves Drop to the player', async () => {
    fakeClock();
    won();
    backend.start.mockRejectedValue(new BonusRefusal(TICKET_REFUSED, true));
    render(<DiamondPlinkoPage />);
    await advance();
    await answerOffer();
    await chooseDrops(20, 10);
    fireEvent.click(drop());
    await advance();
    // The player's own drop and two restarts, each on its own fresh ticket.
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
    await chooseDrops(20, 10);
    expect(statusLine()).toHaveTextContent('Preparing Your Ticket');
    expect(drop()).toBeDisabled();
    await advance(1000);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    await advance(1999);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(backend.commit).toHaveBeenCalledTimes(3);
    expect(statusLine()).not.toHaveTextContent('Preparing Your Ticket');
    expect(drop()).toBeEnabled();
    await advance(4000);
    expect(backend.commit).toHaveBeenCalledTimes(3);
    // A deal that answered starts the schedule afresh: the next failed deal
    // is tried again after one second, not after the old count's wait.
    backend.start.mockRejectedValueOnce(new BonusRefusal('Plinko Is Busy'));
    backend.commit.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(drop());
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
    await chooseDrops(20, 10);
    expect(drop()).toBeEnabled();
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
    await chooseDrops(10, 10);
    expect(drop()).toBeDisabled();
    await advance(1000);
    expect(backend.getState).toHaveBeenCalledTimes(2);
    expect(statusLine()).not.toHaveTextContent('Checking Your Entry');
    expect(drop()).toBeEnabled();
    await advance(60000);
    expect(backend.getState).toHaveBeenCalledTimes(2);
  });

  it('checks a direct entry again when the read after a drop fails, so the next drop is never held', async () => {
    // Review 2026-09-22: every read clears the entry quote, but only the
    // quote's own effect used to try again after a failure. The read that
    // follows a booked drop is another one: when it was lost, Drop stayed
    // disabled on Checking This Entry until somebody reloaded the page.
    fakeClock();
    direct();
    backend.getState
      .mockResolvedValueOnce(DIRECT_STATE)
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(DIRECT_STATE);
    backend.start.mockResolvedValueOnce(receipt(1.5));
    render(<DiamondPlinkoPage />);
    await advance();
    await chooseDrops(10, 10);
    fireEvent.click(drop());
    await advance();
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.getState).toHaveBeenCalledTimes(2);
    await finishDrops();
    expect(
      screen.getByText('Checking This Entry And The Available Prize Cover')
    ).toBeInTheDocument();
    expect(drop()).toBeDisabled();
    // The page reads the entry again by itself, on the same schedule as every other read.
    await advance(1000);
    expect(backend.getState).toHaveBeenCalledTimes(3);
    expect(drop()).toBeEnabled();
    await advance(60000);
    expect(backend.getState).toHaveBeenCalledTimes(3);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
});

describe('a refused ticket re-sends the saved wager, never a rebuilt one', () => {
  it('re-sends a saved Double Down once even when it can no longer be afforded, then hands the choice back', async () => {
    // Review 2026-09-21: an owed restart the page could not afford used to wait
    // forever, with the setup (and so Keep My Bonus) disabled underneath it.
    fakeClock();
    won({ ...state, player: { ...state.player, spendable: 0 } });
    const saved = {
      clubId: CLUB,
      game: 'plinko',
      budget: { ...AWARD_BUDGET, doubled: true, denomination: 30 },
      commitId: '00000000-0000-0000-0000-0000000000aa',
      serverSeedHash: 'f'.repeat(64),
      seed: 'saved-seed',
      tableVersion: 4,
    };
    sessionStorage.setItem(`diamond-spins-pending:player-a:${CLUB}:plinko`, JSON.stringify(saved));
    backend.start
      .mockRejectedValueOnce(new BonusRefusal(TICKET_REFUSED, true))
      .mockRejectedValueOnce(new BonusRefusal('Buy More Diamonds To Double Down'));
    render(<DiamondPlinkoPage />);
    await advance();
    await advance(1000);
    const [replay, restart] = requests();
    expect(replay).toEqual(saved);
    expect(restart).toEqual({
      ...saved,
      commitId: TICKETS[0].commit_id,
      serverSeedHash: TICKETS[0].server_seed_hash,
    });
    // The restart is spent: the setup is the player's again, offer included.
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    expect(holding()).toBe(false);
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });
});
