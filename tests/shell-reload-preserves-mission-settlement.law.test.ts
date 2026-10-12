import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../src/lib/readDeployedShell', () => ({ readDeployedShell: vi.fn() }));
vi.mock('../src/services/DailyChallengeService', () => ({
  DAILY_MISSION_REROLL_COST: 100,
  dailyChallengeService: {
    claimChallenges: vi.fn(),
    getDashboard: vi.fn(),
    buyStreakFreeze: vi.fn(),
    rerollChallenge: vi.fn(),
  },
}));
vi.mock('../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/lib/analytics', () => ({ capture: vi.fn() }));
vi.mock('../src/services/DailyMissionTelemetryService', () => ({
  dailyMissionReasonCode: () => 'unknown',
  recordDailyMissionOperation: vi.fn(),
}));
import { holdShellReload, isShellReloadBlocked } from '../src/lib/shellReloadBlocker';
import { useShellUpdateGate } from '../src/hooks/useShellUpdateGate';
import { useDailyMissionActions } from '../src/components/challenges/dashboard/useDailyMissionActions';
import { dailyChallengeService } from '../src/services/DailyChallengeService';
import { readDeployedShell } from '../src/lib/readDeployedShell';
import { masterBus } from '../src/core/MasterBus';
const challenge = { id: 'mission', tier: 'daily', challenge: { name: 'Mission' } } as any;
const paid = {
  claimedIds: ['mission'],
  alreadyClaimedIds: [],
  diamondsCredited: 2,
  challengeDiamonds: 2,
  milestoneDiamonds: 0,
  settlementDiamondBalance: 9,
} as any;
function useActions() {
  return useDailyMissionActions({
    userId: 'actor',
    diamondBalance: 6000,
    challenges: [challenge],
    setChallenges: vi.fn(),
    setRewardVault: vi.fn(),
    installDashboardProjection: vi.fn(),
    loadChallenges: vi.fn().mockResolvedValue(undefined),
    refs: { mutationEpochRef: { current: 0 }, diamondBalanceRef: { current: 7 } },
    isMountedRef: { current: true },
    toast: { info: vi.fn(), error: vi.fn() } as any,
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(isShellReloadBlocked()).toBe(false);
});
describe('shell reload preserves mission settlement', () => {
  it('keeps independent leases until each owner retires, with idempotent release', () => {
    const a = holdShellReload(),
      b = holdShellReload();
    a();
    a();
    expect(isShellReloadBlocked()).toBe(true);
    b();
    expect(isShellReloadBlocked()).toBe(false);
  });
  it.each(['single', 'all'])(
    'holds %s claim synchronously through dialog dismissal',
    async (mode) => {
      const pending = deferred<any>();
      vi.mocked(dailyChallengeService.claimChallenges).mockReturnValue(pending.promise);
      vi.mocked(dailyChallengeService.getDashboard).mockResolvedValue({
        vault: { items: [challenge] },
      } as any);
      const { result } = renderHook(useActions);
      let task!: Promise<void>;
      act(() => {
        task =
          mode === 'single'
            ? result.current.handleClaim(challenge)
            : result.current.handleClaimAll();
      });
      expect(isShellReloadBlocked()).toBe(true);
      await act(async () => {
        pending.resolve(paid);
        await task;
      });
      expect(dailyChallengeService.claimChallenges).toHaveBeenCalledExactlyOnceWith('actor', [
        'mission',
      ]);
      expect(result.current.reward).not.toBeNull();
      expect(isShellReloadBlocked()).toBe(true);
      act(() => result.current.setReward(null));
      expect(isShellReloadBlocked()).toBe(false);
    }
  );
  it.each(['empty', 'refused'])('releases claim-all when the vault is %s', async (mode) => {
    vi.mocked(dailyChallengeService.getDashboard).mockResolvedValue({
      vault: { items: mode === 'empty' ? [] : [challenge] },
    } as any);
    vi.mocked(dailyChallengeService.claimChallenges).mockRejectedValue(new Error('refused'));
    const { result } = renderHook(useActions);
    await act(() => result.current.handleClaimAll());
    expect(isShellReloadBlocked()).toBe(false);
    expect(result.current.reward).toBeNull();
    if (mode === 'empty') expect(dailyChallengeService.claimChallenges).not.toHaveBeenCalled();
  });
  it.each(['freeze', 'reroll'])(
    'protects %s spend until settlement and releases on success/refusal/error',
    async (mode) => {
      const call =
        mode === 'freeze'
          ? vi.mocked(dailyChallengeService.buyStreakFreeze)
          : vi.mocked(dailyChallengeService.rerollChallenge);
      for (const outcome of ['success', 'refused', 'error']) {
        const pending = deferred<any>();
        call.mockReturnValueOnce(pending.promise);
        const { result, unmount } = renderHook(useActions);
        let task!: Promise<void>;
        act(() => {
          task =
            mode === 'freeze'
              ? result.current.handleBuyFreeze()
              : result.current.handleReroll(challenge);
        });
        expect(isShellReloadBlocked()).toBe(true);
        await act(async () => {
          if (outcome === 'error') pending.resolve(Promise.reject(new Error('refused')));
          else pending.resolve({ success: outcome === 'success' });
          await task;
        });
        expect(isShellReloadBlocked()).toBe(false);
        unmount();
      }
    }
  );
  it('releases a refused claim and an unmounted pending claim without reacquiring on late completion', async () => {
    vi.mocked(dailyChallengeService.claimChallenges).mockRejectedValueOnce(new Error('refused'));
    const first = renderHook(useActions);
    await act(() => first.result.current.handleClaim(challenge));
    expect(isShellReloadBlocked()).toBe(false);
    first.unmount();
    const pending = deferred<any>();
    vi.mocked(dailyChallengeService.claimChallenges).mockReturnValueOnce(pending.promise);
    const next = renderHook(useActions);
    let task!: Promise<void>;
    act(() => {
      task = next.result.current.handleClaim(challenge);
    });
    next.unmount();
    expect(isShellReloadBlocked()).toBe(false);
    await act(async () => {
      pending.resolve(paid);
      await task;
    });
    expect(isShellReloadBlocked()).toBe(false);
  });
  it('rechecks a claim acquired after arming but before the settle timer', async () => {
    const entry = document.createElement('meta');
    entry.content = '/assets/index-old.js';
    document.head.appendChild(entry);
    vi.mocked(readDeployedShell).mockResolvedValue(
      '<script type="module" src="/assets/index-new.js"></script>'
    );
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.history.replaceState(null, '', '/hub/club-arena/daily-challenges');
    vi.spyOn(performance, 'now').mockReturnValue(20_000);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const { unmount } = renderHook(() => useShellUpdateGate());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const release = holdShellReload();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reload).not.toHaveBeenCalled();
    expect(getRegistration).toHaveBeenCalledTimes(1);
    release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    unmount();
    entry.remove();
  });
  it('rechecks a lease acquired during worker handover and adopts only after release on the existing poll', async () => {
    const entry = document.createElement('meta');
    entry.content = '/assets/index-old.js';
    document.head.appendChild(entry);
    vi.mocked(readDeployedShell).mockResolvedValue(
      '<script type="module" src="/assets/index-new.js"></script>'
    );
    const registration = deferred<any>();
    const getRegistration = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(registration.promise)
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.history.replaceState(null, '', '/hub/club-arena/daily-challenges');
    vi.spyOn(performance, 'now').mockReturnValue(20_000);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const { unmount } = renderHook(() => useShellUpdateGate());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(getRegistration).toHaveBeenCalledTimes(2);
    const release = holdShellReload();
    await act(async () => {
      registration.resolve(undefined);
      await Promise.resolve();
    });
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    expect(vi.mocked(masterBus.emit).mock.calls.some((c) => c[0] === 'SHELL_RELOADED')).toBe(false);
    release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    unmount();
    entry.remove();
  });
});
