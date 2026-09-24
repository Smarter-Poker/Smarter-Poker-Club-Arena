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
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
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
const answer = async (name: 'Play Without' | 'Add The Diamonds') => {
  const dialog = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
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
/*
 * WHAT HOLDS A WON GAME, AND WHAT LETS IT GO.
 *
 * This file was DiamondAwardAutoStart.test.tsx: four of its cases pinned a
 * five-second countdown that pressed Start on a won game (#5043). Owner ruling
 * 2026-09-21, R1 and R9, removed that countdown ("Games can NEVER auto start";
 * "the won game must stay on screen until the user selects Play Game"), so
 * those four are gone and the entry flow's own regressions live where the flow
 * does: the offer and the selector are pinned by DiamondPlinkoAwardEntry and
 * DiamondChoiceQuotes, and "two idle minutes start nothing" by
 * tests/diamond-spins-never-start-themselves.law.tsx.
 *
 * What is left is the half that was never about starting anything, and still
 * binds: the exit guard holds a page only while its won game can actually
 * start, so an award the server will not take today never traps the player;
 * and a ticket deal that fails is dealt again by the page, never by a press.
 */
describe('a won game holds the page only while it can be played', () => {
  it('holds the page on a won game that can start, and lets go of one that cannot', async () => {
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    await answer('Play Without');
    // Screen two: the game cannot start until the player has chosen a drop
    // value (R6), so the hold begins with the choice, not with the award.
    expect(held()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
    await act(async () => {});
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
