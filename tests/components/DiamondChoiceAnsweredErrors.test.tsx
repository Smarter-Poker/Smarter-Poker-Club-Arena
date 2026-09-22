/**
 * AN ANSWERED ERROR NEVER LOOPS (review finding 2, 2026-09-22), on Donkey Cross.
 *
 * Owner ruling, 2026-09-21: no game may require a player to check anything,
 * and no player may be trapped on a game page. The page kept every start error
 * that was not a BonusRefusal as "uncertain": it held the saved wager, replayed
 * it every eight seconds for as long as the page stayed open, and the exit
 * guard held the player on it. That was the original incident without the
 * button. An error carrying a SQLSTATE means the database ran the start and
 * rolled it back: nothing was charged.
 *
 * The start door here is the real DiamondBonusService against a mocked
 * PostgREST rpc, so the rule the page acts on is the one that ships. Every
 * case runs on fake timers and steps them explicitly.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondChoicePage from '../../src/pages/DiamondChoicePage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import {
  BONUS_NOT_SAVED,
  BONUS_NOT_TAKEN,
  BONUS_SAVED,
} from '../../src/services/DiamondBonusService';
import { CHOICE_MODE } from '../../src/utils/diamondChoiceMath';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  act: vi.fn(),
  rpc: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../src/services/DiamondChoiceService', async (original) => ({
  ...(await original<typeof import('../../src/services/DiamondChoiceService')>()),
  DiamondChoiceService: { state: backend.state, act: backend.act },
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
  default: ({ phase }: { phase: string }) => <section aria-label={`Scene ${phase}`} />,
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
const awardRead = (doubled: boolean) => ({
  enabled: true,
  award: AWARD,
  gameState: state,
  quote: {
    guarantee: 'super',
    minimumPayoutChips: doubled ? 1.5 : 1,
    mode: CHOICE_MODE.crossing,
    plinkoTable: 4,
  },
});
/** A wager an earlier visit saved before its answer was lost. */
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
  // Unique to this file: the service counts answers per request.
  commitId: '00000000-0000-4000-8000-00000000c0aa',
  serverSeedHash: 'f'.repeat(64),
  seed: 'saved-seed',
  maxSteps: 12,
};
const START = new Set(['fn_wheel_bonus_start', 'fn_diamond_bonus_start']);
let ticketNo = 0;
/** What the start RPC answers; the ticket deal always answers a fresh ticket. */
let startAnswer: () => unknown = () => new Promise(() => {});
const failure = (code: string) => ({
  data: null,
  error: { code, message: 'The database said no', details: '', hint: '' },
});
const starts = () => backend.rpc.mock.calls.filter(([fn]) => START.has(fn as string));
const guardHolds = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)![0];
const noCheckControl = () => {
  expect(screen.queryByRole('button', { name: /Check/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Retry|Try Again/ })).toBeNull();
  expect(screen.queryByText(/Check Your|Try Again|Refresh To/)).toBeNull();
};
const settle = async () => {
  for (let i = 0; i < 5; i++)
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
const answerOffer = async () => {
  const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
  fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
  fireEvent.click(screen.getByRole('button', { name: 'Play Without' }));
  await settle();
};
/** Screen two: the player's own press. Nothing on this page starts a round (R1). */
const pressStart = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Start Round' }));
  await settle();
};
let hidden = false;
const setHidden = async (value: boolean) => {
  hidden = value;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await settle();
};
/** A request no other test has sent: the service counts answers per ticket. */
let savedNo = 0;
const saveWager = () => {
  const wager = {
    ...saved,
    commitId: `00000000-0000-4000-8000-${String(0xc100 + ++savedNo).padStart(12, '0')}`,
  };
  sessionStorage.setItem(SAVED_KEY, JSON.stringify(wager));
  return wager;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  backend.awardState
    .mockReset()
    .mockImplementation(async (_club, _game, doubled: boolean) => awardRead(doubled));
  backend.state.mockReset().mockResolvedValue(state);
  backend.act.mockReset();
  startAnswer = () => new Promise(() => {});
  backend.rpc.mockReset().mockImplementation(async (fn: string) => {
    if (fn === 'fn_diamond_game_commit') {
      const n = ++ticketNo;
      return {
        error: null,
        data: {
          ok: true,
          commit_id: `00000000-0000-4000-8000-${String(0xd000 + n).padStart(12, '0')}`,
          server_seed_hash: n.toString(16).padStart(64, 'a'),
        },
      };
    }
    if (START.has(fn)) return startAnswer();
    return { data: null, error: null };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('an error the database answered is an answer', () => {
  it('a won game the database refused (23503) is let go: nothing saved, nothing resent, nothing held', async () => {
    startAnswer = () => failure('23503');
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    // A won game this page can start holds the exit until it starts.
    expect(guardHolds()).toBe(true);
    await pressStart();
    expect(starts()).toHaveLength(1);
    expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
    expect(screen.getByText(BONUS_NOT_TAKEN)).toBeInTheDocument();
    expect(guardHolds()).toBe(false);
    noCheckControl();
    // However long the page stays open, the refused wager is never sent again.
    await advance(60_000);
    expect(starts()).toHaveLength(1);
    expect(guardHolds()).toBe(false);
  });

  it.each(['P0001', '23514', 'PGRST301'])(
    'a saved wager the database answers with %s is cleared after one send, and the player is let go',
    async (code) => {
      saveWager();
      startAnswer = () => failure(code);
      render(<DiamondChoicePage game="crossing" />);
      await settle();
      expect(starts()).toHaveLength(1);
      expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
      expect(screen.getByText(BONUS_NOT_TAKEN)).toBeInTheDocument();
      expect(screen.queryByText('Settling')).toBeNull();
      expect(guardHolds()).toBe(false);
      noCheckControl();
      await advance(60_000);
      expect(starts()).toHaveLength(1);
    }
  );

  it.each(['40001', '40P01', '55P03', '57014', 'PGRST002'])(
    'a passing %s replays the same saved request, three sends in all, then lets it go',
    async (code) => {
      const wager = saveWager();
      startAnswer = () => failure(code);
      render(<DiamondChoicePage game="crossing" />);
      await settle();
      expect(starts()).toHaveLength(1);
      // Kept and held while it may still be sent.
      expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
      expect(guardHolds()).toBe(true);
      await advance(1000);
      expect(starts()).toHaveLength(2);
      await advance(2000);
      expect(starts()).toHaveLength(3);
      expect(new Set(starts().map((call) => JSON.stringify(call))).size).toBe(1);
      expect(starts()[0][1]).toMatchObject({
        p_commit_id: wager.commitId,
        p_client_seed: 'saved-seed',
      });
      // The third such answer is a refusal: cleared, released, quiet.
      expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
      expect(screen.getByText(BONUS_NOT_TAKEN)).toBeInTheDocument();
      expect(guardHolds()).toBe(false);
      noCheckControl();
      await advance(60_000);
      expect(starts()).toHaveLength(3);
    }
  );
});

describe('a wager this browser could not save was never sent', () => {
  it('is a refusal: nothing is sent, nothing is replayed, and the player is let go', async () => {
    // Session storage that will not take a saved wager (a full or blocked store).
    const real = window.sessionStorage;
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        if (key.startsWith('diamond-spins-pending:')) throw new Error('QuotaExceededError');
        real.setItem(key, value);
      },
      removeItem: (key: string) => real.removeItem(key),
      clear: () => real.clear(),
      key: (index: number) => real.key(index),
      get length() {
        return real.length;
      },
    });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await answerOffer();
    await pressStart();
    // The press tried to start the won game; the wager could not be kept, so
    // it never left.
    expect(starts()).toHaveLength(0);
    expect(screen.getByText(BONUS_NOT_SAVED)).toBeInTheDocument();
    expect(screen.queryByText('Settling')).toBeNull();
    expect(guardHolds()).toBe(false);
    noCheckControl();
    await advance(60_000);
    expect(starts()).toHaveLength(0);
    expect(guardHolds()).toBe(false);
  });
});

