/**
 * HORSE DAILY AUDIT scheduler — the run must call the SQL audit for the last
 * COMPLETE day and must never throw past its boundary (a failed audit is a
 * reportError, not an engine incident).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
vi.mock('./supabase/client.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: async () => ({ error: null }),
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

describe('HorseDailyAudit.runDailyAudit', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('audits yesterday (UTC) by default', async () => {
    rpcMock.mockResolvedValue({ data: { findings: 3 }, error: null });
    const { runDailyAudit } = await import('./HorseDailyAudit.js');
    await runDailyAudit();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0] as [string, { p_day: string }];
    expect(fn).toBe('fn_run_horse_daily_audit');
    const expected = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(args.p_day).toBe(expected);
  });

  it('a failed RPC reports, does not throw, and says it FAILED', async () => {
    // 2026-09-02: this used to assert `undefined`. Swallowing the failure
    // silently is what let the caller record the day as audited when it was
    // not - see NightlyJobRetryAfterFailure.test.ts. The contract is now a
    // boolean, and only `true` may close the day.
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { runDailyAudit } = await import('./HorseDailyAudit.js');
    await expect(runDailyAudit('2026-08-25')).resolves.toBe(false);
  });

  it('accepts an explicit day', async () => {
    rpcMock.mockResolvedValue({ data: { findings: 0 }, error: null });
    const { runDailyAudit } = await import('./HorseDailyAudit.js');
    await runDailyAudit('2026-08-20');
    const [, args] = rpcMock.mock.calls[0] as [string, { p_day: string }];
    expect(args.p_day).toBe('2026-08-20');
  });
});
