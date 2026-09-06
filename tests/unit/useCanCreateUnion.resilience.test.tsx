import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  reportError: vi.fn(),
  userId: 'user-1' as string | null,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

import { useCanCreateUnion, useCanOperateUnionNetwork } from '../../src/hooks/useCanCreateUnion';

describe('union capability reads survive transient production transport failures', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.reportError.mockReset();
    mocks.userId = 'user-1';
  });

  it('retries the read-only network permission RPC before surfacing an error', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: new TypeError('Failed to fetch') })
      .mockResolvedValueOnce({ data: true, error: null });

    const { result } = renderHook(() => useCanOperateUnionNetwork());

    await waitFor(() => expect(result.current.checking).toBe(false), { timeout: 3_000 });
    expect(result.current.canOperateUnionNetwork).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'fn_can_i_operate_the_union_network');
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'fn_can_i_operate_the_union_network');
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('also protects the create-union capability read without changing its answer', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ data: true, error: null });

    const { result } = renderHook(() => useCanCreateUnion());

    await waitFor(() => expect(result.current.checking).toBe(false), { timeout: 3_000 });
    expect(result.current.canCreateUnion).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('still fails closed and reports once after every safe read attempt fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new TypeError('Failed to fetch') });

    const { result } = renderHook(() => useCanOperateUnionNetwork());

    await waitFor(() => expect(result.current.checking).toBe(false), { timeout: 4_000 });
    expect(result.current.canOperateUnionNetwork).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to fetch' }),
      'useCanOperateUnionNetwork'
    );
  });

  it('stops a pending retry without reporting after the consumer unmounts', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new TypeError('Failed to fetch') });

    const { unmount } = renderHook(() => useCanOperateUnionNetwork());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('keeps an authoritative false answer denied without treating it as an error', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const { result } = renderHook(() => useCanCreateUnion());

    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.canCreateUnion).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('does not ask the server or offer either capability while signed out', async () => {
    mocks.userId = null;

    const create = renderHook(() => useCanCreateUnion());
    const operate = renderHook(() => useCanOperateUnionNetwork());

    await waitFor(() => {
      expect(create.result.current.checking).toBe(false);
      expect(operate.result.current.checking).toBe(false);
    });
    expect(create.result.current.canCreateUnion).toBe(false);
    expect(operate.result.current.canOperateUnionNetwork).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
