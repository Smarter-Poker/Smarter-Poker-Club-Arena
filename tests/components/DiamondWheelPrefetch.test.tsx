/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE AWARDED GAME LOADS DURING THE SPIN, NOT AFTER IT (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The wheel is where every Donkey Cross, Mines, Crash and Plinko round starts,
 * and the award navigates to its game the moment the reveal finishes. So the
 * game's chunk was fetched with the player already told they had won and the
 * page sitting on "Opening Your Bonus Game". The spin animation is seconds of
 * time nobody is waiting on; the fetch belongs there.
 *
 * These pin WHEN the warm happens (while the result is still a spinning
 * wheel, before any navigation) and WHICH game is read out of the receipt -
 * including an Upgrade, whose prize is its secondary outcome, not its first.
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
  warm: vi.fn(),
}));
vi.mock('../../src/utils/diamondGamePreload', () => ({ preloadDiamondGame: backend.warm }));
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

const wheel = (match: (value: any) => boolean) =>
  receipts.find((r) => r.kind === 'wheel' && match(r.value))!.value as any;
const chips = wheel((v: any) => v.outcome?.kind === 'chips');
const crossing = wheel((v: any) => v.bonus?.game === 'crossing' && v.outcome?.kind === 'bonus');
/** An Upgrade: the first wheel lands on Upgrade, the second one pays the prize. */
const upgrade = wheel((v: any) => v.outcome?.kind === 'upgrade' && v.secondary?.outcome?.game);

const state = (pending: unknown[] = []) => ({
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: chips.segments,
  pending_awards: pending,
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
  player: {
    diamonds: 10000,
    spendable: 10000,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
});
let ticket = 0;
let prize: any = crossing;
/** The stored receipt, re-sealed onto the commit this spin actually sent, and
 *  re-priced to the entry this wheel charges - assertWheelAward checks both. */
const receipt = (attempt: any) => {
  const fairness = {
    ...prize.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  };
  return {
    ...prize,
    entry_value_diamonds: attempt.entryDiamonds,
    player_cost_diamonds: attempt.entryDiamonds,
    fairness,
    ...(prize.bonus
      ? {
          bonus: {
            ...prize.bonus,
            entry_diamonds: attempt.entryDiamonds,
            base_diamonds: attempt.entryDiamonds * prize.bonus.boost_multiplier,
          },
        }
      : {}),
    ...(prize.secondary
      ? {
          secondary: {
            ...prize.secondary,
            fairness: {
              ...prize.secondary.fairness,
              commit_id: fairness.commit_id,
              server_seed_hash: fairness.server_seed_hash,
              server_seed: fairness.server_seed,
              client_seed: fairness.client_seed,
              nonce: fairness.nonce,
            },
          },
        }
      : {}),
  };
};
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const open = async () => {
  render(<DiamondWheelPage />);
  await tick(0);
};
/** Press Spin and let the server answer. The wheel is turning when this returns. */
const spin = async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
  await tick(0);
};
/** The wheel lands and its reveal plays out, which is what opens the game. */
const land = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
  await act(async () =>
    fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!)
  );
  await tick(0);
};

beforeEach(() => {
  ticket = 0;
  prize = crossing;
  vi.useFakeTimers();
  backend.state.mockResolvedValue(state());
  backend.commit.mockImplementation(async () => ({
    ok: true,
    commit_id: `d1000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
    server_seed_hash: 'a'.repeat(64),
  }));
  backend.spin.mockImplementation(async (attempt: any) => receipt(attempt));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('the awarded game is warmed while the wheel is still turning', () => {
  it('warms Donkey Cross when the receipt arrives, before any navigation', async () => {
    await spin();
    expect(backend.warm).toHaveBeenCalledWith('crossing');
    expect(backend.navigate).not.toHaveBeenCalled();
    await land();
    expect(backend.navigate).toHaveBeenCalledWith(expect.stringContaining('/crossing?wheelAward='));
  });

  it('warms nothing when the prize is chips', async () => {
    prize = chips;
    await spin();
    await land();
    expect(backend.warm).not.toHaveBeenCalledWith(expect.stringMatching(/\w/));
  });

  it("warms an Upgrade's prize, which its first wheel does not name", async () => {
    // The first outcome is 'upgrade' and its game is null; the prize is the
    // award the second wheel produced, and that is what the reveal opens.
    prize = upgrade;
    expect(upgrade.outcome.game).toBeNull();
    await spin();
    expect(backend.warm).toHaveBeenCalledWith(upgrade.bonus.game);
    expect(upgrade.bonus.game).toBe(upgrade.secondary.outcome.game);
  });

  it('warms the game of an unfinished award the moment the wheel reads it', async () => {
    backend.state.mockResolvedValue(
      state([
        {
          id: '7f000000-0000-4000-8000-000000000001',
          game: 'mines',
          base_diamonds: 100,
          boost_multiplier: 1,
          entry_diamonds: 100,
        },
      ])
    );
    await open();
    expect(backend.warm).toHaveBeenCalledWith('mines');
  });
});
