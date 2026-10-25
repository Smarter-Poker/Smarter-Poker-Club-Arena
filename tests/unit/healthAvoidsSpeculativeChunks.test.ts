import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_BASE_URL } from '../../src/lib/appBase';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('public health checks do not download member pages speculatively', () => {
  it('schedules nothing on either health URL and preserves preloading after navigation', async () => {
    vi.resetModules();
    const schedule = vi.fn();
    vi.stubGlobal('requestIdleCallback', schedule);
    const { preloadCriticalChunks } = await import('../../src/utils/ChunkPreloader');
    for (const suffix of ['health', 'health/']) {
      window.history.replaceState({}, '', `${APP_BASE_URL}${suffix}`);
      preloadCriticalChunks();
      expect(schedule).not.toHaveBeenCalled();
    }
    window.history.replaceState({}, '', `${APP_BASE_URL}clubs/example`);
    preloadCriticalChunks();
    expect(schedule).toHaveBeenCalledTimes(1);
    preloadCriticalChunks();
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
