vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
/**
 * A WON PLINKO GAME FINISHES ON A PHONE THAT CANNOT DRAW IT.
 *
 * Owner ruling, 2026-09-21: no game may require a player to check anything,
 * and a player is never held on a page that cannot progress. The page holds
 * its exits while the drops fall and lets go when the board says they have
 * landed. With the real board and no WebGL (a browser that refuses it, a GPU
 * that is blocklisted) the board never said so: the server had booked the
 * batch, and the page held the player on "Dropping" until they pressed Show
 * Results. Here the board is the real one; only its renderer is missing.
 */
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
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: backend,
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
// The real board, on a browser with no WebGL.
vi.mock('../../src/components/games/sceneKit', async (original) => ({
  ...(await original<typeof import('../../src/components/games/sceneKit')>()),
  gameRenderer: () => {
    throw new Error('WebGL Is Unavailable');
  },
}));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({
  WheelWinReveal: ({ title, detail }: { title: string; detail: string }) => (
    <div role="dialog" aria-label={title}>
      {detail}
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
      name: 'Super',
      version: 4,
      multipliers_cents: PLINKO_TABLES[4].multipliersCents,
      max_multiplier_cents: 2000,
    },
  ],
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  config: { max_rounds_per_player_per_day: 500 },
  player: { spendable: 0, is_member: true, rounds_today: 0, seconds_until_next: 0 },
};
const award = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'plinko',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
const holding = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(backend)) mock.mockReset();
  sessionStorage.clear();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  backend.latest.mockResolvedValue(null);
  backend.getState.mockResolvedValue(state);
  backend.commit.mockResolvedValue({
    ok: true,
    commit_id: '00000000-0000-0000-0000-00000000000a',
    server_seed_hash: 'a'.repeat(64),
  });
  backend.awardState.mockResolvedValue({
    enabled: true,
    award,
    gameState: state,
    quote: { guarantee: 'super', minimumPayoutChips: 10, mode: null, plinkoTable: 4 },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a won Plinko game on a board that cannot draw', () => {
  it('lands the booked batch by itself, lets the player go and shows the result, with no press', async () => {
    backend.start.mockResolvedValueOnce({
      ...fixtures.receipts.plinko,
      table_version: 4,
      payout_chips: 3.25,
    });
    render(<DiamondPlinkoPage />);
    await advance();
    expect(screen.getByText(/The 3D Scene Is Unavailable/)).toBeInTheDocument();
    const offer = screen.getByRole('dialog', { name: 'Double Down Your Bonus' });
    fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Keep My Bonus' }));
    await advance();
    // The won game starts itself...
    await advance(5000);
    expect(backend.start).toHaveBeenCalledTimes(1);
    // ...and the booked batch lands at once: nothing is left to press and
    // nothing holds the player.
    expect(screen.queryByRole('button', { name: 'Show Results' })).not.toBeInTheDocument();
    expect(holding()).toBe(false);
    expect(screen.getByRole('dialog', { name: '3.25 Chips' })).toBeInTheDocument();
    expect(screen.getByText(/3.25 Chips Booked From 10 Drops/)).toBeInTheDocument();
  });
});
