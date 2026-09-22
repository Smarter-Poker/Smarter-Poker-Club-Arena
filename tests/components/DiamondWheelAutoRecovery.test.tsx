vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const sample = receipts.find((r) => r.kind === 'wheel' && r.value.outcome?.kind === 'chips')!.value;
const state = {
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: sample.segments,
  pending_awards: [],
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
const receipt = (attempt: any) => ({
  ...sample,
  entry_value_diamonds: attempt.entryDiamonds,
  player_cost_diamonds: attempt.entryDiamonds,
  fairness: {
    ...sample.fairness,
    commit_id: attempt.commitId,
    server_seed_hash: attempt.commitHash,
    client_seed: attempt.clientSeed,
  },
});
beforeEach(() => {
  ticket = 0;
  backend.state.mockResolvedValue(state);
  backend.commit.mockImplementation(async () => nextTicket());
  backend.spin.mockImplementation(async (attempt) => receipt(attempt));
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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
const land = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Land Wheel' }));
  await act(async () =>
    fireEvent.animationEnd(screen.getByRole('dialog').querySelector('[data-motion="keep"]')!)
  );
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
    expect(backend.toast.success).toHaveBeenCalledWith('Auto Spin Finished: 5 Spins');
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
    await act(async () => {
      finish({
        ...state,
        available: false,
        reason: 'The Host Must Fund Every Prize Before A Spin',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
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
    // Nobody is told to refresh: the page says what it is doing and does it.
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
    await land();
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
});
