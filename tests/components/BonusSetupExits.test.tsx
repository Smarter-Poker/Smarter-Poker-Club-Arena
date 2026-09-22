/**
 * THE SETUP'S EXITS LEAVE, ON EVERY GAME THAT RENDERS IT (review 2026-09-22).
 *
 * BonusSetup's own exits (Spin The Wheel, Buy More, Earn Diamonds, and the
 * Double Down offer's Buy More) navigated straight into the page's exit guard,
 * which holds a won game that could start so it can start itself. The guard
 * answered "Finish Your Bonus Game Before Leaving." and the player stayed put.
 * The setup now leaves through the page's own leave(to), which lets go of the
 * hold and navigates; the setup never calls it while it is disabled, and every
 * page disables it while money is in flight. Donkey Cross and Mines are pinned
 * in DiamondChoiceExits.test.tsx; Plinko and Crash here, with the real guard
 * and a real router.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import BonusSetup from '../../src/components/games/BonusSetup';
import DiamondPlinkoPage from '../../src/pages/DiamondPlinkoPage';
import DiamondCrashPage from '../../src/pages/DiamondCrashPage';
import { PLINKO_TABLES } from '../../src/utils/diamondBonusPayout';

const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  latest: vi.fn(),
  crashHistory: vi.fn(),
  crashSettle: vi.fn(),
  start: vi.fn(),
  awardState: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../src/services/DiamondGamesService', () => ({
  default: backend,
  normaliseCrash: (raw: unknown) => raw,
}));
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
  DiamondBonusService: { start: backend.start },
}));
vi.mock('../../src/services/WheelBonusEntryService', async (original) => ({
  ...(await original<typeof import('../../src/services/WheelBonusEntryService')>()),
  WheelBonusEntryService: { state: backend.awardState },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-a' } }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playSpinStart: vi.fn(), playSpinMultiplierResult: vi.fn() },
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('../../src/hooks/useMeasuredWidth', () => ({ useMeasuredWidth: () => [null, 320] }));
vi.mock('../../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: vi.fn() }),
}));
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({ default: () => null }));
vi.mock('../../src/components/crash/CrashCurve', () => ({ default: () => null }));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/WheelWinReveal', () => ({ WheelWinReveal: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));

const CLUB = '00000000-0000-0000-0000-000000000003';
const AWARD_ID = '00000000-0000-0000-0000-000000000077';
const BLOCKED = 'Finish Your Bonus Game Before Leaving.';
const PLINKO_STATE = {
  available: true,
  frozen: false,
  tables: [
    {
      name: 'Diamond',
      version: 5,
      multipliers_cents: PLINKO_TABLES[5].multipliersCents,
      max_multiplier_cents: 2000,
    },
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
const CRASH_STATE = {
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
  bets: [{ bet_diamonds: 200, cap_cents: 2000, playable: true }],
  player: {
    is_member: true,
    diamonds: 0,
    spendable: 0,
    member_chips: 5,
    rounds_today: 1,
    diamonds_today: 100,
    seconds_until_next: 0,
  },
};
type Page = 'plinko' | 'crash';
/** A Super award from the wheel: 200 diamonds funded from a 100-diamond spin, and no diamonds of the player's own. */
const won = (page: Page) =>
  backend.awardState.mockImplementation(async () => ({
    enabled: true,
    award: {
      id: AWARD_ID,
      game: page,
      base_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2,
      status: 'pending',
    },
    gameState: page === 'plinko' ? PLINKO_STATE : CRASH_STATE,
    quote: { guarantee: 'super', minimumPayoutChips: 1, mode: null, plinkoTable: 4 },
  }));
