/**
 * AN ANSWERED ERROR NEVER LOOPS (review finding 2, 2026-09-22), on Plinko.
 *
 * Owner ruling, 2026-09-21: no game may require a player to check anything,
 * and no player may be trapped on a game page. The page kept every drop error
 * that was not a BonusRefusal as "uncertain": it held the saved wager, replayed
 * it every eight seconds for as long as the page stayed open, and the exit
 * guard held the player on it. An error carrying a SQLSTATE means the database
 * ran the drop and rolled it back: nothing was charged.
 *
 * The start door here is the real DiamondBonusService against a mocked
 * PostgREST rpc, so the rule the page acts on is the one that ships.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { BONUS_NOT_TAKEN, BONUS_SAVED } from '../../src/services/DiamondBonusService';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';

const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  rpc: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../src/services/DiamondGamesService', () => ({
  default: { getState: backend.getState, commit: backend.commit },
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
  useParams: () => ({ clubId: '00000000-0000-0000-0000-000000000003' }),
  useLocation: () => ({ search: '' }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/hooks/useMeasuredWidth', () => ({ useMeasuredWidth: () => [null, 320] }));
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({ title }: { title: string }) => <div role="dialog" aria-label={title} />,
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));

const CLUB = '00000000-0000-0000-0000-000000000003';
const SAVED_KEY = `diamond-spins-pending:player-a:${CLUB}:plinko`;
const AWARD_ID = '00000000-0000-0000-0000-000000000077';
/** The two boards production has open since 2026-09-21: Super (4) carries
 *  every half-the-stake floor, Super Double (6) the two thirds a Super award
 *  with the add-on paid. Diamond (5) is closed and is never offered. */
const TABLES = [
  {
    name: 'Super',
    version: 4,
    multipliers_cents: PLINKO_TABLES[4].multipliersCents,
    max_multiplier_cents: 2000,
  },
  {
    name: 'Super Double',
    version: 6,
    multipliers_cents: PLINKO_TABLES[6].multipliersCents,
    max_multiplier_cents: 2000,
  },
];
const state = {
  available: true,
  frozen: false,
  tables: TABLES,
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  config: { max_rounds_per_player_per_day: 500, diamonds_per_chip: 100 },
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
const won = () =>
  backend.awardState.mockResolvedValue({
    enabled: true,
    award,
    gameState: state,
    quote: { guarantee: 'super', minimumPayoutChips: 10, mode: null, plinkoTable: 4 },
  });
const START = new Set(['fn_wheel_bonus_start', 'fn_diamond_bonus_start']);
let startAnswer: () => unknown = () => new Promise(() => {});
const failure = (code: string) => ({
  data: null,
  error: { code, message: 'The database said no', details: '', hint: '' },
});
const starts = () => backend.rpc.mock.calls.filter(([fn]) => START.has(fn as string));
const holding = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)?.[0];
const statusLine = () =>
  screen.getAllByRole('status').find((node) => node.classList.contains('sc-copy'));
