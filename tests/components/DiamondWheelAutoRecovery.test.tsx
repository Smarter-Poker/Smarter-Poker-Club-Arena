vi.mock('../../src/hooks/useLiveBonusGuard', () => ({ useLiveBonusGuard: () => () => {} }));
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';
import { readWheelPending } from '../../src/utils/wheelPendingSpin';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  spin: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', () => ({
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
});
const ready = async () => {
  render(<DiamondWheelPage />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled()
  );
};
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
  it('stops after a failed next ticket and lets the player refresh without an automatic debit', async () => {
    await ready();
    backend.commit.mockResolvedValueOnce({ ok: false });
    vi.useFakeTimers();
    await startAuto();
    await land();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(backend.spin).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('The Next Spin Could Not Be Prepared. Refresh The Wheel To Retry.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Wheel' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
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
  it('refresh preserves an unknown spin and Recover Spin submits the original identity', async () => {
    await ready();
    backend.spin.mockRejectedValueOnce(new Error('Connection Lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
    await waitFor(() => expect(backend.toast.error).toHaveBeenCalled());
    const saved = readWheelPending('player', sample.club_id!);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Wheel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh Wheel' })).toBeEnabled()
    );
    expect(readWheelPending('player', sample.club_id!)).toEqual(saved);
    expect(backend.commit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Recover Spin' }));
    await waitFor(() => expect(backend.spin).toHaveBeenCalledTimes(2));
    expect(backend.spin.mock.calls[1][0]).toEqual(backend.spin.mock.calls[0][0]);
  });
});
