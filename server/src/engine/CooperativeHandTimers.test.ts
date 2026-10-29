import { afterEach, describe, expect, it, vi } from 'vitest';
import { CooperativeHandTimers } from './CooperativeHandTimers.js';
afterEach(() => vi.useRealTimers());
describe('native hand timer residual custody', () => {
  it('preserves remaining time and callback identity through multiple owners', async () => {
    vi.useFakeTimers();
    const timers = new CooperativeHandTimers();
    const fire = vi.fn();
    timers.set(fire, 1000);
    await vi.advanceTimersByTimeAsync(300);
    timers.hold('one');
    timers.hold('two');
    await vi.advanceTimersByTimeAsync(300000);
    timers.release('foreign');
    timers.release('one');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fire).not.toHaveBeenCalled();
    timers.release('two');
    await vi.advanceTimersByTimeAsync(699);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });
  it('cancels by the original handle after rearming and supports timers born held', async () => {
    vi.useFakeTimers();
    const timers = new CooperativeHandTimers();
    timers.hold('one');
    const fire = vi.fn();
    const original = timers.set(fire, 1000);
    await vi.advanceTimersByTimeAsync(20000);
    timers.release('one');
    timers.clear(original);
    await vi.advanceTimersByTimeAsync(1001);
    expect(fire).not.toHaveBeenCalled();
  });
  it('shutdown retires original callbacks without executing them', async () => {
    vi.useFakeTimers();
    const timers = new CooperativeHandTimers();
    const fire = vi.fn();
    timers.set(fire, 10);
    timers.hold('one');
    timers.stop();
    timers.release('one');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fire).not.toHaveBeenCalled();
  });
});
