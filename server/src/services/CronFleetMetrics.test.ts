import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import { CronFleetMetrics, CRON_WINDOW_MINUTES } from './CronFleetMetrics.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const ok = (row: unknown) => ({ data: [row], error: null });

/** The fleet exactly as it stood when this was written. */
const live = {
  pg_cron_jobs: 125,
  pg_cron_active: 124,
  pg_cron_runs: 856,
  pg_cron_failures: 13,
  openclaw_jobs: 69,
  openclaw_stale: 4,
  openclaw_worst_silence_minutes: 26418.9,
};

describe('CronFleetMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the fleet at the numbers it actually had, including 18 days of silence', async () => {
    rpc.mockResolvedValue(ok(live));
    const m = new CronFleetMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).toContain('poker_cron_pg_jobs 125');
    expect(text).toContain('poker_cron_pg_failures 13');
    expect(text).toContain('poker_cron_openclaw_stale 4');
    expect(text).toContain('poker_cron_openclaw_worst_silence_minutes 26418.9');
  });

  it('asks for a 60-minute failure window', async () => {
    rpc.mockResolvedValue(ok(live));
    const m = new CronFleetMetrics();
    await m.refresh();
    expect(rpc.mock.calls[0][1]).toEqual({ p_window_minutes: CRON_WINDOW_MINUTES });
  });

  it('treats zero pg_cron jobs as a blind collector, not an idle platform', async () => {
    // 125 jobs are defined. Publishing "0 jobs, 0 failures" would be a green
    // board meaning the exact opposite of health.
    rpc.mockResolvedValue(ok({ ...live, pg_cron_jobs: 0, pg_cron_failures: 0 }));
    const m = new CronFleetMetrics();
    await m.refresh();

    expect(m.get().collectedAt).toBe(0);
    expect(m.toPrometheus().join('\n')).not.toContain('poker_cron_pg_jobs 0');
  });

  it('reports a healthy fleet as real zeros', async () => {
    rpc.mockResolvedValue(
      ok({ ...live, pg_cron_failures: 0, openclaw_stale: 0, openclaw_worst_silence_minutes: 3.2 })
    );
    const m = new CronFleetMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');
    expect(text).toContain('poker_cron_pg_failures 0');
    expect(text).toContain('poker_cron_openclaw_stale 0');
  });

  it('OMITS worst-silence when the view cannot supply it', async () => {
    rpc.mockResolvedValue(ok({ ...live, openclaw_worst_silence_minutes: null }));
    const m = new CronFleetMetrics();
    await m.refresh();
    expect(m.toPrometheus().join('\n')).not.toContain('poker_cron_openclaw_worst_silence_minutes');
  });

  it('is already firing before the first successful collection', () => {
    const m = new CronFleetMetrics();
    const text = m.toPrometheus().join('\n');
    expect(text).toContain('poker_cron_metrics_stale_seconds 86400');
    expect(text).not.toContain('poker_cron_pg_failures');
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    rpc.mockResolvedValue(ok(live));
    const m = new CronFleetMetrics();
    await m.refresh();

    rpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    await m.refresh();

    expect(m.toPrometheus().join('\n')).toContain('poker_cron_openclaw_stale 4');
  });

  it('survives a thrown RPC and reports once per outage', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'));
    const m = new CronFleetMetrics();
    await expect(m.refresh()).resolves.toBeUndefined();
    await m.refresh();
    expect(reportError).not.toHaveBeenCalled();
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('declares HELP and TYPE exactly once per metric family', async () => {
    rpc.mockResolvedValue(ok(live));
    const m = new CronFleetMetrics();
    await m.refresh();
    const families = m
      .toPrometheus()
      .filter((l) => l.startsWith('# TYPE '))
      .map((l) => l.split(' ')[2]);
    expect(new Set(families).size).toBe(families.length);
  });
});
