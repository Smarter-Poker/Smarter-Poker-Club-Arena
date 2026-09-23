/**
 * Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
 * ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY."
 *
 * Crash, end to end: a start whose answer never arrived is replayed by the page
 * itself; a ticket the server calls gone is re-dealt and the same wager sent
 * again; a won game starts itself after a five-second window; a won game that
 * cannot start never traps the player; and every read the page needs before
 * Start (the first load, the entry quote, the ticket) is tried again on its own
 * schedule. Nothing here is ever pressed to recover.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import DiamondCrashPage from '../../src/pages/DiamondCrashPage';
import { BonusRefusal } from '../../src/services/DiamondBonusService';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  crashHistory: vi.fn(),
  crashSettle: vi.fn(),
  start: vi.fn(),
  navigate: vi.fn(),
  awardState: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../src/services/DiamondGamesService', () => ({
  default: backend,
  normaliseCrash: (raw: unknown) => raw,
}));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: { start: backend.start },
  // The real refusal carries ticketGone; the page restarts only on that one.
  BonusRefusal: class extends Error {
    readonly ticketGone: boolean;
    constructor(message: string, ticketGone = false) {
      super(message);
      this.ticketGone = ticketGone;
    }
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
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('../../src/hooks/useMeasuredWidth', () => ({ useMeasuredWidth: () => [null, 320] }));
vi.mock('../../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: backend.refresh }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playSpinStart: vi.fn(), playSpinMultiplierResult: vi.fn() },
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    children,
    plates,
  }: {
    children?: ReactNode;
    plates?: {
      primary?: { label: string; disabled?: boolean; onClick?: () => void };
      secondary?: { label: string; disabled?: boolean; onClick?: () => void };
    };
  }) => (
    <section>
      {children}
      {plates?.secondary && (
        <button disabled={plates.secondary.disabled} onClick={plates.secondary.onClick}>
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => null }));
vi.mock('../../src/components/crash/CrashCurve', () => ({
  default: ({ onSettled }: { onSettled: () => void }) => (
    <button onClick={onSettled}>Finish Flight</button>
  ),
}));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({ title, onOpen }: { title: string; onOpen: () => void }) => (
    <div role="dialog" aria-label={title}>
      <button onClick={onOpen}>Finish Prize</button>
    </div>
  ),
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));

const CLUB = '00000000-0000-0000-0000-000000000003';
const TICKET_A = '00000000-0000-0000-0000-000000000009';
const TICKET_B = '00000000-0000-0000-0000-000000000010';
const settled = fixtures.receipts.crash;
const open = {
  ...settled,
  status: 'open',
  outcome: null,
  elapsed_ms: 8000,
  multiplier_now_cents: 257,
  fairness: {
    commit_id: settled.fairness.commit_id,
    client_seed: settled.fairness.client_seed,
    server_seed_hash: settled.fairness.server_seed_hash,
    nonce: settled.fairness.nonce,
  },
};
const state = {
  available: true,
  frozen: false,
  tables: [],
  open_round: null,
  config: {
    diamonds_per_chip: 100,
    max_multiplier_cents: 100000,
    growth_k: 0.12,
    max_rounds_per_player_per_day: 500,
    purchased_only: false,
  },
  bets: [{ bet_diamonds: 100, cap_cents: 100000, playable: true }],
  player: {
    is_member: true,
    diamonds: 10000,
    spendable: 10000,
    member_chips: 5,
    rounds_today: 1,
    diamonds_today: 100,
    seconds_until_next: 0,
  },
};
/** A Super Crash award from the wheel: a 100-diamond spin, doubled to a 200-diamond stake. */
const award = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'crash',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
const awardBudget = { id: award.id, entryDiamonds: 100, boostMultiplier: 2 };
/** The wheel has awarded Crash; `game` overrides what the award's game state says. */
function quoteSuperAward(game: Record<string, unknown> = {}) {
  backend.getState.mockResolvedValue({
    ...state,
    available: false,
    player: { ...state.player, spendable: 0, diamonds: 0 },
  });
  backend.awardState.mockImplementation((_club: string, _game: string, doubled: boolean) =>
    Promise.resolve({
      enabled: true,
      award,
      gameState: {
        ...state,
        player: { ...state.player, spendable: 100, diamonds: 100 },
        bets: [{ bet_diamonds: doubled ? 300 : 200, playable: true, cap_cents: 2000 }],
        ...game,
      },
      quote: {
        guarantee: 'super',
        minimumPayoutChips: doubled ? 1.5 : 1,
        mode: null,
        plinkoTable: 4,
      },
    })
  );
}
/** The console readout under the curve: the one status region that carries a printed label. */
const readout = () =>
  screen.getAllByRole('status').find((node) => node.querySelector('.sc-label'))!;