describe('a lost answer is still replayed, but never from a background tab', () => {
  it('keeps replaying with backoff, holds nothing back while hidden, and resumes when visible', async () => {
    const wager = saveWager();
    startAnswer = () => ({
      data: null,
      error: { code: '', message: 'FetchError: Failed to fetch' },
    });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(starts()).toHaveLength(1);
    await advance(1000);
    expect(starts()).toHaveLength(2);
    await advance(2000);
    expect(starts()).toHaveLength(3);
    // The next replay is due four seconds on. The tab goes to the background
    // one second in: nothing is sent from it, however long it stays there.
    await advance(1000);
    await setHidden(true);
    await advance(120_000);
    expect(starts()).toHaveLength(3);
    // Money may be in flight, so the saved wager and the hold stay.
    expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
    expect(guardHolds()).toBe(true);
    // Back in front: the wait that fell due while hidden finishes at once.
    await setHidden(false);
    expect(starts()).toHaveLength(4);
    // And the schedule carries on from there: the next wait is eight seconds.
    await advance(7999);
    expect(starts()).toHaveLength(4);
    await advance(1);
    expect(starts()).toHaveLength(5);
    expect(new Set(starts().map((call) => JSON.stringify(call))).size).toBe(1);
    expect(screen.getByText('Settling Your Round')).toBeInTheDocument();
    noCheckControl();
  });
});

