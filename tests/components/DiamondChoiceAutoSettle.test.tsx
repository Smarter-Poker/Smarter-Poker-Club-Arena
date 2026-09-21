/**
 * DONKEY CROSS AND DIAMOND MINES NEVER WAIT FOR A PRESS.
 *
 * Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
 * ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY." A Donkey Cross round sat on
 * "Check Your Saved Round Before Starting Another" with a Check Round button
 * while the bonus guard held every exit. Each case below is one way the page
 * used to wait for the player, and now settles by itself:
 *
 *  - a saved wager is replayed on its own schedule, and the round opens;
 *  - a start the server refused for its ticket alone is sent again, once, on
 *    a freshly dealt ticket;
 *  - a won game starts itself after a five-second window, which Double Down
 *    opens again;
 *  - the exit guard holds money in flight, never a won game that cannot start;
 *  - a ticket deal, or a game read, that fails is tried again by itself.
 *
 * Every case runs on fake timers and advances them explicitly; nothing here
 * waits on real time, so a loaded runner cannot change an outcome.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { CHOICE_MODE } from '../../src/utils/diamondChoiceMath';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => {
  /** The service's refusal, including the one the page settles by itself. */
  class BonusRefusal extends Error {
    constructor(
      message: string,
      readonly ticketGone = false
    ) {
      super(message);
    }
  }
  return {
    state: vi.fn(),
    act: vi.fn(),
    start: vi.fn(),
    rpc: vi.fn(),
    awardState: vi.fn(),
    navigate: vi.fn(),
    BonusRefusal,
  };
});
vi.mock('../../src/services/DiamondChoiceService', () => ({
  DiamondChoiceService: { state: backend.state, act: backend.act },
  parseChoiceRound: (value: unknown) => value,
}));
vi.mock('../../src/services/DiamondBonusService', () => ({
  DiamondBonusService: { start: backend.start },
  BonusRefusal: backend.BonusRefusal,
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
  useLocation: () => ({ search: '' }),
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/components/games/ChoiceScene', () => ({
  default: ({ phase, onSettled }: { phase: string; onSettled: () => void }) => (
    <section aria-label={`Scene ${phase}`}>
      <button onClick={onSettled}>Finish Scene</button>
    </section>
  ),
}));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({ title }: { title: string }) => <div role="dialog" aria-label={title} />,
}));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));

const CLUB = '00000000-0000-0000-0000-000000000003';
const SAVED_KEY = `diamond-spins-pending:player-a:${CLUB}:crossing`;
const state = {
  ok: true,
  available: true,
  frozen: false,
  reason: null,
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
/** A Super Donkey Cross award won on the wheel: 200 diamonds funded, 100 spun. */
const AWARD = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'crossing',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
type Game = 'crossing' | 'mines';
/** The server's read of that award, as WheelBonusEntryService.state returns it. */
const awardRead = (game: Game, doubled: boolean, overrides: Partial<typeof state> = {}) => ({
  enabled: true,
  award: { ...AWARD, game },
  gameState: { ...state, ...overrides },
  quote: {
    guarantee: 'super',
    minimumPayoutChips: doubled ? 1.5 : 1,
    mode: CHOICE_MODE[game],
    plinkoTable: 4,
  },
});
/** A freshly opened round of either game, from the local Postgres receipts. */
const opened = (game: Game) => ({
  ...fixtures.receipts[game],
  status: 'open',
  picked: [],
  proof: null,
  payout_chips: 0,
  award_id: AWARD.id,
});
const openRound = opened('crossing');
/** Every ticket the server deals in a test, in order: a distinct id and hash each. */
let dealt: Array<{ commit_id: string; server_seed_hash: string }> = [];
const dealTicket = async () => {
  const n = dealt.length + 1;
  const ticket = {
    commit_id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    server_seed_hash: n.toString(16).padStart(64, 'a'),
  };
  dealt.push(ticket);
  return { error: null, data: { ok: true, ...ticket } };
};
/** A wager the page saved before its answer was lost. */
const saved = {
  clubId: CLUB,
  game: 'crossing',
  mode: CHOICE_MODE.crossing,
  budget: {
    base: 200,
    doubled: false,
    denomination: 20,
    award: { id: AWARD.id, entryDiamonds: 100, boostMultiplier: 2 },
  },
  commitId: '00000000-0000-0000-0000-0000000000aa',
  serverSeedHash: 'f'.repeat(64),
  seed: 'saved-seed',
  maxSteps: 12,
};
/** The real service clears a saved wager once its receipt is valid. */
const settles = async (input: { game: Game }) => {
  sessionStorage.removeItem(`diamond-spins-pending:player-a:${CLUB}:${input.game}`);
  return opened(input.game);
};
const guardHolds = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)![0];
const noCheckControl = () => {
  expect(screen.queryByRole('button', { name: /Check/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Retry|Try Again/ })).toBeNull();
};
const statusLine = (text: string) =>
  screen.getAllByRole('status').some((line) => line.textContent === text);
