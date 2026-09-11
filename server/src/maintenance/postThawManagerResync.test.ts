import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POST_THAW_MANAGER_RESYNC_TIMEOUT_MS,
  resyncManagersAfterMaintenanceThaw,
} from './postThawManagerResync.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('post-thaw manager resync', () => {
  it('bounds a manager that never settles and isolates its failure', async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const errors: unknown[] = [];
    let started = false;
    const resync = resyncManagersAfterMaintenanceThaw(
      [
        {
          resyncAddOnPeriodAfterMaintenanceThaw: () => {
            started = true;
            return new Promise<void>(() => undefined);
          },
        },
      ],
      ctl.signal,
      (error) => errors.push(error)
    );

    await Promise.resolve();
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(POST_THAW_MANAGER_RESYNC_TIMEOUT_MS);
    await resync;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'maintenance_post_thaw_manager_resync_timeout' });
  });

  it('stops waiting on shutdown without reporting an operational failure', async () => {
    const ctl = new AbortController();
    const errors: unknown[] = [];
    const resync = resyncManagersAfterMaintenanceThaw(
      [{ resyncAddOnPeriodAfterMaintenanceThaw: () => new Promise<void>(() => undefined) }],
      ctl.signal,
      (error) => errors.push(error)
    );

    await Promise.resolve();
    ctl.abort(new Error('server stopping'));
    await resync;
    expect(errors).toEqual([]);
  });
});
