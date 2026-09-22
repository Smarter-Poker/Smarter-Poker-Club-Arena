/**
 * THE WHEEL NEVER SPINS TWICE UNATTENDED (2026-09-22).
 *
 * Owner ruling 2026-09-21: games auto start and play. Live on the same day an
 * open tab with nobody at it looped: the idle countdown spun, a won game
 * played itself and came back, and the wheel armed its countdown again on the
 * new mount, 100 diamonds a lap until the daily cap. An automatic spin now
 * never follows an automatic spin with no player input in between; the Spin
 * button and the Auto Spin run the player starts are never held.
 *
 * Every clock is fake from the first render (the countdown reads
 * performance.now), and fireEvent.click dispatches no pointerdown, so a click
 * here is a press that is NOT also a presence signal unless the test says so.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  spin: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/DiamondWheelService')>()),
  default: {
    getStateV2: backend.state,
    commit: backend.commit,
    spinV2: backend.spin,
    welcomeState: async () => ({ available: false, enabled: false }),
    dailyBonusState: async () => ({ available: false, ticket_count: 0 }),
    history: async () => [],
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'player' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: 'club' }),
  useNavigate: () => backend.navigate,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => 'd1000000-0000-4000-8000-000000000003',
}));
vi.mock('../../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: backend.refresh }),
}));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/DiamondWheel', () => ({
  default: ({ onLanded, spinning }: any) => (
    <button disabled={!spinning} onClick={onLanded}>
      Land Wheel
    </button>
  ),
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
import DiamondWheelPage from '../../src/pages/DiamondWheelPage';

const chips = receipts.find((r) => r.kind === 'wheel' && r.value.outcome?.kind === 'chips')!.value;
/** A won game: its reveal opens by itself and the page navigates to the game. */
const game = receipts.find(
  (r) =>
    r.kind === 'wheel' && r.value.outcome?.kind === 'bonus' && r.value.entry_value_diamonds === 100
)!.value;
const sample = chips;
const state = {
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: sample.segments,
  pending_awards: [],
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
  player: {
    diamonds: 10000,
    spendable: 10000,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
};
let ticket = 0;
const nextTicket = () => ({
  ok: true,
  commit_id: `d1000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
  server_seed_hash: 'a'.repeat(64),
});
let prize: typeof chips | typeof game = game;
const receipt = (attempt: any) => ({
  ...prize,
  entry_value_diamonds: attempt.entryDiamonds,
  player_cost_diamonds: attempt.entryDiamonds,
  fairness: {
    ...prize.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  },
});
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** The wheel opens: a first visit, or the return from a won game. */
const open = async () => {
  render(<DiamondWheelPage />);
  await tick(0);
  expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
};
/** The won game plays itself and brings the player back: a new mount. */
const comeBack = async () => {
  cleanup();
  await open();
};
/** The wheel lands and its reveal plays out. A won game's reveal opens the game
 * by itself; a chips prize inside a run continues by itself. */
const land = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
  await act(async () =>
    fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!)
  );
  await tick(0);
};
const wonGames = () => backend.navigate.mock.calls.filter(([to]) => /wheelAward=/.test(to));
const countdown = () => screen.getByRole('button', { name: 'Hold Automatic Spin' });
/** Wait out the idle window and let its spin land. */
const idleSpin = async () => {
  await tick(30_000);
  await land();
};

beforeEach(() => {
  ticket = 0;
  prize = game;
  vi.useFakeTimers();
  backend.state.mockResolvedValue(state);
  backend.commit.mockImplementation(async () => nextTicket());
  backend.spin.mockImplementation(async (attempt) => receipt(attempt));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('the wheel never spins twice unattended', () => {
  it('the idle countdown spins once, and the next visit waits for a real input', async () => {
    await open();
    expect(countdown()).toHaveTextContent('Hold 30s');
    await tick(29_999);
    expect(backend.spin).not.toHaveBeenCalled();
    await tick(1);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await land();
    // The won game opened by itself: won games still start and play.
    expect(wonGames()).toHaveLength(1);
    await comeBack();
    // Nobody has touched the page since that spin: the countdown does not run.
    await tick(120_000);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(countdown()).toHaveTextContent('Hold 30s');
    // A real input says somebody is there, and the idle window runs again.
    fireEvent.pointerDown(document.body);
    await tick(29_999);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(backend.spin).toHaveBeenCalledTimes(2);
    // ...once. That spin was automatic too, so the visit after it waits again.
    await land();
    await comeBack();
    await tick(120_000);
    expect(backend.spin).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a key', () => fireEvent.keyDown(document.body, { key: 'Tab' })],
    ['a touch', () => fireEvent.touchStart(document.body)],
  ])('%s is a real input as well', async (_what, touch) => {
    await open();
    await idleSpin();
    await comeBack();
    await tick(60_000);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    touch();
    await tick(30_000);
    expect(backend.spin).toHaveBeenCalledTimes(2);
  });

  it('an unattended tab still spins when Spin is pressed', async () => {
    await open();
    await idleSpin();
    await comeBack();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await tick(0);
    expect(backend.spin).toHaveBeenCalledTimes(2);
    expect(backend.spin.mock.calls[1][0].commitId).not.toBe(backend.spin.mock.calls[0][0].commitId);
  });

  it('an unattended tab still runs the Auto Spin the player starts, in full', async () => {
    await open();
    await idleSpin();
    await comeBack();
    // Chips prizes, so no won game ends the run early.
    prize = chips;
    fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Spin 5' }));
    await tick(0);
    for (let i = 2; i <= 6; i++) {
      expect(backend.spin).toHaveBeenCalledTimes(i);
      await land();
      await tick(1200);
    }
    expect(backend.spin).toHaveBeenCalledTimes(6);
    expect(backend.toast.success).toHaveBeenCalledWith('Auto Spin Finished: 5 Spins');
  });

  it('the spins of a run the player started are not automatic spins', async () => {
    prize = chips;
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Spin 5' }));
    await tick(0);
    for (let i = 1; i <= 5; i++) {
      await land();
      await tick(1200);
    }
    expect(backend.spin).toHaveBeenCalledTimes(5);
    await comeBack();
    await tick(30_000);
    // The next visit arms the countdown as usual, and it spins.
    expect(backend.spin).toHaveBeenCalledTimes(6);
  });

  it('a pressed spin is not an automatic spin', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await tick(0);
    await land();
    await comeBack();
    await tick(30_000);
    expect(backend.spin).toHaveBeenCalledTimes(2);
  });
});