/** What the page last asked the exit guard: true holds the player on the page. */
const guardHolds = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)?.[0];
/** Answer the Double Down offer. A won game never starts over it: it spends
 * the player's own diamonds, so the countdown waits for the answer (or for the
 * offer to keep the bonus by itself). */
const answerOffer = async (name: 'Keep My Bonus' | 'Add Diamonds' = 'Keep My Bonus') => {
  const dialog = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
  fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!);
  fireEvent.click(screen.getByRole('button', { name }));
  await act(async () => {});
};
const elapse = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
/** A server answer that arrives when the test says, after the page has drawn the wait. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  backend.awardState
    .mockReset()
    .mockResolvedValue({ enabled: false, award: null, gameState: null });
  backend.getState.mockReset().mockResolvedValue(state);
  backend.crashSettle.mockReset().mockReturnValue(new Promise(() => {}));
  backend.start.mockReset();
  backend.commit.mockReset().mockResolvedValue({
    ok: true,
    commit_id: TICKET_A,
    server_seed_hash: 'a'.repeat(64),
  });
  backend.crashHistory.mockReset().mockResolvedValue([]);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a held start settles itself', () => {
  it('replays a start whose answer never arrived, with no press, and adopts the round', async () => {
    backend.start.mockRejectedValueOnce(new Error('Connection Lost')).mockResolvedValueOnce(open);
    render(<DiamondCrashPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    await act(async () => {});
    // The wager may be on the server: it is never offered again as a fresh one.
    expect(screen.getByRole('button', { name: 'Settling' })).toBeDisabled();
    expect(backend.start).toHaveBeenCalledTimes(1);
    await elapse(0);
    expect(backend.start).toHaveBeenCalledTimes(2);
    // The held request itself, not a new wager on a new ticket.
    expect(backend.start.mock.calls[1][0]).toEqual(backend.start.mock.calls[0][0]);
    expect(backend.commit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    expect(guardHolds()).toBe(true);
  });

  it('replays the wager an earlier visit saved as soon as the page loads, with no press', async () => {
    const saved = {
      clubId: CLUB,
      game: 'crash',
      budget: { base: 100, doubled: false, denomination: 10 },
      commitId: '00000000-0000-0000-0000-000000000008',
      serverSeedHash: 'c'.repeat(64),
      seed: 'saved-seed',
      autoCashoutCents: 200,
    };
    sessionStorage.setItem(`diamond-spins-pending:player-a:${CLUB}:crash`, JSON.stringify(saved));
    backend.start.mockResolvedValueOnce(open);
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Settling' })).toBeDisabled();
    await elapse(0);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(saved, 'player-a');
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
  });
});

describe('a ticket the server calls gone is dealt again', () => {
  it('re-deals the ticket and starts the same wager once more, with no press', async () => {
    quoteSuperAward();
    const refusal = deferred<never>();
    backend.commit
      .mockResolvedValueOnce({ ok: true, commit_id: TICKET_A, server_seed_hash: 'a'.repeat(64) })
      .mockResolvedValueOnce({ ok: true, commit_id: TICKET_B, server_seed_hash: 'b'.repeat(64) });
    backend.start.mockReturnValueOnce(refusal.promise).mockResolvedValueOnce(open);
    render(<DiamondCrashPage />);
    await act(async () => {});
    await answerOffer();
    // Nobody presses Start: the won game starts itself after its window...
    await elapse(5000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    // ...the server refuses its ticket, charging nothing, and the same wager
    // goes again on a fresh ticket.
    await act(async () => {
      refusal.reject(new BonusRefusal('That Game Ticket Is No Longer Valid', true));
    });
    await act(async () => {});
    expect(backend.toast.error).toHaveBeenCalledWith('That Game Ticket Is No Longer Valid');
    expect(backend.commit).toHaveBeenCalledTimes(2);
    expect(backend.start).toHaveBeenCalledTimes(2);
    const [first, second] = backend.start.mock.calls.map(([request]) => request);
    expect(first).toMatchObject({ commitId: TICKET_A, serverSeedHash: 'a'.repeat(64) });
    expect(second).toMatchObject({ commitId: TICKET_B, serverSeedHash: 'b'.repeat(64) });
    expect({ ...second, commitId: TICKET_A, serverSeedHash: 'a'.repeat(64) }).toEqual(first);
    expect(first.budget).toMatchObject({ base: 200, doubled: false, award: awardBudget });
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    // Exactly one extra start.
    await elapse(10000);
    expect(backend.start).toHaveBeenCalledTimes(2);
  });

  it('sends a wager again at most twice when every ticket is gone, then leaves Start ready', async () => {
    const tickets = [10, 11, 12, 13].map((n) => `00000000-0000-0000-0000-0000000000${n}`);
    for (const id of tickets)
      backend.commit.mockResolvedValueOnce({
        ok: true,
        commit_id: id,
        server_seed_hash: 'a'.repeat(64),
      });
    const answers = [deferred<never>(), deferred<never>(), deferred<never>()];
    for (const answer of answers) backend.start.mockReturnValueOnce(answer.promise);
    render(<DiamondCrashPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    for (const [index, answer] of answers.entries()) {
      expect(backend.start).toHaveBeenCalledTimes(index + 1);
      await act(async () => {
        answer.reject(new BonusRefusal('That Game Ticket Is No Longer Valid', true));
      });
      await act(async () => {});
    }
    // The press and its two restarts: the same wager each time, on a fresh ticket.
    const requests = backend.start.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.commitId)).toEqual(tickets.slice(0, 3));
    const wager = ({ commitId: _ticket, ...rest }: { commitId: string }) => rest;
    expect(wager(requests[1])).toEqual(wager(requests[0]));
    expect(wager(requests[2])).toEqual(wager(requests[0]));
    // The cap holds: the fourth ticket is dealt and left for the player's press.
    expect(backend.commit).toHaveBeenCalledTimes(4);
    await elapse(30000);
    expect(backend.start).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
  });
});

describe('a won game starts itself', () => {
  it('counts five seconds on the plate and then starts the award, not before', async () => {
    quoteSuperAward();
    backend.start.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    await answerOffer();
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    await elapse(4000);
    expect(screen.getByRole('button', { name: 'Starting In 1s' })).toBeEnabled();
    await elapse(999);
    expect(backend.start).not.toHaveBeenCalled();
    await elapse(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        commitId: TICKET_A,
        budget: expect.objectContaining({ base: 200, doubled: false, award: awardBudget }),
      }),
      'player-a'
    );
    expect(screen.getByRole('button', { name: 'Starting' })).toBeDisabled();
    // One window, one start: a start still waiting on its answer is not sent again.
    await elapse(30000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh window for a Double Down, and starts the doubled entry', async () => {
    quoteSuperAward();
    backend.start.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    await answerOffer();
    await elapse(3000);
    expect(screen.getByRole('button', { name: 'Starting In 2s' })).toBeEnabled();
    // Reopening the offer stops the clock; the new answer is a new entry.
    fireEvent.click(screen.getByRole('button', { name: 'Double Down Your Bonus' }));
    await act(async () => {});
    await answerOffer('Add Diamonds');
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    await elapse(4999);
    expect(backend.start).not.toHaveBeenCalled();
    await elapse(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({ base: 200, doubled: true, award: awardBudget }),
      }),
      'player-a'
    );
  });

  it('never counts down an ordinary entry', async () => {
    render(<DiamondCrashPage />);
    await act(async () => {});
    await elapse(30000);
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
  });
});

describe('the exit guard never traps a player on a won game that cannot start', () => {
  it.each([
    ['the day’s limit is reached', { player: { ...state.player, rounds_today: 500 } }, /Limit/],
    ['the platform is in its maintenance break', { frozen: true }, /Maintenance Break/],
    ['the game is closed', { available: false, reason: 'paused' }, /Crash Is Paused/],
  ])('lets the player leave when %s', async (_why, game, blocker) => {
    quoteSuperAward(game);
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(readout()).toHaveTextContent(blocker);
    expect(guardHolds()).toBe(false);
    // Nothing counts down and nothing starts: the award waits on the server.
    await elapse(10000);
    expect(backend.start).not.toHaveBeenCalled();
    expect(guardHolds()).toBe(false);
  });

  it('holds a won game that can start', async () => {
    quoteSuperAward();
    render(<DiamondCrashPage />);
    await act(async () => {});
    await answerOffer();
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    expect(guardHolds()).toBe(true);
  });

  it('always holds an open round', async () => {
    backend.getState.mockResolvedValue({ ...state, open_round: open });
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    expect(guardHolds()).toBe(true);
  });
});

describe('every read before Start is tried again by itself', () => {
  it('deals the ticket again on its backoff after failed deals, and stops once one is dealt', async () => {
    backend.commit
      .mockRejectedValueOnce(new Error('Connection Lost'))
      .mockRejectedValueOnce(new Error('Connection Lost Again'));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(backend.commit).toHaveBeenCalledTimes(1);
    expect(readout()).toHaveTextContent('Preparing Your Game');
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    // First retry after one second...
    await elapse(999);
    expect(backend.commit).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    // ...then after two more.
    await elapse(1999);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    await elapse(1);
    expect(backend.commit).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    await elapse(30000);
    expect(backend.commit).toHaveBeenCalledTimes(3);
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('loads again by itself after the first load fails, then shows the game', async () => {
    backend.getState.mockRejectedValueOnce(new Error('Offline'));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByText('Reconnecting To Crash')).toBeInTheDocument();
    // Nothing to press while it reconnects, and nothing holds the player.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(guardHolds()).toBe(false);
    await elapse(1000);
    await act(async () => {});
    expect(screen.queryByText('Reconnecting To Crash')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('quotes the entry again by itself when a quote fails', async () => {
    // The first load lands, but the entry quote after it fails: Start must not
    // sit on Checking Your Entry until somebody reloads the page.
    backend.getState.mockResolvedValueOnce(state).mockRejectedValueOnce(new Error('Offline'));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(backend.getState).toHaveBeenCalledTimes(2);
    expect(readout()).toHaveTextContent('Checking Your Entry');
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeDisabled();
    await elapse(999);
    expect(backend.getState).toHaveBeenCalledTimes(2);
    await elapse(1);
    expect(backend.getState).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    await elapse(30000);
    expect(backend.getState).toHaveBeenCalledTimes(3);
  });

  it('quotes the entry again when the read that ends a break fails, and the won game starts itself', async () => {
    // Review 2026-09-22: every read of the game clears the entry quote, but only
    // the quote's own effect used to try again after a failure. The standing
    // refresh that ends the hourly break is one of those reads: when its quote
    // hit a dropped connection, the won game sat on Checking Your Entry, with
    // nothing reading it again, until somebody reloaded the page.
    quoteSuperAward({ frozen: true });
    backend.getState.mockReset().mockResolvedValue(state);
    backend.start.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(readout()).toHaveTextContent('The Platform Is In Its Maintenance Break');
    await answerOffer();
    // The break ends: the standing refresh's award read says so, and its entry
    // quote is lost on the way.
    quoteSuperAward();
    backend.getState
      .mockReset()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(state);
    await elapse(15_000);
    expect(backend.getState).toHaveBeenCalledTimes(1);
    expect(readout()).toHaveTextContent('Checking Your Entry');
    expect(screen.queryByRole('button', { name: /Retry|Refresh/ })).not.toBeInTheDocument();
    // The page quotes again by itself, on the same schedule as every other read...
    await elapse(999);
    expect(backend.getState).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(backend.getState).toHaveBeenCalledTimes(2);
    // ...and the won game counts down and starts itself.
    expect(screen.getByRole('button', { name: 'Starting In 5s' })).toBeEnabled();
    await elapse(5000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({ base: 200, doubled: false, award: awardBudget }),
      }),
      'player-a'
    );
    // One quote was enough: nothing keeps reading once the entry is quoted.
    await elapse(30_000);
    expect(backend.getState).toHaveBeenCalledTimes(2);
  });
});

describe('a refused ticket re-sends the saved wager, never a rebuilt one', () => {
  it('keeps the saved auto cash-out when a reloaded wager goes again on a fresh ticket', async () => {
    // Review 2026-09-21: the restart used to rebuild the request from the page,
    // whose Auto was back to Off after the reload, so the round ran with no exit.
    const saved = {
      clubId: CLUB,
      game: 'crash',
      budget: { base: 100, doubled: false, denomination: 10 },
      commitId: '00000000-0000-0000-0000-000000000008',
      serverSeedHash: 'c'.repeat(64),
      seed: 'saved-seed',
      autoCashoutCents: 200,
    };
    sessionStorage.setItem(`diamond-spins-pending:player-a:${CLUB}:crash`, JSON.stringify(saved));
    backend.start
      .mockRejectedValueOnce(new BonusRefusal('That Game Ticket Is No Longer Valid', true))
      .mockResolvedValueOnce(open);
    render(<DiamondCrashPage />);
    await act(async () => {});
    await elapse(0);
    await act(async () => {});
    expect(backend.start).toHaveBeenCalledTimes(2);
    const [replay, restart] = backend.start.mock.calls.map(([request]) => request);
    expect(replay).toEqual(saved);
    expect(restart).toEqual({ ...saved, commitId: TICKET_A, serverSeedHash: 'a'.repeat(64) });
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
  });
});

describe('a refusal that is not about the ticket never traps the player', () => {
  it('reads the award again and lets the player leave, without retrying on a timer', async () => {
    quoteSuperAward();
    backend.start.mockRejectedValueOnce(
      new BonusRefusal('The Platform Is In Its Maintenance Break')
    );
    render(<DiamondCrashPage />);
    await act(async () => {});
    await answerOffer();
    const reads = backend.awardState.mock.calls.length;
    await elapse(5000);
    await act(async () => {});
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.awardState.mock.calls.length).toBeGreaterThan(reads);
    expect(guardHolds()).toBe(false);
    await elapse(60000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(guardHolds()).toBe(false);
  });
});