/** The plate the player presses on screen two: nothing presses it for them (R1). */
const PLATE: Record<Page, string> = { plinko: 'Drop Diamonds', crash: 'Start 200' };
/** Plinko's screen two: the drop value is the player's choice (R6). */
const chooseDrops = async (page: Page) => {
  if (page !== 'plinko') return;
  fireEvent.click(screen.getByRole('button', { name: '20 Diamonds Per Drop, 10 Drops' }));
  await settle();
};
const settle = async () => {
  for (let i = 0; i < 6; i++)
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
const mount = async (page: Page) => {
  render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB}/${page}`]}>
      <Routes>
        <Route
          path={`/clubs/:clubId/${page}`}
          element={page === 'plinko' ? <DiamondPlinkoPage /> : <DiamondCrashPage />}
        />
        <Route path="/marketplace" element={<h1>Marketplace Page</h1>} />
        <Route path="/clubs/:clubId/earn-diamonds" element={<h1>Earn Diamonds Page</h1>} />
        <Route path="/clubs/:clubId/wheel" element={<h1>Wheel Page</h1>} />
        <Route path="/clubs/:clubId/diamond-games" element={<h1>Diamond Spins Page</h1>} />
      </Routes>
    </MemoryRouter>
  );
  await settle();
};
const offer = () => screen.getByRole('dialog', { name: 'Double Your Diamonds' });
const revealOffer = () => fireEvent.animationEnd(offer().querySelector('[data-motion="keep"]')!);
const blocked = () =>
  screen.queryByText(BLOCKED) !== null ||
  backend.toast.error.mock.calls.some(([message]) => message === BLOCKED);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  backend.getState
    .mockReset()
    .mockImplementation(async (_club: string, game: string) =>
      game === 'crash' ? CRASH_STATE : PLINKO_STATE
    );
  let dealt = 0;
  backend.commit.mockReset().mockImplementation(async () => {
    dealt += 1;
    return {
      ok: true,
      commit_id: `00000000-0000-0000-0000-${String(dealt).padStart(12, '0')}`,
      server_seed_hash: dealt.toString(16).padStart(64, 'a'),
    };
  });
  backend.latest.mockReset().mockResolvedValue(null);
  backend.crashHistory.mockReset().mockResolvedValue([]);
  backend.crashSettle.mockReset().mockReturnValue(new Promise(() => {}));
  // A start stays out unless a test answers it.
  backend.start.mockReset().mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(['plinko', 'crash'] as const)(
  '%s: the setup exits while a won game could start',
  (page) => {
    it("takes a player short of the diamonds to double from the offer's Buy More to the marketplace", async () => {
      won(page);
      await mount(page);
      revealOffer();
      expect(
        within(offer()).getByText(/You Need 100 More Diamonds To Add Them/)
      ).toBeInTheDocument();
      fireEvent.click(within(offer()).getByRole('button', { name: 'Buy More' }));
      await settle();
      expect(screen.getByRole('heading', { name: 'Marketplace Page' })).toBeInTheDocument();
      expect(blocked()).toBe(false);
      expect(backend.start).not.toHaveBeenCalled();
    });

    it('leaves by Earn Diamonds while the answered award waits on its plate', async () => {
      won(page);
      await mount(page);
      revealOffer();
      fireEvent.click(within(offer()).getByRole('button', { name: 'Play Without' }));
      await advance(1000);
      await chooseDrops(page);
      expect(screen.getByRole('button', { name: PLATE[page] })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Earn Diamonds' }));
      await settle();
      expect(screen.getByRole('heading', { name: 'Earn Diamonds Page' })).toBeInTheDocument();
      await advance(10_000);
      expect(backend.start).not.toHaveBeenCalled();
    });

    it('keeps every exit shut, and holds the player, while the start is out', async () => {
      won(page);
      await mount(page);
      revealOffer();
      fireEvent.click(within(offer()).getByRole('button', { name: 'Play Without' }));
      await settle();
      await chooseDrops(page);
      fireEvent.click(screen.getByRole('button', { name: PLATE[page] }));
      await settle();
      expect(backend.start).toHaveBeenCalledTimes(1);
      for (const exit of ['Buy More', 'Earn Diamonds'])
        expect(screen.getByRole('button', { name: exit })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /Diamond Spins/ }));
      await settle();
      expect(blocked()).toBe(true);
      expect(screen.queryByRole('heading', { name: 'Diamond Spins Page' })).toBeNull();
    });
  }
);

describe('BonusSetup leaves only through the page', () => {
  const budget = {
    base: 200,
    doubled: false,
    denomination: 20,
    award: { id: AWARD_ID, entryDiamonds: 100, boostMultiplier: 2 },
  };
  /** The page owns the offer's answer, so this fixture holds it like a page does. */
  function Fixture(props: {
    disabled: boolean;
    entryReady?: boolean;
    leave: (to: string) => void;
  }) {
    const [answered, setAnswered] = useState(false);
    return (
      <MemoryRouter>
        <BonusSetup
          budget={props.entryReady === false ? { ...budget, award: undefined } : budget}
          onChange={() => {}}
          diamonds={0}
          game="mines"
          clubId="shark-club"
          entryReady={props.entryReady}
          disabled={props.disabled}
          leave={props.leave}
          offerAnswered={answered}
          onOfferAnswered={() => setAnswered(true)}
        />
      </MemoryRouter>
    );
  }
  const setup = (props: { disabled: boolean; entryReady?: boolean; leave: (to: string) => void }) =>
    render(<Fixture {...props} />);

  it('sends each exit to its own page', () => {
    const leave = vi.fn();
    const view = setup({ disabled: false, leave });
    const dialog = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
    fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buy More' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Play Without' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Buy More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Earn Diamonds' }));
    view.unmount();
    setup({ disabled: false, entryReady: false, leave });
    fireEvent.click(screen.getByRole('button', { name: 'Spin The Wheel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy More' }));
    expect(leave.mock.calls).toEqual([
      ['/marketplace?tab=diamonds'],
      ['/marketplace?tab=diamonds'],
      ['/clubs/shark-club/earn-diamonds'],
      ['/clubs/shark-club/wheel'],
      ['/marketplace?tab=diamonds'],
    ]);
  });

  it('never leaves while the page has disabled it', () => {
    const leave = vi.fn();
    const view = setup({ disabled: true, leave });
    for (const exit of ['Buy More', 'Earn Diamonds']) {
      expect(screen.getByRole('button', { name: exit })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: exit }));
    }
    // A disabled setup asks nothing: the offer is not on screen.
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount();
    setup({ disabled: true, entryReady: false, leave });
    for (const exit of ['Spin The Wheel', 'Buy More']) {
      expect(screen.getByRole('button', { name: exit })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: exit }));
    }
    expect(leave).not.toHaveBeenCalled();
  });
});
