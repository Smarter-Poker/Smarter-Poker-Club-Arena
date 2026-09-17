import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  rpc: vi.fn(),
  lobby: null as null | ((value: unknown) => void),
  status: null as null | ((value: string) => void),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/services/GameServerAPI', () => ({ getServerStatus: mocks.health }));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    onStatusChange: (callback: (value: string) => void) => {
      mocks.status = callback;
      return () => {};
    },
  },
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: {
    subscribeToLobby: ({ onMaintenance }: { onMaintenance: (value: unknown) => void }) => {
      mocks.lobby = onMaintenance;
      return () => {};
    },
  },
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
import { useMaintenanceBreak } from '../../src/hooks/useMaintenanceBreak';
const epoch = Date.parse('2026-09-17T10:00:00Z');
const event = (extra = {}) => ({
  active: true,
  phase: 'counting_down',
  break_id: epoch - 420000,
  break_ends_at: epoch + 1000,
  timestamp: Date.now(),
  ...extra,
});
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  mocks.health.mockReset().mockResolvedValue(null);
  mocks.rpc.mockReset().mockResolvedValue({ data: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('the countdown follows certified release', () => {
  it('keeps the break finalizing when the deadline expires during an outage', async () => {
    const h = renderHook(() => useMaintenanceBreak());
    await flush();
    act(() => h.result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK', event()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(h.result.current.maintenanceBreak).toMatchObject({ active: true, phase: 'finalizing' });
    expect(mocks.health).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.health).toHaveBeenCalledTimes(2);
  });
  it('does not let a delayed read restore a break after the end event', async () => {
    let resolve!: (value: unknown) => void;
    mocks.health.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const h = renderHook(() => useMaintenanceBreak());
    act(() => h.result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK_ENDED', event()));
    resolve({ maintenance: { presentation: event() } });
    await flush();
    expect(h.result.current.maintenanceBreak.active).toBe(false);
    act(() => h.result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK', event()));
    expect(h.result.current.maintenanceBreak.active).toBe(false);
  });
  it('accepts a fresh health release on reconnect and ignores an older break end', async () => {
    const h = renderHook(() => useMaintenanceBreak());
    await flush();
    act(() =>
      h.result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK', event({ break_id: epoch }))
    );
    act(() =>
      h.result.current.ingestMaintenanceEvent(
        'MAINTENANCE_BREAK_ENDED',
        event({ break_id: epoch - 1 })
      )
    );
    expect(h.result.current.maintenanceBreak.active).toBe(true);
    mocks.health.mockResolvedValue({
      maintenance: { presentation: event({ active: false, phase: 'idle', break_id: epoch }) },
    });
    act(() => mocks.status?.('connected'));
    await flush();
    expect(h.result.current.maintenanceBreak.active).toBe(false);
  });
  it('uses certified time and lobby transitions without reopening an already resumed table', async () => {
    const h = renderHook(() => useMaintenanceBreak('table'));
    await flush();
    act(() =>
      h.result.current.ingestMaintenanceEvent(
        'MAINTENANCE_BREAK',
        event({ break_ends_at: epoch + 5000 })
      )
    );
    expect(h.result.current.maintenanceBreak.breakEndsAtMs).toBe(epoch + 5000);
    act(() => h.result.current.ingestMaintenanceEvent('MAINTENANCE_BREAK_ENDED', event()));
    act(() => mocks.lobby?.(event({ phase: 'resuming' })));
    expect(h.result.current.maintenanceBreak.active).toBe(false);
    act(() => mocks.lobby?.(event({ phase: 'last_hand', break_id: epoch + 1 })));
    expect(h.result.current.maintenanceBreak.phase).toBe('last_hand');
  });
  it('keeps a newly loaded persisted expired break visible as finalizing', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ phase: 'counting_down', break_ends_at: new Date(epoch - 1000).toISOString() }],
    });
    const h = renderHook(() => useMaintenanceBreak());
    await flush();
    expect(h.result.current.maintenanceBreak).toMatchObject({ active: true, phase: 'finalizing' });
  });
});
