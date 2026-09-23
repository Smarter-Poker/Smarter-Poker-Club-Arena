// The real hook returns the release a page's exits call before they leave.
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: vi.fn(() => () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import DiamondCrashPage from '../../src/pages/DiamondCrashPage';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { BonusRefusal } from '../../src/services/DiamondBonusService';
import { soundService } from '../../src/services/SoundService';
import { triggerHaptic } from '../../src/services/HapticService';
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
  /** What the host's floor feed answers; the real crash-points strip reads it. */
  floor: null as null | {
    wins: never[];
    crash_points: { crash_cents: number; cashed: boolean; at: string }[];
  },
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
vi.mock('../../src/services/DiamondBonusService', async (original) => ({
  // The real module's other exports (BonusUnreadable and the copy the page
  // prints) stay, so every catch path the page takes can read them.
  ...(await original<typeof import('../../src/services/DiamondBonusService')>()),
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
  useGameFloor: () => ({ floor: backend.floor, refresh: backend.refresh }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: {
    playSpinStart: vi.fn(),
    playSpinMultiplierResult: vi.fn(),
    playWin: vi.fn(),
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
    eyebrow,
  }: {
    children?: ReactNode;
    eyebrow?: string;
    plates?: {
      primary?: { label: string; disabled?: boolean; onClick?: () => void };
      secondary?: { label: string; disabled?: boolean; onClick?: () => void };
    };
  }) => (
    <section>
      <span data-eyebrow>{eyebrow}</span>
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
vi.mock('../../src/components/common/EmptyState', () => ({ ErrorState: () => null }));
vi.mock('../../src/components/crash/CrashCurve', () => ({
  default: ({
    onSettled,
    onTick,
    tickerCents,
  }: {
    onSettled: () => void;
    onTick?: (cents: number) => void;
    tickerCents?: number | null;
  }) => (
    <>
      <button onClick={onSettled}>Finish Flight</button>
      <button onClick={() => onTick?.(333)}>Tick 3.33x</button>
      <button onClick={() => onTick?.(444)}>Tick 4.44x</button>
      <output aria-label="Frozen Figure">{tickerCents ?? ''}</output>
    </>
  ),
}));
vi.mock('../../src/services/DiamondWheelService', () => ({
  default: { getStateV2: () => Promise.resolve({ pending_awards: [] }) },
}));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/games/TodayLine', () => ({ default: () => null }));
vi.mock('../../src/components/games/SealedPrize', () => ({ default: () => null }));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));

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
/** A Super Crash award from the wheel: a 100-diamond spin, doubled to a 200-diamond stake. */
const award = {
  id: '00000000-0000-0000-0000-000000000077',
  game: 'crash',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
};
/**
 * The server quotes the award with the guarantee it will pay: half the funded
 * stake (2 chips, or 3 with Double Down), which is the original spin value.
 */
function quoteSuperAward() {
  backend.getState.mockResolvedValue({
    ...state,
    available: false,
    player: { ...state.player, spendable: 0, diamonds: 0 },
  });
  backend.awardState.mockImplementation((_club, _game, doubled) =>
    Promise.resolve({
      enabled: true,
      award,
      gameState: {
        ...state,
        player: { ...state.player, spendable: 100, diamonds: 100 },
        bets: [{ bet_diamonds: doubled ? 300 : 200, playable: true, cap_cents: 2000 }],
      },
      quote: {
        guarantee: 'super',
        minimumPayoutChips: doubled ? 1.5 : 1,
        mode: null,
        plinkoTable: 4,
      },
    })
  );
}
const guaranteedBay = () => screen.getByText('Guaranteed').nextElementSibling!;
/** The console readout under the curve: the one status region that carries a printed label. */
const readout = () =>
  screen.getAllByRole('status').find((node) => node.querySelector('.sc-label'))!;
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
  backend.floor = null;
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Crash settles one displayed round once', () => {
  it('shows exact booked chips only after the flight reveal, and stays until Back To The Wheel', async () => {
    backend.crashSettle.mockResolvedValueOnce(settled);
    await mountOpen();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Flight' }));
    const amount = settled.outcome.payout_chips.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const receipt = screen.getByRole('dialog', { name: `${amount} Chips` });
    expect(receipt).toHaveTextContent('The Flight Crashed At');
    fireEvent.animationEnd(receipt.querySelector('[data-motion="keep"]')!);
    // Games can never auto start (R1): two idle minutes and the receipt is still up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(backend.navigate).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(within(receipt).getByRole('button', { name: 'Back To The Wheel' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      '/clubs/00000000-0000-0000-0000-000000000003/wheel',
      { replace: true }
    );
  });
  it('never starts a round by itself: two idle minutes on the entry screen start nothing (R1)', async () => {
    // Dan 2026-09-21, R1: "Games can NEVER auto start." The ordinary entry
    // screen sits with a ready Start plate; nothing but a thumb may press it.
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
  });
  it('holds a funded award on its offer for two idle minutes without starting or leaving', async () => {
    quoteSuperAward();
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    // Still asking, and nothing was answered, started or navigated for the player.
    expect(screen.getByRole('dialog', { name: 'Double Your Diamonds' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.navigate).not.toHaveBeenCalled();
  });
  /**
   * A CRASH SAYS NOTHING (review 2026-09-22). The page deliberately keeps
   * silent when a flight crashes, and then the receipt mounted over it and
   * played a major arpeggio and a success buzz anyway. A cashed round is not
   * sung twice either: the page already sang it at its own multiplier.
   */
  it('never lets the receipt celebrate a crash, or sing a cash-out twice', async () => {
    backend.crashSettle.mockResolvedValueOnce({
      ...settled,
      status: 'crashed',
      outcome: { ...settled.outcome, status: 'crashed', payout_chips: 0.1 },
    });
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Flight' }));
    const receipt = screen.getByRole('dialog', { name: '0.10 Chips' });
    expect(receipt).toHaveTextContent('Guarantee Paid');
    expect(receipt).not.toHaveTextContent('You Won');
    expect(soundService.playWin).not.toHaveBeenCalled();
    // The page's own light taps stay; the receipt's success buzz never lands.
    expect(triggerHaptic).not.toHaveBeenCalledWith('success');
    cleanup();
    vi.clearAllMocks();
    backend.crashSettle.mockResolvedValueOnce(settled);
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Flight' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(soundService.playWin).not.toHaveBeenCalled();
  });
  it('sends both unfunded entry controls directly to the wheel without starting a game', async () => {
    backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
    render(<DiamondCrashPage />);
    await act(async () => {});
    const controls = screen.getAllByRole('button', { name: 'Spin The Wheel' });
    expect(controls).toHaveLength(2);
    for (const control of controls) fireEvent.click(control);
    expect(backend.navigate.mock.calls).toEqual([
      ['/clubs/00000000-0000-0000-0000-000000000003/wheel'],
      ['/clubs/00000000-0000-0000-0000-000000000003/wheel'],
    ]);
    expect(backend.start).not.toHaveBeenCalled();
  });

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
  it('prints each frame into the readout without a render, and books exactly the printed figure (R20)', async () => {
    backend.crashSettle.mockResolvedValueOnce(open);
    await mountOpen();
    // The curve's clock hands the page a figure; the readout's text node takes
    // it directly. The hero is handed nothing to freeze on while the climb runs.
    fireEvent.click(screen.getByRole('button', { name: 'Tick 3.33x' }));
    expect(screen.getByText('Climbing').nextElementSibling!.textContent).toBe('3.33x');
    expect(readout()).toHaveTextContent('Worth 3.33 Chips Right Now');
    expect(screen.getByLabelText('Frozen Figure')).toHaveTextContent('');
    backend.crashSettle.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Book The Win' }));
    expect(backend.crashSettle).toHaveBeenLastCalledWith(
      open.round_id,
      true,
      expect.objectContaining({ round_id: open.round_id }),
      333
    );
    // While the request is pending the figure is frozen: the hero is handed
    // 333 to hold and a later frame changes nothing.
    expect(screen.getByLabelText('Frozen Figure')).toHaveTextContent('333');
    fireEvent.click(screen.getByRole('button', { name: 'Tick 4.44x' }));
    expect(screen.getByText('Climbing').nextElementSibling!.textContent).toBe('3.33x');
    expect(screen.getByLabelText('Frozen Figure')).toHaveTextContent('333');
  });
  it('opens Book The Win only once the figure reaches the cash-out floor, by one state change', async () => {
    backend.getState.mockResolvedValueOnce({
      ...state,
      open_round: { ...open, elapsed_ms: 0, multiplier_now_cents: 100 },
    });
    backend.crashSettle.mockResolvedValue({ ...open, elapsed_ms: 0, multiplier_now_cents: 100 });
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Tick 3.33x' }));
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
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
  it('replaces a definitively refused ticket without automatically starting another round', async () => {
    backend.start.mockRejectedValueOnce(new BonusRefusal('That Ticket Has Expired'));
    render(<DiamondCrashPage />);
    await act(async () => {});
    backend.commit.mockResolvedValueOnce({
      ok: true,
      commit_id: '00000000-0000-0000-0000-000000000010',
      server_seed_hash: 'b'.repeat(64),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    await act(async () => {});
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Check Round' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeEnabled();
    backend.start.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    expect(backend.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ commitId: '00000000-0000-0000-0000-000000000010' }),
      'player-a'
    );
  });
  it('prepares a funded award when direct entry is closed and binds Double Down to the original stake', async () => {
    quoteSuperAward();
    backend.start.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    // Screen one (R9): the offer holds Start until it is answered by a tap.
    expect(screen.getByRole('button', { name: 'Answer The Offer First' })).toBeDisabled();
    const dialog = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
    fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Add The Diamonds' }));
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Super Crash' })).toBeInTheDocument();
    // The doubled stake is quoted again by the server: half of 3 chips.
    expect(guaranteedBay()).toHaveTextContent('1.50 Chips');
    expect(guaranteedBay()).toHaveAttribute('data-ink', 'gold');
    expect(readout()).toHaveTextContent(
      'Super Crash Pays At Least 1.50 Chips, Even If It Crashes Before You Cash Out.'
    );
    // Screen two (R1): the player presses Start themselves; nothing counts down.
    fireEvent.click(screen.getByRole('button', { name: 'Start 300' }));
    expect(backend.start).toHaveBeenCalledWith(
      expect.objectContaining({
        // Crash plays one round on the whole entry; it carries no drop value.
        budget: {
          base: 200,
          doubled: true,
          denomination: null,
          award: { id: award.id, entryDiamonds: 100, boostMultiplier: 2 },
        },
      }),
      'player-a'
    );
  });
  it('keeps Super Crash visible for an active funded round after its award is consumed', async () => {
    const bonus = {
      base_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2 as const,
      added_diamonds: 0,
      total_diamonds: 200,
    };
    const saved = {
      ...open,
      award_id: '00000000-0000-0000-0000-000000000077',
      bet_diamonds: 200,
      bet_chips: 2,
      minimum_payout_chips: 1,
      payout_version: 3,
      bonus,
    };
    backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
    backend.getState.mockResolvedValue({ ...state, open_round: saved });
    backend.crashSettle.mockResolvedValue(saved);
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Super Crash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    // The round on the table prints its own sealed floor, in Super gold.
    expect(guaranteedBay()).toHaveTextContent('1.00 Chips');
    expect(guaranteedBay()).toHaveAttribute('data-ink', 'gold');
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('prepares the game again by itself after a failed ticket, without submitting a round', async () => {
    backend.commit.mockRejectedValueOnce(new Error('Connection Lost'));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByText('Preparing Your Game')).toBeVisible();
    // Nobody is asked to retry: the page does it, a second later, not in a loop.
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(backend.commit).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(backend.commit).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(backend.commit).toHaveBeenCalledTimes(2);
    expect(backend.start).not.toHaveBeenCalled();
  });
  it('keeps the existing open round cashout plate usable when no new award exists', async () => {
    backend.awardState.mockResolvedValue({ enabled: true, award: null, gameState: null });
    backend.crashSettle.mockResolvedValueOnce(open);
    await mountOpen();
    expect(screen.getByRole('button', { name: 'Book The Win' })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
  });
});

/**
 * DAN 2026-09-19, VERBATIM: "ALL 'UPGRADED GAMES' NEED TO SAY 'SUPER + GAME
 * TITLE'. THEY MUST ALL PAY A MINIMUM OF 1:1 VALUE EVEN IF THEY LOSE AND DON'T
 * CASH OUT. THAT SHOULD BE DISPLAYED BEFORE THEY EVEN START THE GAME."
 *
 * The bay and the sentence are the server's own quote, read before Start; the
 * title is the game's name for the stake kind, and the word Upgraded is gone.
 */
describe('Crash shows its guarantee before the round starts', () => {
  it('titles a Super award Super Crash and prints the quoted floor in gold before Start', async () => {
    quoteSuperAward();
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Super Crash' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Upgraded/);
    // Before Double Down is answered: the 200-diamond stake is 2 chips, half of it 1.00.
    expect(guaranteedBay()).toHaveTextContent('1.00 Chips');
    expect(guaranteedBay()).toHaveAttribute('data-ink', 'gold');
    const dialog = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
    fireEvent.animationEnd(dialog.querySelector('[data-motion="keep"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Play Without' }));
    await act(async () => {});
    const sentence =
      'Super Crash Pays At Least 1.00 Chips, Even If It Crashes Before You Cash Out.';
    expect(readout()).toHaveTextContent(sentence);
    // The award panel says it too, in the same words, before the plate is pressed.
    expect(screen.getAllByText(sentence).length).toBeGreaterThan(0);
    // The offer is answered, so Start is the player's to press (R1): no clock.
    expect(screen.getByRole('button', { name: 'Start 200' })).toBeEnabled();
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('says Pending while the wheel award is still being checked', async () => {
    backend.awardState.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(guaranteedBay()).toHaveTextContent('Pending');
    expect(guaranteedBay()).not.toHaveAttribute('data-ink', 'gold');
    expect(readout()).toHaveTextContent('Checking Your Wheel Award');
  });

  it('prints the tenth an ordinary entry keeps, and says so, before Start', async () => {
    render(<DiamondCrashPage />);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Diamond Crash' })).toBeInTheDocument();
    // 100 diamonds at 100 per chip is 1 chip; an ordinary round keeps a tenth.
    expect(guaranteedBay()).toHaveTextContent('0.10 Chips');
    expect(guaranteedBay()).not.toHaveAttribute('data-ink', 'gold');
    expect(readout()).toHaveTextContent('Pays At Least 0.10 Chips On Any Loss.');
    expect(readout()).toHaveTextContent('Up To 1000x On This Bet.');
    fireEvent.change(screen.getByLabelText('Entry Diamonds'), { target: { value: '250' } });
    await act(async () => {});
    expect(guaranteedBay()).toHaveTextContent('0.25 Chips');
  });

  it('keeps the recent crash points above the curve, coloured by band', async () => {
    backend.floor = {
      wins: [],
      crash_points: [
        { crash_cents: 150, cashed: false, at: 'a' },
        { crash_cents: 250, cashed: true, at: 'b' },
        { crash_cents: 1200, cashed: true, at: 'c' },
      ],
    };
    render(<DiamondCrashPage />);
    await act(async () => {});
    const strip = screen.getByRole('list', { name: 'Recent Crash Points' });
    const items = Array.from(strip.querySelectorAll('[role="listitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(['1.5x', '2.5x', '12x']);
    expect(items.map((item) => item.getAttribute('data-band'))).toEqual(['low', 'mid', 'high']);
    expect(items[0]).toHaveClass('sc-ink--red');
    expect(items[1]).toHaveClass('sc-ink--green');
    expect(items[2]).toHaveClass('sc-ink--gold');
    // The strip sits in the stage before the curve, the way Aviator prints its history.
    const stage = strip.parentElement!;
    expect(stage.querySelector('button')?.textContent).toBe('Finish Flight');
    expect(strip.compareDocumentPosition(stage.querySelector('button')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});

/**
 * THE BREAK IS SAID ONCE, AND AN ANSWERED TICK STOPS ASKING (review
 * 2026-09-22). The tick asked fn_crash_settle every 320ms and called
 * toast.info('The Platform Is In Its Maintenance Break. The Round Waits') on
 * every one of those answers for as long as the break lasted; only the Toast
 * provider's sixty-second cooldown kept it off the screen. Nothing is decided
 * while the platform is paused, so those asks bought nothing. And an ok:false
 * answer - the session is gone, the round is not there, or it is not this
 * player's - was ignored entirely: the tick kept asking forever while the exit
 * guard held the player on a round the page could never finish.
 */
describe('the Crash tick stops asking once the answer cannot change', () => {
  const frozenRound = { ...open, frozen: true };
  const elapse = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const breakSaid = () =>
    backend.toast.info.mock.calls.filter(([said]) => /Maintenance Break/.test(String(said))).length;
  const guardHolds = () => vi.mocked(useLiveBonusGuard).mock.calls.at(-1)?.[0];

  it('says the break once, asks far less often through it, and settles the round when it ends', async () => {
    backend.crashSettle.mockResolvedValue(frozenRound);
    await mountOpen();
    // mountOpen has let one tick run: it found the break and said so.
    expect(breakSaid()).toBe(1);
    expect(backend.toast.info).toHaveBeenCalledWith(
      'The Platform Is In Its Maintenance Break. The Round Waits'
    );
    const asked = backend.crashSettle.mock.calls.length;
    await elapse(3200);
    // Ten polls' worth of time, one ask, and nothing said a second time.
    expect(backend.crashSettle).toHaveBeenCalledTimes(asked + 1);
    expect(breakSaid()).toBe(1);
    // The break ends: the next ask settles the round, with no press.
    backend.crashSettle.mockResolvedValue(settled);
    await elapse(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Finish Flight' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('stops asking about a round the server will not discuss, and hands the page back', async () => {
    backend.crashSettle.mockResolvedValue({ ok: false, error: 'Sign In To Play' });
    await mountOpen();
    const asked = backend.crashSettle.mock.calls.length;
    await elapse(10_000);
    // The answer can only repeat, so it is never asked for again.
    expect(backend.crashSettle).toHaveBeenCalledTimes(asked);
    expect(backend.toast.error).toHaveBeenCalledTimes(1);
    expect(backend.toast.error).toHaveBeenCalledWith(
      'This Round Cannot Be Followed Right Now. The Server Settles It Without This Page'
    );
    // The player is neither held on it nor shown a round the page cannot finish.
    expect(guardHolds()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Book The Win' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start 100' })).toBeInTheDocument();
    // Nothing was sent again on the player's behalf.
    expect(backend.start).not.toHaveBeenCalled();
  });
});

/**
 * A BLANK CLIENT SEED IS NOT A DECISION (review 2026-09-22). handleStart
 * already dealt itself a seed when "Your Client Seed" was empty, but sent it
 * without ever showing it, so the proof panel named a seed the round was not
 * started with, and the field stayed empty for the next round too.
 */
describe('Crash shows the client seed it actually sent', () => {
  const field = () => screen.getByLabelText('Your Client Seed') as HTMLInputElement;

  it('writes the dealt seed back into the field the player emptied', async () => {
    backend.start.mockResolvedValueOnce(open);
    backend.crashSettle.mockReturnValue(new Promise(() => {}));
    render(<DiamondCrashPage />);
    await act(async () => {});
    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start 100' }));
    await act(async () => {});
    const sent = backend.start.mock.calls[0][0].seed;
    expect(sent).toMatch(/^[0-9a-f]{32}$/);
    expect(field().value).toBe(sent);
    // Writing the seed back must not buy a second round on the same ticket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(backend.start).toHaveBeenCalledTimes(1);
  });

  it('refills the field when the player leaves it empty', async () => {
    render(<DiamondCrashPage />);
    await act(async () => {});
    const dealt = field().value;
    fireEvent.change(field(), { target: { value: '  ' } });
    expect(field().value).toBe('  ');
    fireEvent.blur(field());
    expect(field().value).toMatch(/^[0-9a-f]{32}$/);
    expect(field().value).not.toBe(dealt);
    // A seed the player did write is left exactly as they wrote it.
    fireEvent.change(field(), { target: { value: 'lucky crash' } });
    fireEvent.blur(field());
    expect(field().value).toBe('lucky crash');
  });
});
