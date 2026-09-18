import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import DiamondCrashPage from '../../src/pages/DiamondCrashPage';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  commit: vi.fn(),
  crashHistory: vi.fn(),
  crashSettle: vi.fn(),
  start: vi.fn(),
  navigate: vi.fn(),
  awardState: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../src/utils/diamondGamesFairness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/diamondGamesFairness')>()),
  verifyCrashRound: backend.verify,
}));
vi.mock('../../src/utils/sealedChipPrize', () => ({
  sealedChipPrize: async () => 1.28,
}));
vi.mock('../../src/services/DiamondGamesService', () => ({
  default: backend,
  normaliseCrash: (raw: unknown) => raw,
}));
vi.mock('../../src/services/DiamondBonusService', () => ({
  DiamondBonusService: { start: backend.start },
  BonusRefusal: class extends Error {},
}));
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
  soundService: {
    playSpinStart: vi.fn(),
    playSpinMultiplierResult: vi.fn(),
  },
}));
vi.mock('../../src/components/console/DeckConsole', () => ({
  DeckConsole: ({
    children,
    primary,
  }: {
    children?: ReactNode;
    primary?: {
      label: string;
      disabled?: boolean;
      onClick?: () => void;
    };
  }) => (
    <section>
      {children}
      <button disabled={primary?.disabled} onClick={primary?.onClick}>
        {primary?.label}
      </button>
    </section>
  ),
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    children,
    plates,
  }: {
    children?: ReactNode;
    plates?: {
      primary?: { label: string; disabled?: boolean; onClick?: () => void };
    };
  }) => (
    <section>
      {children}
      {plates?.primary && (
        <button disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));
vi.mock('../../src/components/common/PageSkeleton', () => ({ default: () => null }));
vi.mock('../../src/components/common/EmptyState', () => ({ ErrorState: () => null }));
vi.mock('../../src/components/crash/CrashCurve', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../../src/components/games/CrashPointsStrip', () => ({ default: () => null }));

const settled = fixtures.receipts.crash;
const open = {
  ...settled,
  status: 'open',
  outcome: null,
  elapsed_ms: 8000,
  multiplier_now_cents: 257,
  fairness: {
    commit_id: settled.fairness.commit_id,
    client_seed: settled.fairness.client_seed,
    server_seed_hash: settled.fairness.server_seed_hash,
    nonce: settled.fairness.nonce,
  },
};
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
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mountOpen() {
  backend.getState.mockResolvedValueOnce({ ...state, open_round: open });
  const view = render(<DiamondCrashPage />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(320);
  });
  return view;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  backend.awardState
    .mockReset()
    .mockResolvedValue({ enabled: false, award: null, gameState: null });
  backend.getState.mockReset().mockResolvedValue(state);
  backend.crashSettle.mockReset();
  backend.start.mockReset();
  backend.verify.mockReset();
  backend.commit.mockReset().mockResolvedValue({
    ok: true,
    commit_id: '00000000-0000-0000-0000-000000000009',
    server_seed_hash: 'a'.repeat(64),
  });
  backend.crashHistory.mockResolvedValue([]);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Crash settles one displayed round once', () => {
  it('binds the visible hundredth to the click and freezes it while confirmation is pending', async () => {
    backend.crashSettle.mockResolvedValueOnce(open);
    await mountOpen();
    const shown = screen.getByText('Climbing').nextElementSibling!.textContent!;
    const cents = Math.round(Number(shown.replace('x', '')) * 100);
    backend.crashSettle.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Book The Win' }));
    expect(backend.crashSettle).toHaveBeenCalledWith(
      open.round_id,
      true,
      expect.objectContaining({ round_id: open.round_id }),
      cents
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('Climbing').nextElementSibling!.textContent).toBe(shown);
  });
  it('does not apply a previous proof verdict while the next entry is pending', async () => {
    const proof = deferred<{
      fair: boolean;
      hashMatches: boolean;
      rollMatches: boolean;
      crashMatches: boolean;
    }>();
    backend.verify.mockReturnValue(proof.promise);
    backend.crashSettle.mockResolvedValueOnce(settled);
    await mountOpen();
    fireEvent.click(screen.getByText('Check Any Round'));
    fireEvent.click(screen.getByRole('button', { name: 'Verify Round' }));
    expect(backend.verify).toHaveBeenCalledTimes(1);
    backend.start.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    expect(backend.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      proof.resolve({ fair: true, hashMatches: true, rollMatches: true, crashMatches: true });
    });
    expect(backend.toast.success).not.toHaveBeenCalledWith('This Round Verifies');
  });
  it('waits for the exact new entry and ignores a late quote for an older amount', async () => {
    const older = deferred<typeof state>(),
      newer = deferred<typeof state>();
    backend.getState.mockImplementation((_club, _game, amount) =>
      amount === 150 ? older.promise : amount === 200 ? newer.promise : Promise.resolve(state)
    );
    render(<DiamondCrashPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Entry Diamonds'), { target: { value: '150' } });
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Start 150' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Entry Diamonds'), { target: { value: '200' } });
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Start 200' })).toBeDisabled();
    await act(async () => {
      newer.resolve({ ...state, bets: [{ bet_diamonds: 200, cap_cents: 5000, playable: true }] });
    });
    expect(screen.getByRole('button', { name: 'Start 200' })).toBeEnabled();
    await act(async () => {
      older.resolve({ ...state, bets: [{ bet_diamonds: 150, cap_cents: 150, playable: true }] });
    });
    expect(screen.getByRole('button', { name: 'Start 200' })).toBeEnabled();
    expect(screen.getByText(/Up To 50x On This Bet/)).toBeInTheDocument();
  });
  it('does not let an old poll overwrite a new round after cashout', async () => {
    const poll = deferred<typeof settled>();
    backend.crashSettle.mockReturnValueOnce(poll.promise).mockResolvedValueOnce(settled);
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Book The Win' }));
    await act(async () => {});
    expect(backend.toast.success).toHaveBeenCalledTimes(1);
    backend.start.mockResolvedValueOnce({
      ...open,
      round_id: '00000000-0000-0000-0000-000000000010',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    await act(async () => {});
    await act(async () => {
      poll.resolve(settled);
    });
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    expect(backend.toast.success).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start.mock.calls[0][0].serverSeedHash).toBe('a'.repeat(64));
  });
  it('waits for an admitted cashout and does not celebrate its duplicate receipt twice', async () => {
    const poll = deferred<typeof settled>(),
      cashout = deferred<typeof settled>();
    backend.crashSettle.mockReturnValueOnce(poll.promise).mockReturnValueOnce(cashout.promise);
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Book The Win' }));
    await act(async () => {
      poll.resolve(settled);
    });
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeDisabled();
    await act(async () => {
      cashout.resolve(settled);
    });
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    expect(backend.toast.success).toHaveBeenCalledTimes(1);
    expect(backend.crashSettle.mock.calls.map((args) => args[1])).toEqual([false, true]);
  });
  it('does not restart polling when an outstanding request fails after leaving the page', async () => {
    const poll = deferred<typeof settled>();
    backend.crashSettle.mockReturnValueOnce(poll.promise);
    const view = await mountOpen();
    view.unmount();
    await act(async () => {
      poll.reject(new Error('Disconnected'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(backend.crashSettle).toHaveBeenCalledTimes(1);
    expect(backend.toast.success).not.toHaveBeenCalled();
  });
});

describe('Crash uses its earned entry without blocking existing cashouts', () => {
  it('admits the funded award with an empty wallet and binds Double Down to the original stake', async () => {
    const award = {
      id: '00000000-0000-0000-0000-000000000077',
      game: 'crash',
      base_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2,
      status: 'pending',
    };
    backend.getState.mockResolvedValue({
      ...state,
      player: { ...state.player, spendable: 0, diamonds: 0 },
    });
    backend.awardState.mockImplementation((_club, _game, doubled) =>
      Promise.resolve({
        enabled: true,
        award,
        gameState: {
          ...state,
          player: { ...state.player, spendable: doubled ? 100 : 0, diamonds: doubled ? 100 : 0 },
          bets: [{ bet_diamonds: doubled ? 300 : 200, playable: true, cap_cents: 2000 }],
        },
      })
    );
    backend.start.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Start 200' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Double Down · +100 Diamonds' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Start 300' }));
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: {
          base: 200,
          doubled: true,
          denomination: 1,
          award: { id: award.id, entryDiamonds: 100, boostMultiplier: 2 },
        },
      }),
      'player-a'
    );
  });
  it('keeps the existing open round cashout plate usable when no new award exists', async () => {
    backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
    backend.crashSettle.mockResolvedValueOnce(open);
    await mountOpen();
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
  });
});
