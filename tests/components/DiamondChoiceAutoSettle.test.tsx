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
  default: ({
    phase,
    paused,
    onSettled,
    onMoment,
  }: {
    phase: string;
    paused?: boolean;
    onSettled: () => void;
    onMoment?: (moment: string, street: number) => void;
  }) => (
    <section aria-label={`Scene ${phase}`} data-paused={String(paused)}>
      <button onClick={onSettled}>Finish Scene</button>
      {/* The beat the real scene reaches when the car gets to the donkey. */}
      <button onClick={() => onMoment?.('hit', 2)}>Present</button>
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
/** Everything the page's one polite live region is saying. */
const spoken = () => Array.from(document.querySelectorAll('[aria-live] p'));
const statusLine = (text: string) => spoken().some((line) => line.textContent === text);
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

  /**
   * THE CONSOLE NEVER OUTRUNS THE SCENE (review 2026-09-22). fn_choice_act
   * answers while the donkey is still in the road, and the pill, the bays and
   * the page readout used to print the outcome about three quarters of a
   * second before the car reached it.
   */
  it('keeps the console on the crossing until the scene presents the result', async () => {
    backend.start.mockImplementationOnce(async (input: { game: Game }) => ({
      ...opened(input.game),
      picked: [0],
    }));
    backend.act.mockResolvedValue({
      ...fixtures.receipts.crossing,
      status: 'lost',
      picked: [0, 1],
      payout_chips: 0.1,
      award_id: AWARD.id,
    });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    await advance(5000);
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    // The server has answered. Nothing on the console says so yet.
    expect(screen.getByText('In Play')).toBeInTheDocument();
    expect(screen.queryByText('Round Over')).toBeNull();
    expect(screen.queryByText(/The Donkey Did Not Make/)).toBeNull();
    expect(screen.getByText('Current Prize').nextElementSibling).toHaveTextContent('1.10');
    expect(screen.getByText('Street').nextElementSibling).toHaveTextContent('1');
    // The scene reaches the moment of impact: now the console prints it.
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(screen.getByText('Round Over')).toBeInTheDocument();
    expect(screen.getByText(/The Donkey Did Not Make/)).toBeInTheDocument();
    expect(screen.getByText('Current Prize').nextElementSibling).toHaveTextContent('0.10');
    expect(screen.getByText('Street').nextElementSibling).toHaveTextContent('2');
    // The receipt still waits for the scene's own terminal frame.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    await settle();
    expect(screen.getByRole('dialog', { name: '0.10 Chips' })).toBeInTheDocument();
  });

  /**
   * ONE ANNOUNCEMENT PER STREET. The page's readout carried two nested status
   * paragraphs inside its own live region, and the scene added two more, so a
   * hit was announced three or four times before the car moved, and a safe
   * street announced a new cash-out value without saying which street had been
   * crossed.
   */
  it('speaks each street once, in one region, when the scene presents it', async () => {
    backend.start.mockImplementationOnce(async (input: { game: Game }) => ({
      ...opened(input.game),
      picked: [0],
    }));
    backend.act.mockResolvedValue({
      ...fixtures.receipts.crossing,
      status: 'lost',
      picked: [0, 1],
      payout_chips: 0.1,
      award_id: AWARD.id,
    });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    await advance(5000);
    // One region for the whole console (the scene, mocked here, adds none),
    // read as a whole, with nothing nested inside it claiming its own turn.
    const regions = () => Array.from(document.querySelectorAll('[aria-live]'));
    expect(regions()).toHaveLength(1);
    expect(regions()[0]).toHaveAttribute('aria-atomic', 'true');
    expect(regions()[0].querySelectorAll('[role="status"]')).toHaveLength(0);
    const said = () => regions()[0].textContent ?? '';
    expect(said()).toContain('Street 1 Crossed. Book 1.10 Chips Now Or Cross For 1.35.');
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    // The server has answered. The region has not changed what it says.
    expect(said()).toContain('Street 1 Crossed. Book 1.10 Chips Now Or Cross For 1.35.');
    expect(said()).not.toContain('The Donkey Did Not Make');
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(said()).not.toContain('Street 1 Crossed');
    expect(said()).toContain('The Donkey Did Not Make This Crossing.');
  });

  /**
   * WHAT THE SCENE IS FOR. Nothing is looking at the road behind the Double
   * Down offer or under the receipt, and 60 frames a second of traffic there
   * is heat and battery for nobody. Pausing on offerOpen alone would be worse
   * than not pausing at all: it starts true and stays true whenever BonusSetup
   * is not mounted, which is exactly a resumed open round, and that round's
   * reveal would never draw and never settle.
   */
  it('pauses the road behind the Double Down offer, and lets it go on the answer', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(screen.getByRole('region', { name: 'Scene idle' })).toHaveAttribute(
      'data-paused',
      'true'
    );
    await answerOffer();
    expect(screen.getByRole('region', { name: 'Scene idle' })).toHaveAttribute(
      'data-paused',
      'false'
    );
  });

  it('never pauses a resumed open round, whose offer was never answered', async () => {
    // The saved round is read back once; the read after the move no longer
    // carries it, exactly as the server answers a round that has just ended.
    backend.state.mockResolvedValueOnce({ ...state, open_round: { ...openRound, picked: [0] } });
    backend.act.mockResolvedValue({
      ...fixtures.receipts.crossing,
      status: 'lost',
      picked: [0, 1],
      payout_chips: 0.1,
      award_id: AWARD.id,
    });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(screen.getByRole('region', { name: 'Scene open' })).toHaveAttribute(
      'data-paused',
      'false'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    await settle();
    expect(screen.getByRole('dialog', { name: '0.10 Chips' })).toBeInTheDocument();
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
    await advance(5000);
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
    await advance(5000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(guardHolds()).toBe(false);
    // The break ends; the page's own standing re-read notices, and the
    // countdown runs again with nobody pressing anything.
    frozen = false;
    await advance(15000);
    await advance(6000);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
  });
});

