/**
 * Production Alerts board incident: operational_alert_events id=15
 * (OpenClawJobsHaveGoneSilent). /cron/clawbot-orchestrator was correctly
 * removed from openclaw-cron-dispatcher.py's ALL_CRONS on 2026-09-16 when
 * World Hub PR #1812 retired the Sentry error-tracking provider -- the
 * orchestrator's only task was forwarding to it. But nobody added a row to
 * ca_retired_cron_jobs, the registry v_openclaw_job_staleness already checks
 * to exclude a deliberately-retired job, so the view spent eight days and
 * counting reporting a correctly-decommissioned job as newly gone stale.
 *
 * Verified live against production (2026-09-23) before writing the fix, in a
 * rolled-back probe: is_stale read true for /cron/clawbot-orchestrator before
 * the insert, and the job disappeared from the view entirely (no row at all)
 * immediately after -- the same exclusion this test pins by source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260923215300_a_retired_error_providers_orchestrator_stays_retired.sql'
  ),
  'utf8'
);

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

const SQL = executable(MIGRATION);

describe('a retired error provider\'s orchestrator stays retired', () => {
  it('is one migration transaction', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('registers exactly the retired job, by its real cron_execution_log job_name', () => {
    expect(SQL).toMatch(
      /INSERT INTO public\.ca_retired_cron_jobs \(job_name, retired_at, reason, replaced_by\)/
    );
    expect(SQL).toMatch(/'\/cron\/clawbot-orchestrator',/);
  });

  it('dates the retirement to the actual World Hub PR #1812 timestamp, not today', () => {
    expect(SQL).toMatch(/'2026-09-16 06:15:54\+00',/);
  });

  it('is idempotent against the job_name primary key', () => {
    expect(SQL).toMatch(/ON CONFLICT \(job_name\) DO NOTHING;/);
  });

  it('leaves replaced_by null -- the feature was decommissioned, not swapped for something else', () => {
    expect(SQL).toMatch(/\n\s*null\s*\n\)\s*\nON CONFLICT \(job_name\) DO NOTHING;/);
  });

  it('asserts both that the row installed and that the staleness view now excludes the job', () => {
    expect(SQL).toMatch(
      /SELECT 1 FROM public\.ca_retired_cron_jobs\s*\n\s*WHERE job_name = '\/cron\/clawbot-orchestrator'/
    );
    expect(SQL).toMatch(
      /SELECT 1 FROM public\.v_openclaw_job_staleness\s*\n\s*WHERE job_name = '\/cron\/clawbot-orchestrator'/
    );
    expect(SQL).toMatch(/RAISE EXCEPTION 'clawbot-orchestrator retirement row did not install';/);
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'clawbot-orchestrator is still visible to v_openclaw_job_staleness after registering it as retired';/
    );
  });

  it('cites the actual retirement source in the reason, so a future reader does not have to re-derive it', () => {
    expect(SQL).toMatch(/World Hub PR #1812/);
    expect(SQL).toMatch(/cb-01-sentry-triage/);
    expect(SQL).toMatch(/retired-error-provider\.test\.mjs/);
  });
});
