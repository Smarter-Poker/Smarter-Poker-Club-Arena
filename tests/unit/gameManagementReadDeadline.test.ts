import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAME_MANAGEMENT_READ_TIMEOUT_MS,
  withGameManagementReadDeadline,
} from '../../src/lib/gameManagementReadDeadline';

afterEach(() => vi.useRealTimers());
describe('request-owned management authority deadline', () => {
  it('aborts an unresponsive read, rejects on budget and ignores its late answer', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    let finish!: (value: boolean) => void;
    const read = withGameManagementReadDeadline((s) => {
      signal = s;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const rejected = expect(read).rejects.toThrow('Management Access Could Not Be Verified');
    await vi.advanceTimersByTimeAsync(GAME_MANAGEMENT_READ_TIMEOUT_MS);
    await rejected;
    expect(signal.aborted).toBe(true);
    finish(true);
    await expect(read).rejects.toThrow('Management Access Could Not Be Verified');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves both genuine grants and refusals and cleans each request timer', async () => {
    vi.useFakeTimers();
    for (const allowed of [true, false]) {
      const result = { allowed, unionId: null };
      await expect(withGameManagementReadDeadline(() => Promise.resolve(result))).resolves.toBe(
        result
      );
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('retains rejection and allows a separate fresh read', async () => {
    vi.useFakeTimers();
    const error = new Error('Authorization Transport Refused');
    await expect(withGameManagementReadDeadline(() => Promise.reject(error))).rejects.toBe(error);
    await expect(withGameManagementReadDeadline(() => Promise.resolve(false))).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
