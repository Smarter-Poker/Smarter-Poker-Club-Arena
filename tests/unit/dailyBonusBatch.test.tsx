import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), claimAll: vi.fn() }));
vi.mock('../../src/services/DailyBonusService', async () => ({
  ...(await vi.importActual('../../src/services/DailyBonusService')),
  dailyBonusService: mocks,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useDailyBonus } from '../../src/components/daily-bonus/useDailyBonus';
const base: any = {
  eligible: true,
  today: '2026-10-10',
  seconds_to_reset: 3600,
  tiles: [],
  boost: { active: false },
  shield: { held: 0 },
  unclaimed: 2,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue(base);
});
it('single flights a same-turn double click and applies the authoritative full receipt', async () => {
  let resolve!: (value: any) => void;
  mocks.claimAll.mockReturnValue(new Promise((r) => (resolve = r)));
  const { result } = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(result.current.status).toBeTruthy());
  let first!: Promise<any>;
  let second!: Promise<any>;
  act(() => {
    first = result.current.claimAll();
    second = result.current.claimAll();
  });
  expect(mocks.claimAll).toHaveBeenCalledTimes(1);
  const next = {
    ...base,
    unclaimed: 0,
    claimed_today: true,
    tiles: [
      { slot: 1, claimed: true },
      { slot: 2, claimed: true },
    ],
  };
  await act(async () => {
    resolve({ success: true, results: [], status: next });
    await first;
    await second;
  });
  expect(result.current.status).toEqual(next);
  expect(result.current.claimingSlot).toBeNull();
});
it('reads durable status after an unknown transport result before allowing retry', async () => {
  mocks.claimAll.mockRejectedValue(new Error('network'));
  const next = { ...base, unclaimed: 0, claimed_today: true };
  const { result } = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(result.current.status).toBeTruthy());
  mocks.getStatus.mockResolvedValue(next);
  await act(async () => {
    await result.current.claimAll();
  });
  expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  expect(result.current.status).toEqual(next);
});
it('does not apply a batch response to an unmounted sheet', async () => {
  let resolve!: (value: any) => void;
  mocks.claimAll.mockReturnValue(new Promise((r) => (resolve = r)));
  const { result, unmount } = renderHook(() => useDailyBonus(true));
  await waitFor(() => expect(result.current.status).toBeTruthy());
  let claim!: Promise<any>;
  act(() => {
    claim = result.current.claimAll();
  });
  unmount();
  resolve({ success: true, status: { ...base, unclaimed: 0 } });
  expect(await claim).toBeNull();
});
