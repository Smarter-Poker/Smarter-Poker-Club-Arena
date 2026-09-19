import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
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
const state = {
  available: true,
  frozen: false,
  tables: [
    {
      name: 'Steady',
      version: 2,
      multipliers_cents: Array(17).fill(100),
      max_multiplier_cents: 1000,
    },
  ],
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  config: { max_rounds_per_player_per_day: 500 },
  player: { spendable: 0, is_member: true, rounds_today: 0, seconds_until_next: 0 },
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  backend.getState.mockResolvedValue(state);
  backend.latest.mockResolvedValue(null);
  backend.commit.mockResolvedValue({
    ok: true,
    commit_id: '00000000-0000-0000-0000-000000000009',
    server_seed_hash: 'a'.repeat(64),
  });
  backend.start.mockReturnValue(new Promise(() => {}));
});
afterEach(cleanup);
describe('Plinko starts only its earned funding', () => {
  it('shows its exact confirmed prize after the final drop and returns to its wheel', async () => {
    backend.awardState.mockResolvedValue({ enabled: false, award: null, gameState: null });
    backend.getState.mockResolvedValue({
      ...state,
      bets: [{ bet_diamonds: 100, cap_cents: 2000, playable: true }],
      player: { ...state.player, spendable: 100 },
    });
    backend.start.mockResolvedValue({ ...fixtures.receipts.plinko, payout_chips: 12.57 });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Drops' }));
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: '12.57 Chips' })).toBeInTheDocument();
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Prize' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel',
      { replace: true }
    );
  });
  it('allows the reserved upgrade with no fresh base diamonds and preserves denomination choices', async () => {
    const award = {
      id: '00000000-0000-0000-0000-000000000077',
      game: 'plinko',
      base_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2,
      status: 'pending',
    };
    backend.awardState.mockResolvedValue({ enabled: true, award, gameState: state });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Drop Diamonds' }));
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: {
          base: 200,
          doubled: false,
          denomination: 20,
          award: { id: award.id, entryDiamonds: 100, boostMultiplier: 2 },
        },
      }),
      'player-a'
    );
  });
  it('routes a direct visitor back to the wheel without admitting a new wager', async () => {
    backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
    render(<DiamondPlinkoPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Spin The Wheel' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel'
    );
    expect(backend.start).not.toHaveBeenCalled();
  });
});
