/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — supabaseConnectionWatchdog
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * NOTE ON tests/unit/connection-watchdog.test.ts: that file's 21 tests run
 * against a `TestWatchdog` class re-implemented inside the test file, not
 * against this module. They pin the failure-counting and retry-interval maths,
 * which is useful, but they cannot catch a bug in the real code — and the real
 * code had one for as long as it has existed. The health check is the method
 * they do not model, so it is the method tested here, for real, with fetch
 * mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    getChannels: vi.fn().mockReturnValue([]),
  },
}));

import { supabaseConnectionWatchdog } from '../../src/utils/supabaseConnectionWatchdog';

/** The module exports a singleton; reach past `private` to drive it. */
const wd = supabaseConnectionWatchdog as unknown as {
  checkHealth(): Promise<void>;
  consecutiveFailures: number;
  isConnected: boolean;
  stop(): void;
};

const respondWith = (status: number) =>
  vi.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300 });

describe('supabaseConnectionWatchdog', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://certification.supabase.invalid');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_certification');
    wd.consecutiveFailures = 0;
    wd.isConnected = true;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    wd.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('should export supabaseConnectionWatchdog singleton', () => {
    expect(supabaseConnectionWatchdog).toBeDefined();
    expect(typeof supabaseConnectionWatchdog).toBe('object');
  });

  it('uses the successful GoTrue health route instead of the unauthorized REST root', async () => {
    const fetchMock = respondWith(200);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await wd.checkHealth();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://certification.supabase.invalid/auth/v1/health',
      expect.objectContaining({
        method: 'GET',
        headers: { apikey: 'sb_publishable_certification' },
      })
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/rest/v1/');
    expect(wd.consecutiveFailures).toBe(0);
    expect(wd.isConnected).toBe(true);
  });

  it.each([200, 204])('treats successful health status %i as connected', async (status) => {
    globalThis.fetch = respondWith(status) as unknown as typeof fetch;
    await wd.checkHealth();
    expect(wd.consecutiveFailures).toBe(0);
    expect(wd.isConnected).toBe(true);
  });

  it.each([401, 403, 429, 500, 502, 503, 504])(
    'treats health status %i as a failure',
    async (status) => {
      globalThis.fetch = respondWith(status) as unknown as typeof fetch;
      await wd.checkHealth();
      expect(wd.consecutiveFailures).toBe(1);
    }
  );

  it('treats a network error as a failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await wd.checkHealth();
    expect(wd.consecutiveFailures).toBe(1);
  });

  it('recovers: a successful health response after failures clears the counter', async () => {
    globalThis.fetch = respondWith(503) as unknown as typeof fetch;
    await wd.checkHealth();
    await wd.checkHealth();
    expect(wd.consecutiveFailures).toBe(2);

    globalThis.fetch = respondWith(200) as unknown as typeof fetch;
    await wd.checkHealth();
    expect(wd.consecutiveFailures).toBe(0);
    expect(wd.isConnected).toBe(true);
  });
});
