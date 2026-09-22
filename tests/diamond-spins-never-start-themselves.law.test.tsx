/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - DIAMOND SPINS NEVER START THEMSELVES (Dan, 2026-09-21, R1, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "Games can NEVER auto start. Remove the countdown clock that
 * triggers an auto start. The only 'auto play' is when the user chooses to
 * spin 5/10/25 at a time. Nothing ever auto-plays just because they are in
 * the game lobby."
 *
 * What shipped before this ruling, each one a path where play started or
 * advanced with no tap:
 *
 *   1. a 30-second idle countdown on the wheel page pressed Spin by itself
 *      (`useIdleSpinCountdown`, armed on every load and every entry change);
 *   2. the win reveal dismissed itself at the end of its own pop animation
 *      whenever the prize was a bonus game or an upgrade, and the page then
 *      navigated into the game;
 *   3. an unfinished bonus award opened its game page on load, by an effect;
 *   4. the upgrade ring started its spin the moment its reveal closed.
 *
 * All four are gone. This law renders the real page and the real wheel flow
 * with the clock under control, lets two minutes pass at every point where
 * a clock used to act, and asserts that no spin was requested, no game was
 * opened and no wheel turned. The one sanctioned automatic press, a run of
 * 5, 10 or 25 the player started, is pinned by
 * tests/components/DiamondWheelAutoRecovery.test.tsx.
 *
 * Source pins close the door the tests cannot see: the idle hook does not
 * exist, and the page does not import one.
 */
vi.mock('../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import receipts from './fixtures/diamond-wheel-v2-receipts.json';

const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  spin: vi.fn(),
  runBegin: vi.fn(),
  runEnd: vi.fn(),
  pick: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../src/services/DiamondWheelService', () => ({
  default: {
    getStateV2: backend.state,
    commit: backend.commit,
    spinV2: backend.spin,
    runBegin: backend.runBegin,
    runEnd: backend.runEnd,
    pickDiamondCard: backend.pick,
    welcomeState: async () => ({ available: false, enabled: false }),
    dailyBonusState: async () => ({ available: false, ticket_count: 0 }),
    history: async () => [],
  },
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'player' } }) }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: 'club' }),
  useNavigate: () => backend.navigate,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => 'd1000000-0000-4000-8000-000000000003',
}));
vi.mock('../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: vi.fn() }),
}));
vi.mock('../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../src/components/games/BonusReplayLibrary', () => ({ default: () => null }));
vi.mock('../src/components/wheel/DiamondWheel', () => ({
  default: ({ onLanded, spinning, upgraded }: any) => (
    <button disabled={!spinning} onClick={onLanded}>
      {upgraded ? 'Land Upgrade Wheel' : 'Land Wheel'}
    </button>
  ),
}));
vi.mock('../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
import DiamondWheelPage from '../src/pages/DiamondWheelPage';

const ROOT = resolve(__dirname, '..');
const wheel = receipts.filter((r) => r.kind === 'wheel').map((r) => r.value as any);
const chips = wheel.find((r) => r.outcome.kind === 'chips' && r.entry_value_diamonds === 100)!;
const bonus = wheel.find((r) => r.outcome.kind === 'bonus' && !r.welcome && !r.daily_bonus)!;
const upgrade = wheel.find((r) => r.outcome.kind === 'upgrade')!;
/* R15: a Diamonds spin seals three cards and pays nothing until one is
   turned over, so it is one more thing that must never happen by itself. */
const CARD_AWARD = 'd1000000-0000-4000-8000-0000000000c1';
const diamonds = wheel.find((r) => r.outcome.kind === 'diamonds')!;
const withCards = (attempt: any) => {
  const base = sealed(diamonds, attempt);
  return {
    ...base,
    outcome: {
      ...base.outcome,
      cards: {
        award_id: CARD_AWARD,
        risk_diamonds: attempt.entryDiamonds,
        status: 'pending',
      },
    },
  };
};
const state = {
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: chips.segments,
  pending_awards: [],
  auto_run: null,
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
  player: {
    diamonds: 10000,
    spendable: 10000,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
};
const sealed = (base: any, attempt: any) => ({
  ...base,
  entry_value_diamonds: attempt.entryDiamonds,
  player_cost_diamonds: attempt.entryDiamonds,
  fairness: {
    ...base.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  },
  ...(base.secondary
    ? {
        secondary: {
          ...base.secondary,
          fairness: {
            ...base.secondary.fairness,
            commit_id: attempt.commitId,
            server_seed_hash: attempt.commitHash,
            client_seed: attempt.clientSeed,
          },
        },
      }
    : {}),
  ...(base.bonus
    ? {
        bonus: {
          ...base.bonus,
          entry_diamonds: attempt.entryDiamonds,
          base_diamonds: attempt.entryDiamonds * base.bonus.boost_multiplier,
        },
      }
    : {}),
});
const TWO_MINUTES = 120_000;
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
beforeEach(() => {
  backend.state.mockResolvedValue(state);
  backend.commit.mockResolvedValue({
    ok: true,
    commit_id: 'd1000000-0000-4000-8000-000000000001',
    server_seed_hash: 'a'.repeat(64),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
});
const ready = async () => {
  render(<DiamondWheelPage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
  );
  vi.useFakeTimers();
};
const nothingHappened = () => {
  expect(backend.spin).not.toHaveBeenCalled();
  expect(backend.runBegin).not.toHaveBeenCalled();
  expect(backend.navigate).not.toHaveBeenCalled();
  expect(backend.pick).not.toHaveBeenCalled();
};

describe('the wheel page never presses Spin or opens a game without a tap', () => {
  it('sits idle, ready to spin, for two minutes and spins nothing', async () => {
    await ready();
    await wait(TWO_MINUTES);
    nothingHappened();
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
    // The countdown plate is gone with the countdown.
    expect(
      screen.queryByRole('button', { name: /Hold Automatic Spin|Hold \d+s|Auto Held/ })
    ).toBeNull();
  });

  it('changing the entry, or choosing a run size, arms nothing', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('Diamonds To Spin'), { target: { value: '500' } });
    await wait(TWO_MINUTES);
    fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
    expect(screen.getByRole('button', { name: 'Auto Spin 5' })).toBeInTheDocument();
    await wait(TWO_MINUTES);
    nothingHappened();
  });

  it('holds an unfinished bonus game in a Play Game card rather than opening it', async () => {
    backend.state.mockResolvedValue({
      ...state,
      pending_awards: [
        {
          id: 'd1000000-0000-4000-8000-000000000099',
          game: 'mines',
          base_diamonds: 100,
          boost_multiplier: 1,
          entry_diamonds: 100,
        },
      ],
    });
    render(<DiamondWheelPage />);
    const play = await screen.findByRole('button', { name: 'Play Game' });
    vi.useFakeTimers();
    await wait(TWO_MINUTES);
    nothingHappened();
    expect(screen.getByText('You Have A Bonus Game To Play')).toBeInTheDocument();
    fireEvent.click(play);
    expect(backend.navigate).toHaveBeenCalledTimes(1);
    expect(backend.navigate.mock.calls[0][0]).toMatch(/^\/clubs\/club\/mines\?wheelAward=/);
  });

  it('a won bonus game stays on its reveal until Play Game, and only then opens', async () => {
    await ready();
    backend.spin.mockImplementation(async (attempt) => sealed(bonus, attempt));
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await wait(0);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
    });
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!);
    });
    await wait(TWO_MINUTES);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(backend.navigate).not.toHaveBeenCalled();
    expect(backend.spin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Play Game' }));
    expect(backend.navigate).toHaveBeenCalledTimes(1);
    expect(backend.navigate.mock.calls[0][0]).toMatch(/^\/clubs\/club\/plinko\?wheelAward=/);
  });

  it('a won upgrade waits for Open Upgrade Wheel, then for a gesture on the ring, then for Play Game', async () => {
    await ready();
    backend.spin.mockImplementation(async (attempt) => sealed(upgrade, attempt));
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await wait(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
    });
    await act(async () => {
      fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!);
    });
    await wait(TWO_MINUTES);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Land Upgrade Wheel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    const ring = screen.getByRole('button', { name: 'Swipe Or Tap The Wheel To Spin' });
    await wait(TWO_MINUTES);
    expect(screen.getByRole('button', { name: 'Land Upgrade Wheel' })).toBeDisabled();
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.pointerDown(ring, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(ring, { pointerId: 1, clientX: 5, clientY: 5 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Upgrade Wheel' }));
    });
    await act(async () => {
      fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!);
    });
    await wait(TWO_MINUTES);
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Play Game' }));
    expect(backend.navigate).toHaveBeenCalledTimes(1);
    expect(backend.spin).toHaveBeenCalledTimes(1);
  });

  it('a won diamonds game waits for Pick A Card, and then for a card', async () => {
    await ready();
    backend.spin.mockImplementation(async (attempt) => withCards(attempt));
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await wait(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
    });
    await act(async () => {
      fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!);
    });
    // The reveal stays, and nothing turns a card over while it does.
    await wait(TWO_MINUTES);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(backend.pick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pick A Card' }));
    await wait(0);
    const cards = screen.getByRole('dialog', { name: 'Diamond Card Pick' });
    // Three face-down cards, and two minutes in which none of them turns over.
    expect(within(cards).getByRole('button', { name: 'Card One' })).toBeEnabled();
    await wait(TWO_MINUTES);
    expect(backend.pick).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Diamond Card Pick' })).toBeInTheDocument();
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(backend.navigate).not.toHaveBeenCalled();
  });

  it('a run found open at the server on load waits for Resume Run', async () => {
    backend.state.mockResolvedValue({
      ...state,
      auto_run: { run_id: 'd1000000-0000-4000-8000-000000000a01', spins: 10, spins_done: 2 },
    });
    render(<DiamondWheelPage />);
    await screen.findByRole('button', { name: 'Resume Run (8 Left)' });
    vi.useFakeTimers();
    await wait(TWO_MINUTES);
    nothingHappened();
    expect(backend.runEnd).not.toHaveBeenCalled();
  });
});

