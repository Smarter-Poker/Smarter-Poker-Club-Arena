import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 14 capture counted terminal gaps as unfinished work forever.
 * On 2026-10-17, 254 source_expired gaps + 2 queued filled the 256-slot cap,
 * so every new capture request was refused as capture_queue_full.
 */
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20261017040330_horse_capture_terminal_gaps_free_their_slots.sql'
  ),
  'utf8'
);
const OPEN_ALIASED =
  "(w.state<>'gap' OR (w.reason='source_budget_exceeded' AND coalesce(w.slice_through_ms,w.through_ms)-coalesce(w.cursor_ms,w.from_ms)>1))";
const OPEN =
  "(state<>'gap' OR (reason='source_budget_exceeded' AND coalesce(slice_through_ms,through_ms)-coalesce(cursor_ms,from_ms)>1))";
const fnBody = (name: string): string => {
  const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  expect(start).toBeGreaterThan(-1);
  const end = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION', start + 10);
  return MIGRATION.slice(start, end === -1 ? undefined : end);
};
const count = (s: string, sub: string): number => s.split(sub).length - 1;

describe('horse capture terminal gaps free their slots', () => {
  it('admission counts only work that can still run', () => {
    expect(fnBody('fn_admit_horse_observation_capture')).toContain(
      "WHERE w.state NOT IN ('admitted','captured') AND " + OPEN_ALIASED + ' LIMIT 257'
    );
  });

  it('discovery counts occupancy the same way at both of its checks', () => {
    const body = fnBody('fn_discover_horse_observation_requests');
    expect(
      count(body, "WHERE state NOT IN ('admitted','captured') AND " + OPEN + ' LIMIT 257')
    ).toBe(2);
    expect(count(body, "WHERE state NOT IN ('admitted','captured') LIMIT 257")).toBe(0);
  });

  it('health bounds the same open set, so its invariants still hold', () => {
    expect(fnBody('fn_horse_learning_work_health')).toContain(
      "WHERE state NOT IN ('admitted','captured') AND " + OPEN + ' LIMIT 257'
    );
  });

  it('prune retires terminal gaps on the 32-day retention, receipts first', () => {
    const body = fnBody('fn_prune_horse_observation_captures');
    expect(body).toContain(
      "OR (w.state='gap' AND NOT " +
        OPEN_ALIASED +
        " AND w.created_at<clock_timestamp()-interval '32 days'))"
    );
    expect(body).toContain('ORDER BY coalesce(w.admitted_at,w.created_at),w.request_key LIMIT 100');
    expect(body.indexOf('DELETE FROM public.horse_observation_capture_receipts')).toBeLessThan(
      body.indexOf('DELETE FROM public.horse_observation_capture_work')
    );
  });

  it('records each base body and runs in one transaction', () => {
    expect(count(MIGRATION, 'rebuilt from the installed body, md5(prosrc)')).toBe(4);
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
