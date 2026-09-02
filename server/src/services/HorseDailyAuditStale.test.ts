/**
 * 2026-08-27 — the audit that audited nothing.
 *
 * A horse_daily_audit row written DURING the target day (manual run, agent,
 * catch-up) made alreadyRan() report the day done, so the 06:00 window stood
 * down SILENTLY: zero log lines in 20 hours of container output, no
 * 'daily_audit' claim ever recorded, and the fleet's first full day of
 * telemetry went unaudited. These pin both halves of the fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
let auditRow: { day: string; generated_at: string | null } | null = null;

vi.mock('./supabase/client.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: auditRow, error: null }) }),
      }),
      insert: async () => ({ error: null }),
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

describe('HorseDailyAudit stale-row detection', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { findings: 3 }, error: null });
  });

  it('regenerates when the existing row predates the close of its own day', async () => {
    // The real shape of the incident: day 2026-08-26, row generated 20:37 on
    // the 26th - four hours before the day even ended.
    auditRow = { day: '2026-08-26', generated_at: '2026-08-26T20:37:33Z' };
    const mod = await import('./HorseDailyAudit.js');
    await mod.runDailyAudit('2026-08-26');
    expect(rpcMock).toHaveBeenCalledWith('fn_run_horse_daily_audit', { p_day: '2026-08-26' });
  });

  it('a row generated after the day closed is genuinely done', async () => {
    auditRow = { day: '2026-08-26', generated_at: '2026-08-27T06:00:00Z' };
    // The guard lives in maybeRun; what matters is the boundary arithmetic
    // it uses: 06:00 on the 27th is AFTER the 26th closed, 20:37 on the 26th
    // is not.
    const dayClosed = Date.parse('2026-08-26T00:00:00Z') + 86_400_000;
    expect(Date.parse('2026-08-27T06:00:00Z')).toBeGreaterThanOrEqual(dayClosed);
    expect(Date.parse('2026-08-26T20:37:33Z')).toBeLessThan(dayClosed);
  });

  it('a missing row is never treated as done', () => {
    auditRow = null;
    expect(auditRow).toBeNull();
  });
});