describe('the clock that pressed Spin is gone from the source', () => {
  const page = readFileSync(resolve(ROOT, 'src/pages/DiamondWheelPage.tsx'), 'utf8');
  it('the idle countdown hook and its plate no longer exist', () => {
    expect(existsSync(resolve(ROOT, 'src/hooks/useIdleSpinCountdown.ts'))).toBe(false);
    expect(page).not.toContain('useIdleSpinCountdown');
    expect(page).not.toContain('idleArmed');
    expect(page).not.toContain('Hold Automatic Spin');
  });
  it('no effect opens a pending award; only playAward does, from a tap', () => {
    const effects = page.split('useEffect(');
    for (const effect of effects.slice(1)) {
      const body = effect.slice(0, effect.indexOf('}, ['));
      expect(body).not.toContain('openBonus(');
      expect(body).not.toContain('navigate(');
    }
    expect(page).toContain('const playAward = useCallback(');
  });
  it('the reveal has no automatic branch for a game', () => {
    const reveal = readFileSync(resolve(ROOT, 'src/components/wheel/WheelWinReveal.tsx'), 'utf8');
    expect(reveal).not.toContain("autoContinue || prize.kind === 'bonus'");
    expect(reveal).toContain(
      "const gameAhead = prize.kind === 'bonus' || prize.kind === 'upgrade';"
    );
    expect(reveal).toContain('autoContinue && autoContinueAfterMs > 0 && !gameAhead');
  });
});
