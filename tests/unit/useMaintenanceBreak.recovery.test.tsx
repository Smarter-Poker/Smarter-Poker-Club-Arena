import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
}));

import { useMaintenanceBreak } from '../../src/hooks/useMaintenanceBreak';
import { __resetServerClock } from '../../src/utils/serverClock';

describe('maintenance recovery stays truthful and reconnect-safe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T18:59:59.000Z'));
    __resetServerClock();
    mocks.rpc.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('replaces zero with recovery, renews only transport protection, and exits on an exact null row', async () => {
    let row: Record<string, unknown> | null = {
      phase: 'counting_down',
      break_ends_at: '2026-09-09T19:00:00.000Z',
      remaining_ms: 1_000,
      reason: 'Scheduled Engine Maintenance',
    };
    mocks.rpc.mockImplementation(async () => ({ data: row ? [row] : [], error: null }));

    const { result } = renderHook(() => useMaintenanceBreak());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.maintenanceBreak).toMatchObject({
      active: true,
      phase: 'counting_down',
      breakEndsAtMs: Date.parse('2026-09-09T19:00:00.000Z'),
      connectionProtectedUntilMs: Date.parse('2026-09-09T19:00:00.000Z'),
    });

    row = {
      phase: 'recovering',
      // The durable row retains the expired historical deadline. Recovery UI
      // must not turn that into a second visible countdown promise.
      break_ends_at: '2026-09-09T19:00:00.000Z',
      remaining_ms: 0,
      reason: 'Scheduled Engine Maintenance',
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.maintenanceBreak.active).toBe(true);
    expect(result.current.maintenanceBreak.phase).toBe('recovering');
    expect(result.current.maintenanceBreak.breakEndsAtMs).toBeNull();
    expect(result.current.maintenanceBreak.connectionProtectedUntilMs).toBeGreaterThan(Date.now());

    row = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.maintenanceBreak).toMatchObject({
      active: false,
      connectionProtectedUntilMs: null,
    });
  });

  it('does not let a late database response resurrect a socket-ended break', async () => {
    let resolveRead!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const { result } = renderHook(() => useMaintenanceBreak());
    await act(async () => {
      await Promise.resolve();
      void result.current.refreshFromDb(true);
      await Promise.resolve();
    });

    act(() => result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK_ENDED', {}));
    await act(async () => {
      resolveRead({
        data: [
          {
            phase: 'counting_down',
            break_ends_at: '2026-09-09T19:05:00.000Z',
            remaining_ms: 300_000,
          },
        ],
        error: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.maintenanceBreak.active).toBe(false);
  });

  it('advances a last-hand-only client to recovery when the countdown frame is lost', async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          phase: 'recovering',
          break_ends_at: '2026-09-09T19:00:00.000Z',
          remaining_ms: 0,
        },
      ],
      error: null,
    });
    const { result } = renderHook(() => useMaintenanceBreak());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK', {
        phase: 'last_hand',
        break_ends_at: Date.parse('2026-09-09T19:00:00.000Z'),
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.maintenanceBreak).toMatchObject({
      active: true,
      phase: 'recovering',
      breakEndsAtMs: null,
    });
  });

  it('returns unknown and retries instead of caching a failed database read as idle', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    const { result } = renderHook(() => useMaintenanceBreak());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK_ENDED', {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    const callsBeforeFailedReads = mocks.rpc.mock.calls.length;
    let refreshed: unknown = 'not-called';
    await act(async () => {
      refreshed = await result.current.refreshFromDb();
    });
    expect(refreshed).toBeNull();
    await act(async () => {
      refreshed = await result.current.refreshFromDb();
    });
    expect(refreshed).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledTimes(callsBeforeFailedReads + 2);
    expect(result.current.maintenanceBreak.active).toBe(false);
  });
});
