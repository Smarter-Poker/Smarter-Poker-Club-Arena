/**
 * LAW: THE SEVEN-DAY EQUITY COVERAGE IS MEASURED ONCE AN HOUR (2026-10-04).
 *
 * ca_stats_witness_audit runs every 15 minutes (job 263) and its section 2f,
 * the seven-day all-in equity coverage, was 75-80% of every run (78.4 s of
 * ~100 s): about 7,500 s of database time a day for two counts that move by a
 * few seats an hour. 2f is now measured on the run in the first quarter of the
 * hour, or when no earlier reading exists, and otherwise carried forward from
 * the latest log row.
 *
 * What this pins: the two fragments replaced on the md5-pinned live text and
 * the pinned post-image; the carry reads the latest log row; the measure runs
 * when there is no reading, a NULL reading, or the first quarter of the hour;
 * the 2f statement itself is unchanged; no schedule changes; the proof ships.
 * scripts/ci/test-the-seven-day-equity-coverage-is-measured-once-an-hour.py
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261004003115_the_seven_day_equity_coverage_is_measured_once_an_hour.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function assigned(name: string): string {
  const m = MIG.match(new RegExp(`  ${name} := ((?:E'(?:[^'\\\\]|\\\\.)*'\\s*(?:\\|\\|\\s*)?)+);`));
  expect(m, `${name} is assigned`).not.toBeNull();
  return [...m![1].matchAll(/E'((?:[^'\\]|\\.)*)'/g)]
    .map((p) => p[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

describe('the seven-day equity coverage is measured once an hour', () => {
  it('is pinned before and after, one transaction, no schedule', () => {
    expect(MIG).toContain("md5(v_def) <> '0260f227fb49030f22a7e2019a755796'");
    expect(MIG).toContain("md5(v_after) <> '962ed3ca1dd6346e25d7a1c6edd7246e'");
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).not.toMatch(/cron\.(schedule|alter_job)/);
  });

  it('wraps the unchanged 2f statement in the hourly measure, carrying the latest reading otherwise', () => {
    const old1 = assigned('v_old1');
    const new1 = assigned('v_new1');
    const old2 = assigned('v_old2');
    const new2 = assigned('v_new2');
    expect(old1).toBe('  SELECT count(*) FILTER (WHERE x.has_eq OR NOT coalesce(x.betting_continued, true))::int,\n');
    expect(new1.endsWith(old1)).toBe(true);
    expect(new1).toContain('FROM public.ca_stats_witness_audit_log l');
    expect(new1).toContain('ORDER BY l.ran_at DESC, l.id DESC');
    expect(new1).toContain('INTO v_allin_sd, v_allin_sd_no_eq');
    expect(new1).toContain('IF NOT FOUND OR v_allin_sd IS NULL OR v_allin_sd_no_eq IS NULL');
    expect(new1).toContain('OR extract(minute FROM now()) < 15 THEN');
    expect(old2).toBe('    OFFSET 0\n  ) x;\n');
    expect(new2).toBe('    OFFSET 0\n  ) x;\n  END IF;\n');
  });

  it('ships the disposable-cluster proof', () => {
    expect(
      existsSync(resolve(process.cwd(), 'scripts/ci/test-the-seven-day-equity-coverage-is-measured-once-an-hour.py'))
    ).toBe(true);
  });
});