describe('an answer this browser cannot verify', () => {
  it('stops after three, keeps the saved wager, lets the player go and reads the game again', async () => {
    const wager = saveWager();
    startAnswer = () => ({ data: { ok: true }, error: null });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(starts()).toHaveLength(1);
    expect(guardHolds()).toBe(true);
    await advance(1000);
    expect(starts()).toHaveLength(2);
    const reads = backend.state.mock.calls.length;
    const awardReads = backend.awardState.mock.calls.length;
    await advance(2000);
    expect(starts()).toHaveLength(3);
    // Stopped: no fourth send, however long the page stays open.
    await advance(120_000);
    expect(starts()).toHaveLength(3);
    // Money may have moved, so the saved wager stays for the next visit...
    expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
    // ...nothing is in flight, so nothing holds the player...
    expect(guardHolds()).toBe(false);
    // ...the game is read again, and the status says the round is saved.
    expect(backend.state.mock.calls.length).toBeGreaterThan(reads);
    expect(backend.awardState.mock.calls.length).toBeGreaterThan(awardReads);
    expect(screen.getAllByRole('status').some((node) => node.textContent === BONUS_SAVED)).toBe(
      true
    );
    expect(screen.queryByText('Settling')).toBeNull();
    // No ticket is dealt over it, and no new round is started on top of it.
    expect(backend.rpc.mock.calls.filter(([fn]) => fn === 'fn_diamond_game_commit')).toHaveLength(
      0
    );
    // The plate is still screen one's, and disabled: a saved wager is not a
    // second round, and the offer cannot be answered over it either.
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
    noCheckControl();
  });

  it('the next visit sends the saved wager once more and stops again at once', async () => {
    saveWager();
    startAnswer = () => ({ data: { ok: true }, error: null });
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    await advance(1000);
    await advance(2000);
    expect(starts()).toHaveLength(3);
    cleanup();
    render(<DiamondChoicePage game="crossing" />);
    await settle();
    expect(starts()).toHaveLength(4);
    await advance(60_000);
    expect(starts()).toHaveLength(4);
    expect(guardHolds()).toBe(false);
    expect(sessionStorage.getItem(SAVED_KEY)).not.toBeNull();
  });
});
