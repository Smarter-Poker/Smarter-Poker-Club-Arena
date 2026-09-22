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
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn(() => () => {}) }));
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
vi.mock('../../src/services/DiamondChoiceService', async (original) => ({
  // The real module's other exports (the move refusal the page reads) stay.
  ...(await original<typeof import('../../src/services/DiamondChoiceService')>()),
  DiamondChoiceService: { state: backend.state, act: backend.act },
  parseChoiceRound: (value: unknown) => value,
}));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
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
const answerOffer = async (name: 'Play Without' | 'Add The Diamonds' = 'Play Without') => {
  const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
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
    // The plate is screen one's while the setup is disabled under the replay,
    // and disabled either way: no second round starts over a saved wager.
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
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
    // The award it funded is spent: nothing starts a second round.
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
    // The player presses Start; the server refuses its ticket.
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
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

  it('lets the player go once fresh tickets keep being refused, rather than hold a game that will not start', async () => {
    // Review 2026-09-22: after its re-sends the page dropped the owed wager
    // silently. The award stayed pending with its countdown spent, so nothing
    // started it, and the exit guard held the player on it.
    backend.start.mockRejectedValue(
      new backend.BonusRefusal('That Ticket Expired. A New One Is Being Dealt', true)
    );
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
    // The first send and its re-sends on fresh tickets, then no more.
    expect(backend.start).toHaveBeenCalledTimes(3);
    expect(new Set(backend.start.mock.calls.map((call) => call[0].commitId)).size).toBe(3);
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(3);
    // The page says why and lets go of the player; nothing asks them to retry.
    expect(screen.getByText('That Ticket Expired. A New One Is Being Dealt')).toBeInTheDocument();
    expect(guardHolds()).toBe(false);
    noCheckControl();
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

describe('a won game waits for the player, and starts on the entry they answered for', () => {
  it('waits on its plate however long, then starts exactly once when it is pressed', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    // R1: the offer is answered and nothing counts down behind the plate.
    expect(screen.getByRole('button', { name: 'Start Round' })).toBeEnabled();
    await advance(60000);
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await settle();
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
    // One press, one round.
    await advance(30000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('starts the doubled entry after the player changes their Double Down answer', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    // Reopening the offer takes the plate back until the new answer is given.
    fireEvent.click(screen.getByRole('button', { name: 'Playing Without Extra Diamonds: Change' }));
    await settle();
    // The offer is modal: it is the only thing the player can answer.
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    await answerOffer('Add The Diamonds');
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await settle();
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start.mock.calls[0][0].budget).toMatchObject({ base: 200, doubled: true });
  });
});

describe('the exit guard holds money in flight, not a won game that cannot start', () => {
  it('holds a won game this page can start, once its offer is answered', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    // Screen one decides nothing about money yet, and the award keeps until
    // the player comes back, so the offer alone never holds them (R9).
    expect(guardHolds()).toBe(false);
    await answerOffer();
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
    // A game that cannot start says so on its plate, and nothing is sent.
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
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
    // The ticket alone is not enough now: screen one is answered first (R9).
    expect(guardHolds()).toBe(false);
    await answerOffer();
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
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
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
    // Another tab opened a round. There is no Refresh to press: the page's
    // next read (here, the re-quote when the player changes the entry) brings it.
    backend.state.mockResolvedValue({ ...state, open_round: openRound });
    fireEvent.change(screen.getByLabelText('Entry Diamonds'), { target: { value: '150' } });
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

describe('a refused ticket re-sends the saved wager, never the one on screen', () => {
  it("re-sends the saved award's own Double Down on the fresh ticket, not the award the page now shows", async () => {
    // Review 2026-09-21: the restart used to rebuild the wager from the page,
    // so an older award's saved Double Down could be charged on a newer award
    // whose offer never appeared.
    const OLDER = '00000000-0000-0000-0000-0000000000a1';
    const olderWager = {
      ...saved,
      budget: {
        ...saved.budget,
        doubled: true,
        award: { id: OLDER, entryDiamonds: 100, boostMultiplier: 2 },
      },
    };
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(olderWager));
    backend.start
      .mockRejectedValueOnce(
        new backend.BonusRefusal('That Ticket Expired. A New One Is Being Dealt', true)
      )
      .mockImplementationOnce(settles);
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await advance(1000);
    expect(backend.start).toHaveBeenCalledTimes(2);
    const [replay, restart] = backend.start.mock.calls.map((call) => call[0]);
    expect(replay).toEqual(olderWager);
    expect(restart).toEqual({
      ...olderWager,
      commitId: dealt[0].commit_id,
      serverSeedHash: dealt[0].server_seed_hash,
    });
    // Nothing went out for the award on screen: its own offer was never answered.
    expect(
      backend.start.mock.calls.some(
        ([request]) => (request as typeof saved).budget.award.id === AWARD.id
      )
    ).toBe(false);
  });
});

describe('a refusal that is not about the ticket never traps the player', () => {
  it('reads the award again and lets the player go, without retrying on a timer', async () => {
    backend.start.mockRejectedValueOnce(
      new backend.BonusRefusal('The Platform Is In Its Maintenance Break')
    );
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    const reads = backend.awardState.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.awardState.mock.calls.length).toBeGreaterThan(reads);
    expect(guardHolds()).toBe(false);
    await advance(60000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(guardHolds()).toBe(false);
  });

  it('starts the won game by itself once the break that refused it is over', async () => {
    let frozen = false;
    backend.awardState.mockImplementation(async (_club, game: Game, doubled: boolean) =>
      awardRead(game, doubled, { frozen })
    );
    backend.start
      .mockImplementationOnce(async () => {
        frozen = true;
        throw new backend.BonusRefusal('The Platform Is In Its Maintenance Break');
      })
      .mockImplementationOnce(settles);
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(guardHolds()).toBe(false);
    // The break ends; the page's own standing re-read notices and the plate
    // comes back, for the player to press again (R1: it never presses itself).
    frozen = false;
    await advance(15000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
  });
});

describe('every ticket brings a fresh player seed', () => {
  it('draws a new seed for each ticket, after its hash is on screen, so no dealt seed can know it', async () => {
    // Fairness audit 2026-09-21: one seed per page mount meant a server could
    // deal the next ticket already knowing the player's seed.
    backend.start.mockRejectedValueOnce(new backend.BonusRefusal('This Award Was Already Used'));
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    const seedField = () => (screen.getByLabelText('Your Seed') as HTMLInputElement).value;
    expect(dealt).toHaveLength(1);
    const first = seedField();
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
    await advance(0);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start.mock.calls[0][0].seed).toBe(first);
    // The refused ticket is spent; the next one arrives with its own seed.
    await advance(1000);
    expect(dealt).toHaveLength(2);
    expect(seedField()).toMatch(/^[a-f0-9]{32}$/);
    expect(seedField()).not.toBe(first);
  });
});
