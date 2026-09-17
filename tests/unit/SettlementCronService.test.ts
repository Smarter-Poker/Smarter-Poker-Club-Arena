/** Source-only retirement regression; actual nested loader qualification remains required. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SettlementCronService } from '../../src/services/SettlementCronService';
import { supabase } from '../../src/lib/supabase';
import { masterBus } from '../../src/core/MasterBus';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('retired browser settlement authority', () => {
  it.each([undefined, { autoExecutePayouts: true, requireCanaryCheck: false, checkIntervalMs: 1 }])(
    'refuses startup and never schedules or issues a financial call',
    async (config) => {
      const timers = vi.getTimerCount();
      expect(() => SettlementCronService.start(config)).toThrow('Weekly Accounting Is Automatic');
      await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(timers);
      expect(supabase.rpc).not.toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
      expect(supabase.functions.invoke).not.toHaveBeenCalled();
      expect(masterBus.emit).not.toHaveBeenCalled();
    }
  );
  it('refuses direct close/canary entry without announcing completion or writing alerts', async () => {
    await expect(SettlementCronService.check()).rejects.toThrow('Weekly Accounting Is Automatic');
    await expect(SettlementCronService.runCanaryCheck()).rejects.toThrow(
      'Weekly Accounting Is Automatic'
    );
    SettlementCronService.stop();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it('provides no local-clock schedule or server success certificate', () => {
    vi.setSystemTime(new Date('2026-11-02T09:59:59Z'));
    expect(() => SettlementCronService.getNextMondayPayout()).toThrow();
    expect(() => SettlementCronService.getNextSundaySnapshot()).toThrow();
    expect(SettlementCronService.getStatus()).toEqual({
      state: 'browser_scheduler_retired',
      isRunning: false,
      lastCheckAt: null,
      nextCheckMs: null,
      nextSnapshotAt: null,
      nextPayoutAt: null,
    });
  });
});
