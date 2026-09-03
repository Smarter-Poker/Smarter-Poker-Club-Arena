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
    wd.consecutiveFailures = 0;
    wd.isConnected = true;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    wd.stop();
    vi.restoreAllMocks();
  });

  it('should export supabaseConnectionWatchdog singleton', () => {
    expect(supabaseConnectionWatchdog).toBeDefined();
    expect(typeof supabaseConnectionWatchdog).toBe('object');
  });

  /**
   * THE REGRESSION. `HEAD /rest/v1/` answers 401 to every caller — with the
   * legacy anon JWT, with the sb_publishable_ key, and with an Authorization
   * header alongside either (verified against production 2026-08-20).
   *
   * The check accepted 200 and 404 only, so it could never pass on any deploy.
   * Five failures at 5s/10s/20s put every client into markDisconnected()
   * within ~45s of load, and markConnected() — which is what re-subscribes
   * realtime channels and replays the offline queue — became unreachable.
   */
  it('treats 401 from the REST root as CONNECTED, not as a dropped connection', async () => {
    globalThis.fetch = respondWith(401) as unknown as typeof fetch;
    await wd.checkHealth();
    expect(wd.consecutiveFailures, '401 means the server answered us').toBe(0);
    expect(wd.isConnected).toBe(true);
  });

  it.each([200, 204, 400, 401, 403, 404, 405, 429])(
    'treats %i as connected — this is a connectivity check, not an authz check',
    async (status) => {
      globalThis.fetch = respondWith(status) as unknown as typeof fetch;
      await wd.checkHealth();
      expect(wd.consecutiveFailures).toBe(0);
      expect(wd.isConnected).toBe(true);
    }
  );

  it.each([500, 502, 503, 504])(
    'treats %i as a failure — the service itself is down',
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

  it('recovers: a 401 after failures clears the counter', async () => {
    globalThis.fetch = respondWith(503) as unknown as typeof fetch;
    await wd.checkHealth();
    await wd.checkHealth();
    expect(wd.consecutiveFailures).toBe(2);

    globalThis.fetch = respondWith(401) as unknown as typeof fetch;
    await wd.checkHealth();
    expect(wd.consecutiveFailures).toBe(0);
    expect(wd.isConnected).toBe(true);
  });
});
