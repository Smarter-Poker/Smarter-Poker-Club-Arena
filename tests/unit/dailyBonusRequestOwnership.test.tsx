import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { DailyBonusStatus } from '../../src/services/DailyBonusService';
const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), claimAll: vi.fn(), account: 'first' }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (state: unknown) => unknown) => select({ user: { id: mocks.account } }),
}));
vi.mock('../../src/services/DailyBonusService', () => ({
  dailyBonusService: mocks,
  claimReasonText: () => 'Refused',
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/dailyBonusStatusError', () => ({
  reportDailyBonusStatusError: vi.fn(),
}));
import { useDailyBonus } from '../../src/components/daily-bonus/useDailyBonus';
const status = (streak = 1): DailyBonusStatus =>
  ({
    eligible: true,
    today: '2026-10-10',
    seconds_to_reset: 3600,
    reset_at: '2026-10-11T05:00:00Z',
    streak,
    tiles: [],
    week: [],
    tomorrow: [],
    boost: { active: false },
    shield: { held: 0, expires_at: null },
  }) as DailyBonusStatus;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.getStatus.mockReset();
  mocks.claimAll.mockReset();
  mocks.account = 'first';
});
it('does not let an older status failure hide a completed claim receipt', async () => {
  const older = deferred<DailyBonusStatus>();
  mocks.getStatus.mockResolvedValueOnce(status()).mockReturnValueOnce(older.promise);
  mocks.claimAll.mockResolvedValue({ success: true, results: [], status: status(2) });
  const hook = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(hook.result.current.status).not.toBeNull());
  let loading!: Promise<void>;
  act(() => {
    loading = hook.result.current.reload();
  });
  await act(async () => {
    await hook.result.current.claimAll();
  });
  await act(async () => {
    older.reject(new Error('Old Read Failed'));
    await loading;
  });
  expect(hook.result.current.status?.streak).toBe(2);
  expect(hook.result.current.loadError).toBeNull();
});
it('reads durable state after an unknown claim instead of sharing a pre-claim read', async () => {
  const older = deferred<DailyBonusStatus>();
  mocks.getStatus
    .mockResolvedValueOnce(status())
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(status(3));
  mocks.claimAll.mockRejectedValue(new Error('Response Lost'));
  const hook = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(hook.result.current.status).not.toBeNull());
  let loading!: Promise<void>;
  act(() => {
    loading = hook.result.current.reload();
  });
  let claim!: ReturnType<typeof hook.result.current.claimAll>;
  act(() => {
    claim = hook.result.current.claimAll();
  });
  await act(async () => {
    older.resolve(status());
    await loading;
    await claim;
  });
  expect(mocks.getStatus).toHaveBeenCalledTimes(3);
  expect(hook.result.current.status?.streak).toBe(3);
});
it('reloads for a changed account and ignores the previous account response', async () => {
  const older = deferred<DailyBonusStatus>();
  mocks.getStatus.mockReturnValueOnce(older.promise).mockResolvedValueOnce(status(7));
  const hook = renderHook(() => useDailyBonus(true));
  mocks.account = 'second';
  hook.rerender();
  await act(async () => {
    older.resolve(status(1));
  });
  await waitFor(() => expect(hook.result.current.status?.streak).toBe(7));
});
it('ignores a read started during a claim after its authoritative receipt arrives', async () => {
  const read = deferred<DailyBonusStatus>();
  const award = deferred<{ success: boolean; results: never[]; status: DailyBonusStatus }>();
  mocks.getStatus.mockResolvedValueOnce(status()).mockReturnValueOnce(read.promise);
  mocks.claimAll.mockReturnValue(award.promise);
  const hook = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(hook.result.current.status).not.toBeNull());
  let claim!: ReturnType<typeof hook.result.current.claimAll>;
  act(() => {
    claim = hook.result.current.claimAll();
  });
  let loading!: Promise<void>;
  act(() => {
    loading = hook.result.current.reload();
  });
  await act(async () => {
    award.resolve({ success: true, results: [], status: status(4) });
    await claim;
  });
  await act(async () => {
    read.resolve(status(1));
    await loading;
  });
  expect(hook.result.current.status?.streak).toBe(4);
  expect(hook.result.current.claimingSlot).toBeNull();
});
it('a previous account claim cannot replace the new account status or release its claim lock', async () => {
  const award = deferred<{ success: boolean; results: never[]; status: DailyBonusStatus }>();
  mocks.getStatus.mockResolvedValueOnce(status()).mockResolvedValueOnce(status(8));
  mocks.claimAll.mockReturnValueOnce(award.promise);
  const hook = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(hook.result.current.status).not.toBeNull());
  let claim!: ReturnType<typeof hook.result.current.claimAll>;
  act(() => {
    claim = hook.result.current.claimAll();
  });
  mocks.account = 'second';
  hook.rerender();
  await waitFor(() => expect(hook.result.current.status?.streak).toBe(8));
  await act(async () => {
    award.resolve({ success: true, results: [], status: status(2) });
    await claim;
  });
  expect(hook.result.current.status?.streak).toBe(8);
});
it('shares one synchronous claim lock across repeated taps', async () => {
  const award = deferred<{ success: boolean; results: never[]; status: DailyBonusStatus }>();
  mocks.getStatus.mockResolvedValue(status());
  mocks.claimAll.mockReturnValue(award.promise);
  const hook = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(hook.result.current.status).not.toBeNull());
  let claim!: ReturnType<typeof hook.result.current.claimAll>;
  act(() => {
    claim = hook.result.current.claimAll();
    void hook.result.current.claimAll();
  });
  expect(mocks.claimAll).toHaveBeenCalledTimes(1);
  await act(async () => {
    award.resolve({ success: true, results: [], status: status() });
    await claim;
  });
});
