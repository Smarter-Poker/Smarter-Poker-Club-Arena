import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ eq: vi.fn(), select: vi.fn(), from: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import { useReferralCount } from '../../src/hooks/useReferralCount';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
});
afterEach(cleanup);
describe('Referral count ownership', () => {
  it('reads the exact account total without creating a referral code', async () => {
    mocks.eq.mockResolvedValue({ count: 127, error: null });
    const { result } = renderHook(() => useReferralCount('account-a'));
    await waitFor(() => expect(result.current).toBe(127));
    expect(mocks.from).toHaveBeenCalledWith('referral_redemptions');
    expect(mocks.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(mocks.eq).toHaveBeenCalledWith('referrer_id', 'account-a');
  });
  it('preserves unknown on a refused read', async () => {
    mocks.eq.mockResolvedValue({ count: null, error: new Error('Refused') });
    const { result } = renderHook(() => useReferralCount('account-a'));
    await waitFor(() => expect(mocks.report).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
  it('clears the previous owner and refuses its late response', async () => {
    let finishA: (value: any) => void = () => {};
    mocks.eq.mockImplementation((_key, id) =>
      id === 'account-a'
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : Promise.resolve({ count: 9, error: null })
    );
    const { result, rerender } = renderHook(({ account }) => useReferralCount(account), {
      initialProps: { account: 'account-a' },
    });
    rerender({ account: 'account-b' });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(9));
    await act(async () => {
      finishA({ count: 777, error: null });
    });
    expect(result.current).toBe(9);
  });
});
