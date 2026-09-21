vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  start: vi.fn(),
  latest: vi.fn(),
  awardState: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../src/services/DiamondGamesService', () => ({ default: backend }));
vi.mock('../../src/services/DiamondBonusService', () => ({
  DiamondBonusService: backend,
  BonusRefusal: class extends Error {},
  parsePlinkoBonus: (v: unknown) => v,
}));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
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
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({
  default: ({
    batchPathBits,
    onLanded,
  }: {
    batchPathBits: number[] | null;
    onLanded: () => void;
  }) => (batchPathBits ? <button onClick={onLanded}>Finish Drops</button> : null),
}));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({
    title,
    detail,
    onOpen,
  }: {
    title: string;
    detail: string;
    onOpen: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      {detail}
      <button onClick={onOpen}>Finish Prize</button>
    </div>
  ),
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
/**
 * A WON GAME STARTS ITSELF.
 *
 * Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
 * ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY."
 *
 * Every Diamond Spins round is a wheel award the player has already won. Once
 * the one real question on the page (Double Down, which spends the player's
 * own diamonds) is answered, a short visible countdown presses Start for them.
 * The same ruling took "no way to go back" off the page: the bonus guard holds
 * a won game only while that game can start.
 */
const SUPER_TABLE = {
  name: 'Super',
  version: 4,
  multipliers_cents: PLINKO_TABLES[4].multipliersCents,
  max_multiplier_cents: 2000,
};
const state = {
  available: true,
  frozen: false,
  tables: [SUPER_TABLE],
  bets: [
    { bet_diamonds: 200, cap_cents: 2000, playable: true },
    { bet_diamonds: 300, cap_cents: 2000, playable: true },
  ],
  config: { max_rounds_per_player_per_day: 500 },
  player: { spendable: 1000, is_member: true, rounds_today: 0, seconds_until_next: 0 },
};
const award = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'plinko',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
const quote = { guarantee: 'super' as const, minimumPayoutChips: 10, mode: null, plinkoTable: 4 };
const tick = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const answer = async (name: 'Keep My Bonus' | 'Add Diamonds') => {
  const dialog = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
  fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!);
  fireEvent.click(screen.getByRole('button', { name }));
  await act(async () => {});
};
const held = () => vi.mocked(useLiveBonusGuard).mock.lastCall?.[0];
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  backend.getState.mockResolvedValue(state);
  backend.awardState.mockResolvedValue({ enabled: true, award, gameState: state, quote });
  backend.commit.mockResolvedValue({
    ok: true,
    commit_id: '00000000-0000-0000-0000-000000000009',
    server_seed_hash: 'a'.repeat(64),
  });
  backend.start.mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('a won game starts itself', () => {
  it('never starts over an unanswered Double Down offer', async () => {
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Double Down Your Bonus' })).toBeInTheDocument();
    await tick(20_000);
    expect(screen.getByRole('button', { name: 'Drop Diamonds' })).toBeInTheDocument();
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('counts five visible seconds after the answer, then drops without a press', async () => {
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answer('Keep My Bonus');
    expect(screen.getByRole('button', { name: 'Dropping In 5s' })).toBeEnabled();
    await tick(4_000);
    expect(screen.getByRole('button', { name: 'Dropping In 1s' })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
    await tick(1_100);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({ base: 200, doubled: false }),
      }),
      'player-a'
    );
  });

  it('starts the window again when the player changes their Double Down answer', async () => {
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answer('Keep My Bonus');
    await tick(3_000);
    // Reopening the offer stops the clock; the new answer is a new entry.
    fireEvent.click(screen.getByRole('button', { name: 'Double Down Your Bonus' }));
    await act(async () => {});
    await tick(10_000);
    expect(backend.start).not.toHaveBeenCalled();
    await answer('Add Diamonds');
    expect(screen.getByRole('button', { name: 'Dropping In 5s' })).toBeEnabled();
    await tick(4_500);
    expect(backend.start).not.toHaveBeenCalled();
    await tick(600);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({ base: 200, doubled: true }),
      }),
      'player-a'
    );
  });

  it('does not press Start twice when the player presses first', async () => {
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answer('Keep My Bonus');
    fireEvent.click(screen.getByRole('button', { name: 'Dropping In 5s' }));
    await tick(10_000);
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('holds the page on a won game that can start, and lets go of one that cannot', async () => {
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answer('Keep My Bonus');
    expect(held()).toBe(true);
    cleanup();
    // Today's limit is reached: the award stays pending server-side and the
    // wheel reopens it tomorrow, so nothing here may trap the player.
    const spent = { ...state, player: { ...state.player, rounds_today: 500 } };
    backend.getState.mockResolvedValue(spent);
    backend.awardState.mockResolvedValue({ enabled: true, award, gameState: spent, quote });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await tick(10_000);
    expect(held()).toBe(false);
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('deals the ticket again by itself when the first deal fails', async () => {
    backend.commit.mockRejectedValueOnce(new Error('Connection Lost'));
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    expect(screen.getAllByText('Preparing Your Ticket').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Try Refresh|Could Not Be/)).toBeNull();
    expect(backend.commit).toHaveBeenCalledTimes(1);
    await tick(1_100);
    expect(backend.commit).toHaveBeenCalledTimes(2);
    expect(screen.queryAllByText('Preparing Your Ticket')).toHaveLength(0);
    expect(backend.start).not.toHaveBeenCalled();
  });
});
