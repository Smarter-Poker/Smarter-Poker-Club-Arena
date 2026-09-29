/**
 * AN ANSWERED ERROR NEVER LOOPS (review findings 2 and 4, 2026-09-22), on Crash.
 *
 * Owner ruling, 2026-09-21: no game may require a player to check anything,
 * and no player may be trapped on a game page. The page kept every start error
 * that was not a BonusRefusal as "uncertain": it held the saved wager, replayed
 * it every eight seconds for as long as the page stayed open, and the exit
 * guard held the player on it. An error carrying a SQLSTATE means the database
 * ran the start and rolled it back: nothing was charged. And a saved wager was
 * replayed behind the load-error screen, where the exit guard is off.
 *
 * The start door here is the real DiamondBonusService against a mocked
 * PostgREST rpc, so the rule the page acts on is the one that ships.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import DiamondCrashPage from '../../src/pages/DiamondCrashPage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { BONUS_NOT_TAKEN, BONUS_SAVED } from '../../src/services/DiamondBonusService';

const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  crashHistory: vi.fn(),
  crashSettle: vi.fn(),
  rpc: vi.fn(),
  navigate: vi.fn(),
  awardState: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../src/services/DiamondGamesService', () => ({
  default: {
    getState: backend.getState,
    commit: backend.commit,
    crashHistory: backend.crashHistory,
    crashSettle: backend.crashSettle,
  },
  normaliseCrash: (raw: unknown) => raw,
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
vi.mock('../../src/components/crash/CrashCurve', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({ title }: { title: string }) => <div role="dialog" aria-label={title} />,
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));

const CLUB = '00000000-0000-0000-0000-000000000003';
const SAVED_KEY = `diamond-spins-pending:player-a:${CLUB}:crash`;
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
const START = new Set(['fn_wheel_bonus_start', 'fn_diamond_bonus_start']);
let startAnswer: () => unknown = () => new Promise(() => {});
const failure = (code: string) => ({
  data: null,
  error: { code, message: 'The database said no', details: '', hint: '' },
});
const starts = () => backend.rpc.mock.calls.filter(([fn]) => START.has(fn as string));
const guardHolds = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)?.[0];
const readout = () =>
  screen.getAllByRole('status').find((node) => node.querySelector('.sc-label'))!;
const noCheckControl = () => {
  expect(screen.queryByRole('button', { name: /Check/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Retry|Try Again/ })).toBeNull();
};
const elapse = async (ms: number) => {
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
    game: 'crash',
    budget: { base: 100, doubled: false, denomination: 10 },
    commitId: `00000000-0000-4000-8000-${String(0xa100 + ++savedNo).padStart(12, '0')}`,
    serverSeedHash: 'c'.repeat(64),
    seed: 'saved-seed',
    autoCashoutCents: 200,
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
  backend.awardState
    .mockReset()
    .mockResolvedValue({ enabled: false, award: null, gameState: null });
  backend.getState.mockReset().mockResolvedValue(state);
  backend.crashSettle.mockReset().mockReturnValue(new Promise(() => {}));
  backend.crashHistory.mockReset().mockResolvedValue([]);
  backend.commit.mockReset().mockImplementation(async () => {
    const n = ++ticketNo;
    return {
      ok: true,
      commit_id: `00000000-0000-4000-8000-${String(0xb000 + n).padStart(12, '0')}`,
      server_seed_hash: 'a'.repeat(64),
    };
  });
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
  it('a pressed start the database refused (23503) is let go: nothing saved, nothing resent, nothing held', async () => {
    startAnswer = () => failure('23503');
    render(<DiamondCrashPage />);
    await elapse(0);
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    await elapse(0);
    expect(starts()).toHaveLength(1);
    expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
    expect(backend.toast.error).toHaveBeenCalledWith(BONUS_NOT_TAKEN);
    expect(guardHolds()).toBe(false);
    // A fresh ticket for the next round; the refused one is never reused.
    expect(backend.commit).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    noCheckControl();
    await elapse(60_000);
    expect(starts()).toHaveLength(1);
  });

  it.each(['P0001', '23514', 'PGRST301'])(
    'a saved wager the database answers with %s is cleared after one send, and the player is let go',
    async (code) => {
      saveWager();
      startAnswer = () => failure(code);
      render(<DiamondCrashPage />);
      await elapse(0);
      expect(starts()).toHaveLength(1);
      expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
      expect(backend.toast.error).toHaveBeenCalledWith(BONUS_NOT_TAKEN);
      expect(guardHolds()).toBe(false);
      expect(screen.queryByRole('button', { name: 'Settling' })).toBeNull();
      noCheckControl();
      await elapse(60_000);
      expect(starts()).toHaveLength(1);
    }
  );

  it.each(['40001', '40P01', 'PGRST000'])(
    'a passing %s replays the same saved request, three sends in all, then lets it go',
    async (code) => {
      const wager = saveWager();
      startAnswer = () => failure(code);
      render(<DiamondCrashPage />);
      await elapse(0);
      expect(starts()).toHaveLength(1);
      expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
      expect(guardHolds()).toBe(true);
      expect(screen.getByRole('button', { name: 'Settling' })).toBeDisabled();
      await elapse(1000);
      expect(starts()).toHaveLength(2);
      await elapse(2000);
      expect(starts()).toHaveLength(3);
      expect(new Set(starts().map((call) => JSON.stringify(call))).size).toBe(1);
      expect(starts()[0][1]).toMatchObject({
        p_commit_id: wager.commitId,
        p_auto_cashout_cents: 200,
      });
      expect(sessionStorage.getItem(SAVED_KEY)).toBeNull();
      expect(backend.toast.error).toHaveBeenCalledWith(BONUS_NOT_TAKEN);
      expect(guardHolds()).toBe(false);
      noCheckControl();
      await elapse(60_000);
      expect(starts()).toHaveLength(3);
    }
  );
});

describe('an answer this browser cannot verify', () => {
  it('stops after three, keeps the saved wager, lets the player go and reads the game again', async () => {
    const wager = saveWager();
    startAnswer = () => ({ data: { ok: true, game: 'crash' }, error: null });
    render(<DiamondCrashPage />);
    await elapse(0);
    expect(starts()).toHaveLength(1);
    expect(guardHolds()).toBe(true);
    await elapse(1000);
    expect(starts()).toHaveLength(2);
    const reads = backend.getState.mock.calls.length;
    await elapse(2000);
    expect(starts()).toHaveLength(3);
    await elapse(120_000);
    expect(starts()).toHaveLength(3);
    expect(JSON.parse(sessionStorage.getItem(SAVED_KEY)!)).toEqual(wager);
    expect(guardHolds()).toBe(false);
    expect(backend.getState.mock.calls.length).toBeGreaterThan(reads);
    expect(backend.toast.info).toHaveBeenCalledWith(BONUS_SAVED);
    expect(readout()).toHaveTextContent(BONUS_SAVED);
    expect(screen.getByRole('button', { name: 'Round Saved' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Settling' })).toBeNull();
    noCheckControl();
  });
});

describe('nothing is replayed behind the load-error screen (review finding 4)', () => {
  it('holds a saved wager while the game cannot load, and replays it once the game is on screen', async () => {
    const wager = saveWager();
    backend.getState.mockRejectedValueOnce(new Error('Offline'));
    render(<DiamondCrashPage />);
    await elapse(0);
    expect(screen.getByText('Reconnecting To Crash')).toBeInTheDocument();
    // The guard is off here, so nothing may be in flight behind this screen.
    expect(guardHolds()).toBe(false);
    expect(starts()).toHaveLength(0);
    await elapse(999);
    expect(starts()).toHaveLength(0);
    // The load retries itself after a second; once the game is on screen the
    // saved wager goes, as it was saved, and the guard holds it.
    await elapse(1);
    expect(screen.queryByText('Reconnecting To Crash')).toBeNull();
    expect(starts()).toHaveLength(1);
    expect(starts()[0][1]).toMatchObject({
      p_commit_id: wager.commitId,
      p_client_seed: 'saved-seed',
    });
    expect(screen.getByRole('button', { name: 'Settling' })).toBeDisabled();
    expect(guardHolds()).toBe(true);
  });

  it('never replays while every load fails', async () => {
    saveWager();
    backend.getState.mockRejectedValue(new Error('Offline'));
    render(<DiamondCrashPage />);
    for (const wait of [0, 1000, 2000, 4000, 8000, 8000]) await elapse(wait);
    expect(backend.getState.mock.calls.length).toBeGreaterThan(4);
    expect(starts()).toHaveLength(0);
    expect(guardHolds()).toBe(false);
    expect(sessionStorage.getItem(SAVED_KEY)).not.toBeNull();
  });
});