const noCheckControl = () => {
  expect(screen.queryByRole('button', { name: /Check/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Retry|Try Again/ })).toBeNull();
};
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
let savedNo = 0;
/** A wager an earlier visit saved, on a ticket no other test has sent. */
const saveWager = () => {
  const wager = {
    clubId: CLUB,
    game: 'plinko',
    budget: {
      base: 200,
      doubled: false,
      denomination: 20,
      award: { id: AWARD_ID, entryDiamonds: 100, boostMultiplier: 2 },
    },
    commitId: `00000000-0000-4000-8000-${String(0xe100 + ++savedNo).padStart(12, '0')}`,
    serverSeedHash: 'e'.repeat(64),
    seed: 'saved-seed',
    tableVersion: 4,
  };
  sessionStorage.setItem(SAVED_KEY, JSON.stringify(wager));
  return wager;
};
let ticketNo = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  backend.getState.mockReset().mockResolvedValue(DIRECT_STATE);
  backend.commit.mockReset().mockImplementation(async () => {
    const n = ++ticketNo;
    return {
      ok: true,
      commit_id: `00000000-0000-4000-8000-${String(0xf000 + n).padStart(12, '0')}`,
      server_seed_hash: n.toString(16).padStart(64, 'b'),
    };
  });
  won();
  startAnswer = () => new Promise(() => {});
  backend.rpc
    .mockReset()
    .mockImplementation(async (fn: string) =>
      START.has(fn) ? startAnswer() : { data: null, error: null }
    );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an error the database answered is an answer', () => {
  it('a pressed drop the database refused (23503) is let go: nothing saved, nothing resent, nothing held', async () => {
    direct();
    startAnswer = () => failure('23503');
    render(<DiamondPlinkoPage />);
    await advance();
    // Screen two (R6): the player chooses what each drop plays, then drops.
    fireEvent.click(screen.getByRole('button', { name: '10 Diamonds Per Drop, 10 Drops' }));
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    await advance();
    expect(starts()).toHaveLength(1);
    expect(starts()[0][0]).toBe('fn_diamond_bonus_start');
    expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
    expect(statusLine()).toHaveTextContent(BONUS_NOT_TAKEN);
    expect(holding()).toBe(false);
    noCheckControl();
    // A fresh ticket for the next drop; the refused one is never reused.
    expect(backend.commit).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(starts()).toHaveLength(1);
    expect(holding()).toBe(false);
  });

  it.each(['P0001', '42883', 'PGRST202'])(
    'a saved wager the database answers with %s is cleared after one send, and the player is let go',
    async (code) => {
      saveWager();
      startAnswer = () => failure(code);
      render(<DiamondPlinkoPage />);
      await advance();
      expect(starts()).toHaveLength(1);
      expect(starts()[0][0]).toBe('fn_wheel_bonus_start');
      expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
      expect(statusLine()).toHaveTextContent(BONUS_NOT_TAKEN);
      expect(holding()).toBe(false);
      noCheckControl();
      await advance(60_000);
      expect(starts()).toHaveLength(1);
    }
  );

  it.each(['40001', '57014', 'PGRST003'])(
    'a passing %s replays the same saved request, three sends in all, then lets it go',
    async (code) => {
      const wager = saveWager();
      startAnswer = () => failure(code);
      render(<DiamondPlinkoPage />);
      await advance();
      expect(starts()).toHaveLength(1);
      expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
      expect(holding()).toBe(true);
      expect(statusLine()).toHaveTextContent('Settling Your Bonus');
      await advance(1000);
      expect(starts()).toHaveLength(2);
      await advance(2000);
      expect(starts()).toHaveLength(3);
      expect(new Set(starts().map((call) => JSON.stringify(call))).size).toBe(1);
      expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
      expect(statusLine()).toHaveTextContent(BONUS_NOT_TAKEN);
      expect(holding()).toBe(false);
      noCheckControl();
      await advance(60_000);
      expect(starts()).toHaveLength(3);
    }
  );
});

describe('an answer this browser cannot verify', () => {
  it('stops after three, keeps the saved wager, lets the player go and reads the game again', async () => {
    const wager = saveWager();
    startAnswer = () => ({ data: { ok: true, game: 'plinko' }, error: null });
    render(<DiamondPlinkoPage />);
    await advance();
    expect(starts()).toHaveLength(1);
    expect(holding()).toBe(true);
    await advance(1000);
    expect(starts()).toHaveLength(2);
    const reads = backend.awardState.mock.calls.length;
    await advance(2000);
    expect(starts()).toHaveLength(3);
    await advance(120_000);
    expect(starts()).toHaveLength(3);
    expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
    expect(holding()).toBe(false);
    expect(backend.awardState.mock.calls.length).toBeGreaterThan(reads);
    expect(statusLine()).toHaveTextContent(BONUS_SAVED);
    expect(screen.queryByText('Settling')).toBeNull();
    // Nothing is dealt or dropped over it: the plate is still screen one's.
    expect(backend.commit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
    noCheckControl();
  });
});
