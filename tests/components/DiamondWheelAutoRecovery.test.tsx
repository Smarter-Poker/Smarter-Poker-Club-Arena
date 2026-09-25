vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';
import {
  readWheelPending,
  saveWheelPending,
  type WheelPendingSpin,
} from '../../src/utils/wheelPendingSpin';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  spin: vi.fn(),
  runBegin: vi.fn(),
  runEnd: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', async (importOriginal) => ({
  // The page reads the service's named exports (the unverified-receipt error).
  ...(await importOriginal<typeof import('../../src/services/DiamondWheelService')>()),
  default: {
    getStateV2: backend.state,
    commit: backend.commit,
    spinV2: backend.spin,
    runBegin: backend.runBegin,
    runEnd: backend.runEnd,
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
  default: ({ onLanded, spinning, upgraded }: any) => (
    <button disabled={!spinning} onClick={onLanded}>
      {upgraded ? 'Land Upgrade Wheel' : 'Land Wheel'}
    </button>
  ),
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
import DiamondWheelPage from '../../src/pages/DiamondWheelPage';
const sample = receipts.find((r) => r.kind === 'wheel' && r.value.outcome?.kind === 'chips')!.value;
const bonusSample = receipts.find(
  (r) =>
    r.kind === 'wheel' &&
    r.value.outcome?.kind === 'bonus' &&
    !r.value.welcome &&
    !r.value.daily_bonus
)!.value;
const upgradeSample = receipts.find(
  (r) => r.kind === 'wheel' && r.value.outcome?.kind === 'upgrade'
)!.value;
const RUN_ID = 'd1000000-0000-4000-8000-00000000run1'.replace('run1', '0a01');
const state = {
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: sample.segments,
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
let ticket = 0;
const nextTicket = () => ({
  ok: true,
  commit_id: `d1000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
  server_seed_hash: 'a'.repeat(64),
});
/** The fixture receipt, sealed to this attempt's ticket and stake. */
const receiptFrom = (base: any, attempt: any) => {
  const fairness = {
    ...base.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  };
  return {
    ...base,
    spin_id: `d1000000-0000-4000-8000-${String(1000 + ++spinSerial).padStart(12, '0')}`,
    entry_value_diamonds: attempt.entryDiamonds,
    player_cost_diamonds: attempt.entryDiamonds,
    fairness,
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
            id: `d1000000-0000-4000-8000-${String(2000 + spinSerial).padStart(12, '0')}`,
            entry_diamonds: attempt.entryDiamonds,
            base_diamonds: attempt.entryDiamonds * base.bonus.boost_multiplier,
          },
        }
      : {}),
  };
};
let spinSerial = 0;
const receipt = (attempt: any) => receiptFrom(sample, attempt);
beforeEach(() => {
  ticket = 0;
  spinSerial = 0;
  backend.state.mockResolvedValue(state);
  backend.commit.mockImplementation(async () => nextTicket());
  backend.spin.mockImplementation(async (attempt) => receipt(attempt));
  backend.runBegin.mockImplementation(async (_club: string, spins: number) => ({
    ok: true,
    run_id: RUN_ID,
    spins,
    spins_done: 0,
  }));
  backend.runEnd.mockImplementation(async (run_id: string) => ({
    ok: true,
    run_id,
    spins_done: 0,
    pending_awards: [],
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
const ready = async () => {
  render(<DiamondWheelPage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
  );
};
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Every clock is fake from the first render: no countdown or retry is left
 * running on a real timer, and each wait below is measured, never slept. */
const readyOnFakeTimers = async () => {
  vi.useFakeTimers();
  render(<DiamondWheelPage />);
  await tick(0);
  expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
};
const saved = (): WheelPendingSpin => ({
  userId: 'player',
  clubId: sample.club_id!,
  mode: 'paid',
  commitId: 'd1000000-0000-4000-8000-00000000abcd',
  commitHash: 'b'.repeat(64),
  clientSeed: 'the-saved-seed',
  ticketId: null,
  contractVersion: 2,
  entryDiamonds: 100,
});
const startAuto = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
  fireEvent.click(screen.getByRole('button', { name: 'Auto Spin 5' }));
  // The run is declared at the server first; the runner presses once it is.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
/* A run's spin lands straight onto the tally: no reveal to dismiss (R18). */
const land = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
  });
};
/** A spin the player pressed lands on its reveal; its plate opens when the
 *  pop-open animation has played, which jsdom only ever reports on request. */
const landPressed = async () => {
  await land();
  await act(async () =>
    fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!)
  );
};
const settle = async (ms = 1200) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
describe('automatic spins and player-owned recovery', () => {
  it('finishes all five spins with a distinct sealed ticket after each complete reveal', async () => {
    await ready();
    vi.useFakeTimers();
    await startAuto();
    for (let i = 1; i <= 5; i++) {
      expect(backend.spin).toHaveBeenCalledTimes(i);
      await land();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
    }
    expect(backend.spin).toHaveBeenCalledTimes(5);
    expect(new Set(backend.spin.mock.calls.map(([a]) => a.commitId)).size).toBe(5);
    // The run was declared once, closed once, and summarised once.
    expect(backend.runBegin).toHaveBeenCalledTimes(1);
    expect(backend.runBegin).toHaveBeenCalledWith(sample.club_id, 5);
    expect(backend.runEnd).toHaveBeenCalledTimes(1);
    expect(backend.runEnd).toHaveBeenCalledWith(RUN_ID);
    const summary = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(
      within(summary).getByRole('list', { name: 'Prizes Won This Run' }).children
    ).toHaveLength(5);
    expect(within(summary).getByText('No Bonus Games This Run')).toBeInTheDocument();
    // Nothing toasted the prizes one by one (R8) and nothing navigated.
    expect(backend.toast.success).not.toHaveBeenCalled();
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.click(within(summary).getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('does not reuse the consumed ticket while the next ticket is delayed', async () => {
    await ready();
    let finish!: (v: unknown) => void;
    backend.commit.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    vi.useFakeTimers();
    await startAuto();
    await land();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(nextTicket());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(backend.spin).toHaveBeenCalledTimes(2);
    expect(backend.spin.mock.calls[1][0].commitId).not.toBe(backend.spin.mock.calls[0][0].commitId);
  });
  it('waits for the new availability quote before another automatic debit', async () => {
    await ready();
    let finish!: (v: unknown) => void;
    backend.state.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    vi.useFakeTimers();
    await startAuto();
    await land();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
    const unfunded = {
      ...state,
      available: false,
      reason: 'The Host Must Fund Every Prize Before A Spin',
    };
    backend.state.mockResolvedValue(unfunded);
    await act(async () => {
      finish(unfunded);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
    // The run stopped on the page's own blocker: closed at the server, and
    // the one spin it made is on the summary with the reason (R18).
    expect(backend.runEnd).toHaveBeenCalledWith(RUN_ID);
    const stopped = screen.getByRole('dialog', { name: 'Run Stopped' });
    expect(
      within(stopped).getByText('The Host Must Fund Every Prize Before A Spin')
    ).toBeInTheDocument();
    fireEvent.click(within(stopped).getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('The Host Must Fund Every Prize Before A Spin')).toBeInTheDocument();
  });
  it('refreshes a paused wheel without placing a spin and obtains its missing ticket', async () => {
    backend.state.mockResolvedValueOnce({
      ...state,
      available: false,
      reason: 'The Wheel Is Paused',
    });
    render(<DiamondWheelPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh Wheel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
    );
    expect(backend.spin).not.toHaveBeenCalled();
    expect(backend.commit).toHaveBeenCalledTimes(1);
  });
  it('reopens at a smaller funded amount when the entry page had no ticket', async () => {
    backend.state.mockResolvedValueOnce({
      ...state,
      available: false,
      reason: 'The Host Must Fund Every Prize Before A Spin',
    });
    render(<DiamondWheelPage />);
    fireEvent.click(await screen.findByRole('button', { name: '25', exact: true }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Spin 25', exact: true })).toBeEnabled()
    );
    expect(backend.spin).not.toHaveBeenCalled();
    expect(backend.commit).toHaveBeenCalledTimes(1);
  });
  it('keeps a real maintenance pause after refresh and enables play only after thaw', async () => {
    backend.state.mockResolvedValue({ ...state, frozen: true });
    render(<DiamondWheelPage />);
    const refresh = await screen.findByRole('button', { name: 'Refresh Wheel' });
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh Wheel' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeDisabled();
    expect(screen.getByText('The Platform Is In Its Maintenance Break')).toBeInTheDocument();
    backend.state.mockResolvedValue(state);
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
    );
    expect(backend.spin).not.toHaveBeenCalled();
  });
  it('stops the run after a failed next ticket and prepares the next spin by itself, without a debit', async () => {
    await ready();
    backend.commit.mockResolvedValueOnce({ ok: false });
    vi.useFakeTimers();
    await startAuto();
    await land();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
    /* The run stops into its summary with the page's own reason, and nobody is
       told to refresh: the page says what it is doing and does it (#5043). */
    const stopped = screen.getByRole('dialog', { name: 'Run Stopped' });
    expect(within(stopped).getByText('Preparing Your Next Spin')).toBeInTheDocument();
    fireEvent.click(within(stopped).getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Preparing Your Next Spin')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // The ticket came back by itself; the run stayed stopped, so nothing was debited.
    expect(screen.queryByText('Preparing Your Next Spin')).not.toBeInTheDocument();
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Auto Spin 5' })).toBeEnabled();
  });
  it('honors Stop while the next quote is pending', async () => {
    await ready();
    let finish!: (v: unknown) => void;
    backend.state.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    vi.useFakeTimers();
    await startAuto();
    await land();
    fireEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    await act(async () => {
      finish(state);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
  });
  it('an unknown spin is recovered by the page itself, with the original identity', async () => {
    // Review finding 9 (2026-09-21): this ran the 1s and 2s backoff on real
    // timers inside a 4s waitFor, under vitest's 5s test timeout. It now runs
    // on the fake clock from the first render and steps the schedule exactly.
    await readyOnFakeTimers();
    // Two dropped answers in a row: the page keeps resending the SAME saved
    // request (never a fresh wager) until the receipt lands. Nobody presses
    // anything - owner ruling 2026-09-21, no game may require a check.
    backend.spin
      .mockRejectedValueOnce(new Error('Connection Lost'))
      .mockRejectedValueOnce(new Error('Connection Lost Again'));
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await tick(0);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(backend.toast.error).toHaveBeenCalledTimes(1);
    expect(readWheelPending('player', sample.club_id!)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover Spin' })).not.toBeInTheDocument();
    // Its answer was lost, so the saved spin now predates the next send.
    expect(screen.getByRole('button', { name: 'Recovering Spin' })).toBeInTheDocument();
    expect(screen.getByText('Recovering Your Previous Spin.')).toBeInTheDocument();
    // useAutoSettle's schedule: one second after the first loss...
    await tick(999);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(backend.spin).toHaveBeenCalledTimes(2);
    // ...and two after the second.
    await tick(1999);
    expect(backend.spin).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(backend.spin).toHaveBeenCalledTimes(3);
    expect(backend.spin.mock.calls[1][0]).toEqual(backend.spin.mock.calls[0][0]);
    expect(backend.spin.mock.calls[2][0]).toEqual(backend.spin.mock.calls[0][0]);
    // One ticket for the whole episode: the saved spin never took a new one.
    expect(backend.commit).toHaveBeenCalledTimes(1);
    // The third answer is the receipt, so the wheel is spinning it.
    expect(screen.getByRole('button', { name: 'Land Wheel' })).toBeEnabled();
    // The loss was said once, not once per resend.
    expect(backend.toast.error).toHaveBeenCalledTimes(1);
  });
});

describe('the wheel says recovering only when it is one', () => {
  it('an ordinary spin in flight reads Spinning, never Recovering', async () => {
    await readyOnFakeTimers();
    let answer!: () => void;
    backend.spin.mockImplementationOnce(
      (attempt) =>
        new Promise((resolve) => {
          answer = () => resolve(receipt(attempt));
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await tick(0);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Spinning', exact: true })).toBeInTheDocument();
    expect(screen.queryAllByText(/Recover/)).toHaveLength(0);
    // A slow answer is not a lost one: nothing is resent while it is out.
    await tick(30_000);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText(/Recover/)).toHaveLength(0);
    await act(async () => answer());
    expect(screen.getByRole('button', { name: 'Land Wheel' })).toBeEnabled();
    expect(screen.queryAllByText(/Recover/)).toHaveLength(0);
    await landPressed();
    // A pressed spin's chips prize waits for Continue; then the spin is done.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await tick(0);
    expect(screen.queryAllByText(/Recover/)).toHaveLength(0);
    expect(readWheelPending('player', sample.club_id!)).toBeNull();
  });

  it('a saved spin found when the wheel opens says it is being recovered', async () => {
    saveWheelPending(saved());
    backend.spin.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    render(<DiamondWheelPage />);
    // The wheel opens, then the saved spin goes at once, on the first turn.
    await tick(0);
    await tick(0);
    // Sent again at once, with its own sealed identity, and named for what it is.
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(backend.spin.mock.calls[0][0]).toMatchObject({
      commitId: saved().commitId,
      clientSeed: 'the-saved-seed',
      entryDiamonds: 100,
    });
    expect(backend.commit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Recovering Spin' })).toBeInTheDocument();
    expect(screen.getByText('Recovering Your Previous Spin.')).toBeInTheDocument();
  });
});

describe('a failed read never leaves a spinner', () => {
  it('a spin amount whose quote fails is read again by the page itself', async () => {
    await readyOnFakeTimers();
    backend.state.mockRejectedValueOnce(new Error('Quote Lost'));
    fireEvent.click(screen.getByRole('button', { name: '500', exact: true }));
    await tick(0);
    // Review finding 5: this used to set a page error nothing retried. The
    // wheel stays on screen, keeps the chosen amount and says what it is doing.
    expect(screen.getByText('Preparing Your Next Spin')).toBeInTheDocument();
    expect(screen.queryByText('The Spin Amount Could Not Be Loaded')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spin 500', exact: true })).toBeDisabled();
    await tick(1000);
    expect(backend.state).toHaveBeenLastCalledWith('d1000000-0000-4000-8000-000000000003', 500);
    expect(screen.queryByText('Preparing Your Next Spin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spin 500', exact: true })).toBeEnabled();
    expect(backend.spin).not.toHaveBeenCalled();
  });

  it('keeps reading until the quote comes back, on the same schedule', async () => {
    await readyOnFakeTimers();
    backend.state
      .mockRejectedValueOnce(new Error('Quote Lost'))
      .mockRejectedValueOnce(new Error('Quote Lost Again'));
    fireEvent.click(screen.getByRole('button', { name: '1,000', exact: true }));
    await tick(0);
    await tick(1000);
    expect(screen.getByText('Preparing Your Next Spin')).toBeInTheDocument();
    await tick(2000);
    expect(screen.getByRole('button', { name: 'Spin 1,000', exact: true })).toBeEnabled();
    expect(backend.spin).not.toHaveBeenCalled();
  });

  it('accumulates bonus games won mid-run and plays them from the summary, one Play Game at a time', async () => {
    await ready();
    // Spins 2 and 4 win a game; the server queues them and keeps accepting spins.
    backend.spin.mockImplementation(async (attempt) =>
      backend.spin.mock.calls.length === 2 || backend.spin.mock.calls.length === 4
        ? receiptFrom(bonusSample, attempt)
        : receipt(attempt)
    );
    const awards: any[] = [];
    backend.state.mockImplementation(async () => ({ ...state, pending_awards: awards }));
    backend.runEnd.mockImplementation(async (run_id: string) => ({
      ok: true,
      run_id,
      spins_done: 5,
      pending_awards: awards,
    }));
    vi.useFakeTimers();
    await startAuto();
    for (let i = 1; i <= 5; i++) {
      expect(backend.spin).toHaveBeenCalledTimes(i);
      const landed = await backend.spin.mock.results[i - 1].value;
      if (landed.bonus) awards.push(landed.bonus);
      if (i < 5) expect(screen.getByText(/Won So Far/)).toBeInTheDocument();
      await land();
      if (i < 5) expect(screen.queryByRole('dialog')).toBeNull();
      expect(backend.navigate).not.toHaveBeenCalled();
      await settle();
    }
    expect(backend.spin).toHaveBeenCalledTimes(5);
    const summary = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(within(summary).getByText('2 Bonus Games To Play')).toBeInTheDocument();
    expect(
      within(summary).getByRole('list', { name: 'Bonus Games Won This Run' }).children
    ).toHaveLength(2);
    expect(
      within(summary).getByRole('list', { name: 'Prizes Won This Run' }).children
    ).toHaveLength(3);
    // Not Now leaves the games waiting in the visible queue card, never lost.
    fireEvent.click(within(summary).getByRole('button', { name: 'Not Now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('You Have 2 Bonus Games To Play')).toBeInTheDocument();
    expect(screen.getByText('Play Your Bonus Game Before Another Spin')).toBeInTheDocument();
    await settle(120_000);
    expect(backend.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Play Game' }));
    expect(backend.navigate).toHaveBeenCalledTimes(1);
    expect(backend.navigate).toHaveBeenCalledWith(
      `/clubs/club/plinko?wheelAward=${encodeURIComponent(awards[0].id)}`
    );
  });
  it('the summary Play Game opens the first queued game', async () => {
    await ready();
    const awards: any[] = [];
    backend.spin.mockImplementation(async (attempt) => {
      const landed = receiptFrom(bonusSample, attempt);
      awards.push(landed.bonus);
      return landed;
    });
    backend.runEnd.mockImplementation(async (run_id: string) => ({
      ok: true,
      run_id,
      spins_done: 5,
      pending_awards: awards,
    }));
    vi.useFakeTimers();
    await startAuto();
    for (let i = 1; i <= 5; i++) {
      await land();
      await settle();
    }
    // The server's queue is what the summary offers, oldest first.
    const summary = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(within(summary).getByText('5 Bonus Games To Play')).toBeInTheDocument();
    fireEvent.click(within(summary).getByRole('button', { name: 'Play Game' }));
    expect(backend.navigate).toHaveBeenCalledWith(
      `/clubs/club/plinko?wheelAward=${encodeURIComponent(awards[0].id)}`
    );
  });
  it('an Upgrade won mid-run pauses for the swipe on the ring, then the run resumes', async () => {
    await ready();
    let won: any = null;
    backend.spin.mockImplementation(async (attempt) => {
      if (backend.spin.mock.calls.length !== 1) return receipt(attempt);
      won = receiptFrom(upgradeSample, attempt);
      return won;
    });
    backend.runEnd.mockImplementation(async (run_id: string) => ({
      ok: true,
      run_id,
      spins_done: 5,
      pending_awards: [won.bonus],
    }));
    vi.useFakeTimers();
    await startAuto();
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await land();
    const stage = screen.getByRole('button', { name: 'Swipe Or Tap The Wheel To Spin' });
    expect(screen.getByRole('button', { name: 'Land Upgrade Wheel' })).toBeDisabled();
    await settle(120_000);
    expect(screen.getByRole('button', { name: 'Land Upgrade Wheel' })).toBeDisabled();
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 40, clientY: 0 });
    });
    expect(screen.getByRole('button', { name: 'Land Upgrade Wheel' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Land Upgrade Wheel' }));
    });
    await settle();
    expect(backend.spin).toHaveBeenCalledTimes(2);
    for (let i = 2; i <= 5; i++) {
      await land();
      await settle();
    }
    const summary = screen.getByRole('dialog', { name: 'Run Complete' });
    expect(within(summary).getByText('1 Bonus Game To Play')).toBeInTheDocument();
  });
  it('a run found open on load waits for Resume Run or End Run, and never resumes by itself', async () => {
    backend.state.mockResolvedValue({
      ...state,
      auto_run: { run_id: RUN_ID, spins: 10, spins_done: 4 },
    });
    render(<DiamondWheelPage />);
    const resume = await screen.findByRole('button', { name: 'Resume Run (6 Left)' });
    expect(screen.getByText('Resume Or End Your Run Below')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeDisabled();
    vi.useFakeTimers();
    await settle(120_000);
    expect(backend.spin).not.toHaveBeenCalled();
    expect(backend.runBegin).not.toHaveBeenCalled();
    fireEvent.click(resume);
    // The fifth spin follows the pause a resumed run owes, like any later spin.
    await settle(0);
    await settle(1200);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(backend.runBegin).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Spinning' })).toBeInTheDocument();
    expect(screen.getByText(/^Spin 5 Of 10\./)).toBeInTheDocument();
    for (let i = 5; i <= 10; i++) {
      await land();
      await settle();
    }
    expect(backend.spin).toHaveBeenCalledTimes(6);
    expect(backend.runEnd).toHaveBeenCalledWith(RUN_ID);
    expect(screen.getByRole('dialog', { name: 'Run Complete' })).toBeInTheDocument();
  });
  it('End Run closes the open run at the server and offers the games it left unplayed', async () => {
    const award = { ...bonusSample.bonus, id: 'd1000000-0000-4000-8000-000000009999' };
    backend.state.mockResolvedValue({
      ...state,
      auto_run: { run_id: RUN_ID, spins: 10, spins_done: 4 },
      pending_awards: [award],
    });
    backend.runEnd.mockResolvedValue({
      ok: true,
      run_id: RUN_ID,
      spins_done: 4,
      pending_awards: [award],
    });
    render(<DiamondWheelPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'End Run' }));
    await waitFor(() => expect(backend.runEnd).toHaveBeenCalledWith(RUN_ID));
    const summary = await screen.findByRole('dialog', { name: 'Run Complete' });
    expect(within(summary).getByText('1 Bonus Game To Play')).toBeInTheDocument();
    expect(backend.spin).not.toHaveBeenCalled();
    fireEvent.click(within(summary).getByRole('button', { name: 'Play Game' }));
    expect(backend.navigate).toHaveBeenCalledWith(`/clubs/club/plinko?wheelAward=${award.id}`);
  });
  it('a saved spin this build cannot read is discarded out loud instead of failing the page', async () => {
    localStorage.setItem(
      `diamond-wheel-pending:v1:player:${sample.club_id}`,
      '{"userId":"player"}'
    );
    await ready();
    expect(backend.toast.error).toHaveBeenCalledWith(
      'A Saved Spin Could Not Be Read. Your History Shows Every Spin.'
    );
    expect(localStorage.getItem(`diamond-wheel-pending:v1:player:${sample.club_id}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover Spin' })).toBeNull();
    expect(backend.spin).not.toHaveBeenCalled();
  });
  it('honours the server pause between spins inside a run', async () => {
    await ready();
    backend.state.mockImplementation(async () => ({
      ...state,
      player: { ...state.player, seconds_until_next: backend.spin.mock.calls.length ? 3 : 0 },
    }));
    vi.useFakeTimers();
    await startAuto();
    await land();
    await settle(1200);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Spin 2 Of 5' })).toBeDisabled();
    await settle(1000);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    await settle(3000);
    await settle(1200);
    expect(backend.spin).toHaveBeenCalledTimes(2);
  });
  it('a double tap on Auto Spin declares one run, and a refused run starts nothing', async () => {
    await ready();
    let finish!: (v: unknown) => void;
    backend.runBegin.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Run Off' }));
    const plate = screen.getByRole('button', { name: 'Auto Spin 5' });
    fireEvent.click(plate);
    fireEvent.click(plate);
    fireEvent.click(plate);
    await settle(0);
    expect(backend.runBegin).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ ok: false, error: 'Finish Your Bonus Game Before Another Spin' });
    });
    await settle(1200);
    expect(backend.spin).not.toHaveBeenCalled();
    expect(backend.toast.error).toHaveBeenCalledWith('Finish Your Bonus Game Before Another Spin');
    expect(screen.getByRole('button', { name: 'Auto Spin 5' })).toBeEnabled();
  });
  it('Stop mid-run closes the run and shows what it won so far', async () => {
    await ready();
    vi.useFakeTimers();
    await startAuto();
    await land();
    await settle();
    expect(backend.spin).toHaveBeenCalledTimes(2);
    await land();
    fireEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    await settle(3000);
    expect(backend.spin).toHaveBeenCalledTimes(2);
    expect(backend.runEnd).toHaveBeenCalledTimes(1);
    const stopped = screen.getByRole('dialog', { name: 'Run Stopped' });
    expect(within(stopped).getByText('Auto Spin Stopped')).toBeInTheDocument();
    expect(
      within(stopped).getByRole('list', { name: 'Prizes Won This Run' }).children
    ).toHaveLength(2);
  });
  it('leaving the page mid-run presses nothing more and leaves the run open at the server', async () => {
    await ready();
    vi.useFakeTimers();
    await startAuto();
    await land();
    cleanup();
    await settle(30_000);
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(backend.runEnd).not.toHaveBeenCalled();
  });
  /* Owner ruling 2026-09-21, R8: no slide-in toast repeats a spin's result.
     The reveal and the control panel notice carry it; errors still toast. */
  it('a single spin shows its result in the reveal and the notice, with no slide-in toast', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await waitFor(() => expect(backend.spin).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Land Wheel' }));
    const reveal = screen.getByRole('dialog');
    fireEvent.animationEnd(reveal.querySelector('[data-motion="keep"]')!);
    fireEvent.click(within(reveal).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/^You Won \S+ Chips?$/)).toBeInTheDocument();
    expect(backend.toast.success).not.toHaveBeenCalled();
    expect(backend.toast.info).not.toHaveBeenCalled();
  });
});
