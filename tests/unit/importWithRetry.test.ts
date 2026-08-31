import { describe, expect, it, vi } from 'vitest';

import { importWithRetry, isChunkLoadError } from '../../src/utils/lazyWithRetry';

describe('deferred import recovery', () => {
  it('recognizes browser and bundler stale-chunk failures', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed'))).toBe(true);
    expect(
      isChunkLoadError(Object.assign(new Error('load failed'), { name: 'ChunkLoadError' }))
    ).toBe(true);
    expect(isChunkLoadError(new Error('module initialized with invalid state'))).toBe(false);
  });

  it('recovers when an asset becomes available during a publish', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<{ ready: boolean }>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ ready: true });

    const pending = importWithRetry(load, 3, 10);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ ready: true });
    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not hide or retry a genuine module failure', async () => {
    const failure = new Error('module initialized with invalid state');
    const load = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(importWithRetry(load, 4, 0)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledOnce();
  });
});
