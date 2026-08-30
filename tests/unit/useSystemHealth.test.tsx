import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSystemHealth } from '../../src/hooks/useSystemHealth';

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ limit: mocks.limit }),
    }),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

describe('useSystemHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the live data circuit as operational after a successful probe', async () => {
    mocks.limit.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useSystemHealth());

    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.health).toEqual(
      expect.objectContaining({ status: 'ok', supabase: 'ok' })
    );
    expect(result.current.health?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports degradation and can retry the same authoritative probe', async () => {
    mocks.limit
      .mockResolvedValueOnce({ error: new Error('temporary outage') })
      .mockResolvedValueOnce({ error: null });
    const { result } = renderHook(() => useSystemHealth());

    await waitFor(() => expect(result.current.health?.status).toBe('degraded'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.health?.status).toBe('ok'));
    expect(mocks.limit).toHaveBeenCalledTimes(2);
  });
});
