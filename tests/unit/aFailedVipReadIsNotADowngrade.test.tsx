/**
 * A FAILED VIP READ IS NOT A DOWNGRADE (2026-09-05)
 *
 * `vipService.checkVIPStatus` throws rather than answering "not VIP" when the
 * query errors, and its header explains why at length, citing the two times
 * this repo has already ruled against turning a failed read into a zero
 * (`WalletService.getPlayerBalance`, `useWalletStore.loadDiamonds`).
 *
 * `useVIPStatus` then caught that throw and wrote `false`. So one blip
 * stripped a paying member of every VIP-gated perk for the rest of the
 * session - silently, with no retry, and with no way for them to know. The
 * VIP all-in squeeze reads this hook, which is how it was found.
 *
 * Both pins below fail on the pre-fix hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../src/services/VIPService', () => ({
  FEATURE_PRICING: {},
  vipService: { isVIP: vi.fn(), checkVIPStatus: vi.fn() },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'u1' } }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
/* The bus handler is captured so a test can fire the REAL re-check path.
   `rerender()` alone does not: the effect's deps are [user?.id], so it never
   runs check() again and the downgrade branch is never reached. */
const busHandlers: Array<(e: { payload: { userId: string; category: string } }) => void> = [];
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (
      _evt: string,
      h: (e: { payload: { userId: string; category: string } }) => void
    ) => {
      busHandlers.push(h);
      return () => {};
    },
    emit: vi.fn(),
  },
}));

import { useVIPStatus } from '../../src/hooks/useVIP';
import { vipService } from '../../src/services/VIPService';

const isVIPMock = vipService.isVIP as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  isVIPMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useVIPStatus', () => {
  it('retries once before believing a failure', async () => {
    isVIPMock
      .mockRejectedValueOnce(new Error('VIP status unreadable: network'))
      .mockResolvedValue(true);
    const { result } = renderHook(() => useVIPStatus());
    await waitFor(() => expect(result.current.isVIP).toBe(true), { timeout: 3000 });
    expect(isVIPMock, 'the first answer never arrived, so ask again').toHaveBeenCalledTimes(2);
  });

  it('a member confirmed VIP is NOT un-confirmed by a later failed read', async () => {
    busHandlers.length = 0;
    isVIPMock.mockResolvedValue(true);
    const { result } = renderHook(() => useVIPStatus());
    await waitFor(() => expect(result.current.isVIP).toBe(true), { timeout: 3000 });

    // Every later read fails, and the re-check runs down the REAL path an
    // entitlement change takes.
    isVIPMock.mockRejectedValue(new Error('VIP status unreadable: blip'));
    expect(busHandlers.length, 'the hook subscribes for re-checks').toBeGreaterThan(0);
    for (const h of busHandlers) h({ payload: { userId: 'u1', category: 'vip' } });
    await new Promise((r) => setTimeout(r, 1400));
    expect(result.current.isVIP, 'a dropped packet is not a cancelled membership').toBe(true);
  });

  it('still grants nothing when the very first read never succeeds', async () => {
    isVIPMock.mockRejectedValue(new Error('VIP status unreadable: down'));
    const { result } = renderHook(() => useVIPStatus());
    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 3000 });
    expect(result.current.isVIP, 'fail CLOSED on a perk never confirmed').toBe(false);
  });
});
