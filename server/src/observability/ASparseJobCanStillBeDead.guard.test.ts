/**
 * v_openclaw_job_staleness.is_stale required successes_30d >= 5 before it
 * would ever report true, so it could scale the staleness threshold to a
 * job's own cadence instead of one fixed number for every job. That guard
 * has no expiry: a job's successes_30d count only falls once the job stops
 * succeeding, so a job dead long enough always reads successes_30d < 5
 * eventually, and is_stale then reads false forever regardless of how long
 * the silence grows. Verified live against production (2026-09-23): four
 * real jobs sit in exactly that state, one of them (video-library-views,
 * 25.8 days silent) longer than the job currently driving the
 * OpenClawFleetLongSilence alert's own reported worst-silence figure.
 *
 * Board incident: operational_alert_events id=11 (OpenClawFleetLongSilence).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260923175730_a_sparse_job_can_still_be_dead.sql'
  ),
  'utf8'
);

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

const SQL = executable(MIGRATION);
const VIEW = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE VIEW public.v_openclaw_job_staleness'),
  SQL.indexOf('FROM agg a') + 'FROM agg a\n    LEFT JOIN p ON p.job_name = a.job_name;'.length
);

describe('a sparse job can still be dead', () => {
  it('is one migration transaction', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('keeps the cadence-aware branch for a job with real history byte-for-byte unchanged', () => {
    expect(VIEW).toMatch(
      /a\.successes_30d >= 5\s*\n\s*AND a\.silent_minutes::double precision > LEAST\(GREATEST\(2::double precision \* p\.p90_gap_minutes, 45::double precision\), 14400::double precision\)/
    );
  });

  it('adds an absolute silence ceiling that fires regardless of sample count', () => {
    expect(VIEW).toMatch(
      /OR a\.silent_minutes::double precision > 10080::double precision AS is_stale/
    );
  });

  it('leaves last_success_at, successes_30d, silent_minutes, p90_gap_minutes and threshold_minutes untouched', () => {
    expect(VIEW).toMatch(/a\.last_success_at,/);
    expect(VIEW).toMatch(/a\.successes_30d,/);
    expect(VIEW).toMatch(/round\(a\.silent_minutes, 2\) AS silent_minutes,/);
    expect(VIEW).toMatch(/round\(p\.p90_gap_minutes::numeric, 2\) AS p90_gap_minutes,/);
    expect(VIEW).toMatch(
      /round\(LEAST\(GREATEST\(2::double precision \* p\.p90_gap_minutes, 45::double precision\), 14400::double precision\)::numeric, 2\) AS threshold_minutes,/
    );
  });

  it('still excludes retired jobs and still looks only at real successes in the last 30 days', () => {
    expect(VIEW).toMatch(/cel\.status = 'success'::text/);
    expect(VIEW).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.ca_retired_cron_jobs r WHERE r\.job_name = cel\.job_name\)/
    );
    expect(VIEW).toMatch(/cel\.started_at > \(now\(\) - '30 days'::interval\)/);
  });

  it('10080 minutes (7 days) does not false-positive the two legitimately sparse jobs observed live', () => {
    // /cron/auto-settlement and /cron/auto-settlement-distribute: successes_30d=3
    // (< 5, so only the new absolute branch could catch them), each silent
    // ~2.3 days (3355.84 / 3345.84 minutes) against their own ~7-day natural
    // cadence. Both must stay under the new 10080-minute ceiling.
    const ceilingMinutes = 10080;
    expect(3355.84).toBeLessThan(ceilingMinutes);
    expect(3345.84).toBeLessThan(ceilingMinutes);
    // The four jobs this migration exists to catch must clear it.
    for (const silentMinutes of [24155.59, 35695.79, 35635.72, 37195.77]) {
      expect(silentMinutes).toBeGreaterThan(ceilingMinutes);
    }
  });
});
