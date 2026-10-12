/**
 * A MISSED SNAPSHOT IS RETRIED, NOT PAGED (2026-10-03).
 *
 * Pinned on migration 20261003220245. The 19:10 Diamond snapshot never ran
 * (database restart 19:07-19:12), the trial balance found no snapshot in its
 * 75-minute window and read "incomplete", and the health watch paged a
 * critical. The books balanced. The trial balance now reaches back to the
 * newest stored snapshot, and a first 'unknown' files at warning while a
 * 'critical' or a repeated 'unknown' still files critical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003220245_a_missed_snapshot_is_retried_not_paged.sql'
  ),
  'utf8'
);

describe('a missed snapshot is retried, not paged', () => {
  it('is one transaction that edits only the pinned function texts', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain(
      "'public.fn_ca_diamond_health()',\n  '3ed2ac4e441befea2072b3c3e941b37e', '64b94d13476dd74cf8573de193cc14e2',"
    );
    expect(sql).toContain(
      "'public.fn_ca_diamond_health_watch()',\n  '382513c497c4b8d1defe2581d5840bd5', 'e5101ef5acb368d1ff88bbf7a0b67cf1',"
    );
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });

  it('measures from the newest stored snapshot when none is inside the window', () => {
    expect(sql).toMatch(
      /LEAST\(now\(\) - interval '75 minutes',\s+COALESCE\(\(SELECT max\(s\.taken_at\) FROM public\.ca_diamond_snapshots s\),\s+now\(\) - interval '75 minutes'\)\)\) x;/
    );
  });

  it('files a first unknown at warning and a critical or repeated unknown at critical', () => {
    expect(sql).toMatch(/WHERE d->>'status' = 'critical'\n\s+OR EXISTS/);
    expect(sql).toContain("p->>'status' IN ('unknown', 'critical')");
    expect(sql).toContain("r.read_at > now() - interval '3 hours'");
    expect(sql).toContain(
      "'DR0:health_critical', CASE WHEN v_persistent > 0 THEN 'critical' ELSE 'warning' END,"
    );
  });
});