/** Let every answered request land, without moving the clock. */
const settle = async () => {
  for (let i = 0; i < 5; i++)
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
  await settle();
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  dealt = [];
  sessionStorage.clear();
  backend.awardState
    .mockReset()
    .mockImplementation(async (_club, game: Game, doubled: boolean) => awardRead(game, doubled));
  backend.state.mockReset().mockResolvedValue(state);
  backend.start.mockReset().mockReturnValue(new Promise(() => {}));
  backend.act.mockReset();
  backend.rpc.mockReset().mockImplementation(dealTicket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a saved Donkey Cross wager settles itself', () => {
  it('replays the saved wager with no press, opens the round, and never offers a Check control', async () => {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    let answer!: (value: unknown) => void;
    backend.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    render(<DiamondChoicePage game="crossing" />);
    noCheckControl();
    await settle();
    // The exact saved request goes out on its own; nobody pressed anything.
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(saved, 'player-a');
    expect(screen.getByText('Settling')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
    noCheckControl();
    await act(async () => {
      sessionStorage.removeItem(SAVED_KEY);
      answer(openRound);
    });
    await settle();
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Scene open' })).toBeInTheDocument();
    expect(backend.start).toHaveBeenCalledTimes(1);
    noCheckControl();
    // The award it funded is spent: nothing counts down to a second round.
    await advance(30000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('replays the same saved request again after a dropped answer, on the backoff schedule', async () => {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    backend.start
      .mockRejectedValueOnce(new Error('The Network Dropped'))
      .mockImplementationOnce(settles);
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Settling Your Round')).toBeInTheDocument();
    noCheckControl();
    // An uncertain wager is never sent as a fresh one: the page waits a
    // second and replays the one it saved.
    await advance(999);
    expect(backend.start).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(backend.start.mock.calls[1][0]).toEqual(saved);
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
    noCheckControl();
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });
});

describe('a refused ticket is re-dealt and the wager goes again', () => {
  it('restarts a won game on a fresh ticket after a ticket-gone refusal, with no press at all', async () => {
    backend.start
      .mockRejectedValueOnce(
        new backend.BonusRefusal('That Ticket Expired. A New One Is Being Dealt', true)
      )
      .mockImplementationOnce(settles);
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(dealt).toHaveLength(1);
    await answerOffer();
    // The won game starts itself; the server refuses its ticket.
    await advance(5000);
    // A fresh ticket is dealt and the same wager is sent once more on it.
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(dealt).toHaveLength(2);
    const [first, second] = backend.start.mock.calls.map((call) => call[0]);
    expect(first).toMatchObject({
      commitId: dealt[0].commit_id,
      serverSeedHash: dealt[0].server_seed_hash,
    });
    expect(second).toMatchObject({
      commitId: dealt[1].commit_id,
      serverSeedHash: dealt[1].server_seed_hash,
    });
    // Only the ticket differs: the funding, the seed and the setting are the wager.
    expect({
      ...second,
      commitId: first.commitId,
      serverSeedHash: first.serverSeedHash,
    }).toEqual(first);
    expect(first.budget).toMatchObject({ base: 200, doubled: false, award: { id: AWARD.id } });
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
    noCheckControl();
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('restarts a pressed start the same way, once the fresh quote and ticket are in', async () => {
    backend.awardState.mockResolvedValue({ enabled: false, award: null, gameState: null });
    backend.start
      .mockRejectedValueOnce(
        new backend.BonusRefusal('That Ticket Is Not Yours Or Was Already Used', true)
      )
      .mockImplementationOnce(settles);
    render(<DiamondChoicePage game="mines" />);
    await settle();
    const quotes = backend.state.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await settle();
    // The refusal spent the entry quote, so the page read it again by itself
    // before sending the wager on the new ticket.
    expect(backend.state.mock.calls.length).toBeGreaterThan(quotes);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(backend.start.mock.calls[1][0].commitId).toBe(dealt[1].commit_id);
    expect(backend.start.mock.calls[1][0].seed).toBe(backend.start.mock.calls[0][0].seed);
    expect(screen.getByRole('button', { name: 'Choose A Tile' })).toBeInTheDocument();
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });
});

describe('a won game starts itself', () => {
  it('starts after five seconds, not before, and pressing is never required', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    await advance(4000);
    expect(screen.getByRole('button', { name: 'Starting In 1s' })).toBeEnabled();
    await advance(999);
    expect(backend.start).not.toHaveBeenCalled();
    await advance(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        clubId: CLUB,
        game: 'crossing',
        mode: CHOICE_MODE.crossing,
        commitId: dealt[0].commit_id,
        budget: expect.objectContaining({ base: 200, doubled: false }),
      }),
      'player-a'
    );
    // It fires once: the window never starts a second round.
    await advance(30000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('opens the five-second window again when the player doubles down', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    await advance(3000);
    expect(screen.getByRole('button', { name: 'Starting In 2s' })).toBeEnabled();
    // Reopening the offer stops the clock; the new answer is a new entry.
    fireEvent.click(screen.getByRole('button', { name: 'Double Down Your Bonus' }));
    await settle();
    await answerOffer('Add Diamonds');
    // The entry changed, so the window starts over from five seconds.
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    await advance(4999);
    expect(backend.start).not.toHaveBeenCalled();
    await advance(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start.mock.calls[0][0].budget).toMatchObject({ base: 200, doubled: true });
  });

  it('starts at once when the player presses Start inside the window', async () => {
    render(<DiamondChoicePage game="mines" />);
    await settle();
    await answerOffer();
    fireEvent.click(screen.getByRole('button', { name: 'Starting In 5s' }));
    expect(backend.start).toHaveBeenCalledTimes(1);
    await advance(30000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });
});

describe('the exit guard holds money in flight, not a won game that cannot start', () => {
  it('holds a won game this page can start', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(guardHolds()).toBe(true);
  });

  it.each([
    { reason: 'the maintenance break', game: { frozen: true } },
    { reason: 'the daily limit', game: { rounds_today: 500, daily_limit: 500 } },
  ])('lets the player leave a won game blocked by $reason', async ({ game }) => {
    backend.awardState.mockImplementation(async (_club, name: Game, doubled: boolean) =>
      awardRead(name, doubled, game)
    );
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(guardHolds()).toBe(false);
    // A game that cannot start does not count down, and nothing is sent.
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
    await advance(10000);
    expect(backend.start).not.toHaveBeenCalled();
    expect(guardHolds()).toBe(false);
  });

  it('lets the player leave while the ticket cannot be dealt, and holds once it is', async () => {
    backend.rpc.mockRejectedValueOnce(new Error('The Network Dropped'));
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(dealt).toHaveLength(0);
    expect(guardHolds()).toBe(false);
    await advance(1000);
    expect(dealt).toHaveLength(1);
    expect(guardHolds()).toBe(true);
  });

  it("frees a finished round's receipt to return to the wheel while the next award waits", async () => {
    const NEXT = '00000000-0000-0000-0000-000000000078';
    let pending = AWARD.id;
    backend.awardState.mockImplementation(async (_club, game: Game, doubled: boolean) => ({
      ...awardRead(game, doubled),
      award: { ...AWARD, id: pending, game },
    }));
    backend.start.mockImplementationOnce(async (input: { game: Game }) => {
      // The wheel also banked a second Donkey Cross; it is next once this is used.
      pending = NEXT;
      return opened(input.game);
    });
    backend.act.mockResolvedValue({ ...fixtures.receipts.crossing, award_id: AWARD.id });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    await advance(5000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    await settle();
    expect(screen.getByRole('dialog', { name: '1.10 Chips' })).toBeInTheDocument();
    // The receipt takes the player back to the wheel, which opens the next
    // award; holding the exit here would leave the receipt stuck on screen.
    expect(guardHolds()).toBe(false);
    // Nor does the next award start underneath the receipt.
    await advance(10000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('holds an open round, whatever the award says', async () => {
    backend.awardState.mockImplementation(async (_club, game: Game, doubled: boolean) =>
      awardRead(game, doubled, { frozen: true })
    );
    backend.state.mockResolvedValue({ ...state, open_round: openRound });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
    expect(guardHolds()).toBe(true);
  });
});

describe('nothing the page reads waits for a press', () => {
  it('deals a failed ticket again by itself and then enables Start', async () => {
    backend.awardState.mockResolvedValue({ enabled: false, award: null, gameState: null });
    backend.rpc
      .mockResolvedValueOnce({ error: new Error('The Network Dropped'), data: null })
      .mockRejectedValueOnce(new Error('The Network Dropped'));
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(statusLine('Preparing Your Ticket')).toBe(true);
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeDisabled();
    noCheckControl();
    // One second, then two: the backoff schedule, with no press.
    await advance(999);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    await advance(1999);
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(backend.rpc).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
    expect(statusLine('Preparing Your Ticket')).toBe(false);
    // Dealt: no more deals on a timer.
    await advance(60000);
    expect(backend.rpc).toHaveBeenCalledTimes(3);
  });

  it('stops dealing once a round is open', async () => {
    backend.awardState.mockResolvedValue({ enabled: false, award: null, gameState: null });
    backend.rpc.mockRejectedValue(new Error('The Network Dropped'));
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    // Another tab opened a round; the next read brings it here.
    backend.state.mockResolvedValue({ ...state, open_round: openRound });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
    await advance(60000);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
  });

  it('reads a game that could not be loaded again by itself, with backoff', async () => {
    backend.awardState.mockResolvedValue({ enabled: false, award: null, gameState: null });
    backend.state
      .mockRejectedValueOnce(new Error('The Network Dropped'))
      .mockRejectedValueOnce(new Error('The Network Dropped'))
      .mockResolvedValue(state);
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(backend.state).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Reconnecting To Your Game')).toBeInTheDocument();
    noCheckControl();
    await advance(999);
    expect(backend.state).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(backend.state).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Reconnecting To Your Game')).toBeInTheDocument();
    await advance(1999);
    expect(backend.state).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(backend.state).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Reconnecting To Your Game')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
    await advance(60000);
    expect(backend.state).toHaveBeenCalledTimes(3);
  });
});
