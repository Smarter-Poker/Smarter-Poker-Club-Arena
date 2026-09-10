/**
 * THE CONSERVATION CHECK ALWAYS MEASURES (2026-09-10).
 *
 * fn_ca_trial_balance is the platform's global chip-conservation check - the
 * one thing that would notice chips appearing or vanishing anywhere in Club
 * Arena. It compared a snapshot window chosen by a CLOCK GUESS:
 *
 *     WHERE taken_at >= COALESCE(p_since, now() - interval '75 minutes')
 *
 * Snapshots are hourly at :05:00.9. The watch runs at :20:00.5. The window
 * therefore opened at :05:00.5 and cleared the snapshot by FOUR TENTHS OF A
 * SECOND - scheduler jitter decided whether the platform measured its own
 * chip conservation. Measured 2026-09-10: 168 cron runs in seven days
 * produced SIX readings (3.6%), and none at all before that day.
 *
 * It compounded: the watch files only when two CONSECUTIVE readings breach in
 * the same direction, and readings landing 3.6% of the time are almost never
 * adjacent - so the watch could effectively never fire. Both rules are
 * individually correct, which is why nobody caught it.
 *
 * These pin the property, not the phrasing: the window comes from the
 * snapshots, never from a clock, so a reading happens on every run.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');

function migrationNamed(slug: string): string {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
}

const SQL = migrationNamed('the_window_is_the_snapshots_not_a_clock_guess');

describe('the window comes from the snapshots', () => {
  it('takes the two most recent snapshots when no override is given', () => {
    expect(SQL).toContain('IF p_since IS NULL THEN');
    expect(SQL).toContain('WHERE taken_at < s1.taken_at ORDER BY taken_at DESC LIMIT 1;');
  });

  it('keeps p_since as an explicit override for ad-hoc queries', () => {
    expect(SQL).toContain('WHERE taken_at >= p_since ORDER BY taken_at ASC LIMIT 1;');
  });

  it('no longer defaults either function to a 75-minute clock guess', () => {
    // Inside the migration the old default is a SQL string literal, so its
    // quotes are doubled. It survives ONLY as the search anchor; a second
    // occurrence would mean the replacement put it back.
    const hits = SQL.split("DEFAULT (now() - ''01:15:00''::interval)").length - 1;
    expect(hits, 'the clock default should appear only as the anchor').toBe(1);
    expect(SQL).toContain('DEFAULT NULL::timestamp with time zone');
  });

  it('changes BOTH the check and the watch, or the watch keeps passing the old value down', () => {
    expect(SQL).toContain("p.proname='fn_ca_trial_balance'");
    expect(SQL).toContain("p.proname='fn_ca_trial_balance_watch'");
  });
});

describe('the migration proves the check can see', () => {
  it('refuses to finish unless all fourteen accounts read a difference', () => {
    expect(SQL).toContain('IF v_rows <> 14 OR v_nullrows <> 0 THEN');
    expect(SQL).toContain('it must read all 14 accounts');
  });

  it('refuses to finish if the watch kept the clock default', () => {
    expect(SQL).toContain('the watch still carries the old clock default');
  });

  it('asserts each anchor is unique before substituting', () => {
    expect(SQL).toMatch(/expected exactly 1/);
  });
});

describe('the measurement is written down beside the fix', () => {
  it('records the cadence and the offsets that made it a coin flip', () => {
    expect(SQL).toContain('FOUR TENTHS OF A');
    expect(SQL).toContain('3.6%');
  });
});