/**
 * EACH STREET SETTLES ON ITS OWN ANSWER (review 2026-09-22). fn_choice_act
 * already answers with the whole round, and the page read the entire game back
 * after every move: a second round trip whose largest part is a twenty-receipt
 * history query, before the plates came back on a phone network. Worse, that
 * background read shared the move's own catch, so losing it looked exactly
 * like an unconfirmed money move, withheld the receipt and held the player on
 * the page. The money safety below it is unchanged: a move the server never
 * answered is still read back before anything is printed.
 */
describe('each street settles on its own answer', () => {
  const street = (picked: number[]) => ({ ...opened('crossing'), picked });
  const hit = {
    ...fixtures.receipts.crossing,
    status: 'lost',
    picked: [0, 1],
    payout_chips: 0.1,
    award_id: AWARD.id,
  };
  /** A crossing already standing on street 1, so the next press is a street. */
  const inPlay = async () => {
    backend.start.mockImplementationOnce(async () => street([0]));
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    await advance(5000);
    return backend.state.mock.calls.length;
  };

  it('never reads the whole game again for an open street, and the next press carries it', async () => {
    backend.act.mockResolvedValueOnce(street([0, 1])).mockResolvedValueOnce(street([0, 1, 2]));
    const reads = await inPlay();
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    // One round trip for the street: the move answered, and nothing read the
    // game back to learn what the answer already said.
    expect(backend.act).toHaveBeenCalledTimes(1);
    expect(backend.state.mock.calls.length).toBe(reads);
    // The controls still belong to the scene until it presents the street.
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    expect(backend.act).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    expect(backend.act).toHaveBeenCalledTimes(2);
    // The second move is the next street, not a replay of the first.
    expect(backend.act.mock.calls[1][2]).toBe(2);
    expect(backend.state.mock.calls.length).toBe(reads);
  });

  it('still confirms a move the server never answered by reading the round back', async () => {
    backend.act.mockRejectedValueOnce(new Error('The Network Dropped'));
    const reads = await inPlay();
    // The confirming read is held open, so what the player sees during it is
    // observable here rather than gone by the next microtask.
    let confirm!: (value: unknown) => void;
    backend.state.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    // Money may have moved: nothing is printed, the exit is held, the receipt
    // is withheld, and the page is already reading the confirmed round back.
    expect(screen.getByText('Confirming Your Move')).toBeInTheDocument();
    expect(guardHolds()).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(backend.state.mock.calls.length).toBe(reads + 1);
    noCheckControl();
    await act(async () => {
      confirm({ ...state, history: [hit] });
    });
    await settle();
    expect(screen.queryByText('Confirming Your Move')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    await settle();
    expect(screen.getByRole('dialog', { name: '0.10 Chips' })).toBeInTheDocument();
  });

  it('shows a finished round even when the read that follows it fails', async () => {
    backend.act.mockResolvedValue(hit);
    const reads = await inPlay();
    // The read that follows the move fails, and every read after it is left in
    // flight: only the move's own answer can print this round.
    backend.state
      .mockRejectedValueOnce(new Error('The Network Dropped'))
      .mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Cross Street' }));
    await settle();
    // The move was answered. A lost background read is not an unconfirmed move.
    expect(screen.queryByText('Confirming Your Move')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(screen.getByText('Round Over')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Scene' }));
    await settle();
    expect(screen.getByRole('dialog', { name: '0.10 Chips' })).toBeInTheDocument();
    expect(backend.state.mock.calls.length).toBe(reads + 1);
    // The read that failed is tried again by the page itself.
    await advance(1000);
    expect(backend.state.mock.calls.length).toBe(reads + 2);
    noCheckControl();
  });
});

/**
 * A BLANK SEED IS NOT A REFUSAL (review 2026-09-22). "Your Seed" is a free text
 * field inside Round Proof. Emptying it used to break two owner rules at once:
 * the auto-start required seed.trim() !== '', so a won game never started
 * itself and showed no countdown, while useLiveBonusGuard still held every
 * exit for the award; and pressing Start made DiamondBonusService throw
 * BonusRefusal('Enter A Seed With 1 To 64 Characters') before anything was
 * sent, which start()'s catch treats exactly like a refusal from the server -
 * the ticket dropped and the countdown off until the server's reasons change.
 */
describe('a blank seed never stalls a won game', () => {
  const seedField = () => screen.getByLabelText('Your Seed') as HTMLInputElement;
  /** The service's own pre-send check, which a blank seed used to trip. */
  const checksTheSeed = async (input: typeof saved) => {
    if (!input.seed.trim().length || input.seed.length > 64)
      throw new backend.BonusRefusal('Enter A Seed With 1 To 64 Characters');
    return settles(input);
  };

  it('counts the won game down with the field cleared, and sends a seed of its own', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    fireEvent.change(seedField(), { target: { value: '' } });
    // Typing restarts the five seconds; clearing the field is still typing.
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    expect(guardHolds()).toBe(true);
    await advance(5000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    const sent = backend.start.mock.calls[0][0].seed;
    expect(sent).toMatch(/^[0-9a-f]{32}$/);
    // The proof shows the seed the round was actually sent with.
    expect(seedField().value).toBe(sent);
  });

  it('starts a pressed round on a fresh seed instead of being refused for it', async () => {
    backend.start.mockImplementationOnce(checksTheSeed);
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    fireEvent.change(seedField(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Starting In/ }));
    await settle();
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start.mock.calls[0][0].seed).toMatch(/^[0-9a-f]{32}$/);
    // The ticket in hand is the one it was sent on: nothing was dropped.
    expect(backend.start.mock.calls[0][0].commitId).toBe(dealt[0].commit_id);
    expect(screen.getByRole('button', { name: 'Cross Street' })).toBeInTheDocument();
    expect(guardHolds()).toBe(true);
    noCheckControl();
  });

  it('refills the field when the player leaves it empty', async () => {
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    const dealtSeed = seedField().value;
    fireEvent.change(seedField(), { target: { value: '  ' } });
    expect(seedField().value).toBe('  ');
    fireEvent.blur(seedField());
    expect(seedField().value).toMatch(/^[0-9a-f]{32}$/);
    expect(seedField().value).not.toBe(dealtSeed);
    // A seed the player did write is left exactly as they wrote it.
    fireEvent.change(seedField(), { target: { value: 'lucky donkey' } });
    fireEvent.blur(seedField());
    expect(seedField().value).toBe('lucky donkey');
  });
});
