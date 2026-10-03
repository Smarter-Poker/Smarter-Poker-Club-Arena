/**
 * A FROZEN ENGINE MINUTE IS NOT A STUCK MINUTE (2026-10-03).
 *
 * Four tournament detectors file CRITICAL drift incidents by counting minutes
 * since something last happened, and the engine is frozen by design during
 * every declared maintenance break (hourly :55 -> :00-:04, plus each release
 * break). 2026-10-02 21:10: ten events decided at 20:53 were paid in the first
 * seconds after the second of two back-to-back breaks (20:55-21:02:29 and
 * 21:05:05-21:12:54) - ~20 wall minutes, 4.6 live minutes - and the
 * finished-but-not-completed detector paged a critical. 20:52: the orphaned
 * detector named two events "nobody is dealing" that were committing hands
 * that minute; their tournament lease row was absent for a moment.
 *
 * These assertions pin the narrow shape of the cure: live minutes are wall
 * minutes minus declared break intervals only; a wall-clock backstop still
 * pages a winner unpaid 45 minutes; no_lease needs an undealt event too; no
 * severity, schedule or money row changes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const FIX = migrationNamed('a_frozen_engine_minute_is_not_a_stuck_minute');
const HELPER = FIX.slice(
  FIX.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_engine_live_minutes('),
  FIX.indexOf('$fn$;')
);

describe('a frozen engine minute is not a stuck minute', () => {
  it('subtracts only declared maintenance breaks, merged so an overlap counts once', () => {
    expect(HELPER).toContain('FROM public.engine_maintenance_break_log b');
    expect(HELPER).toContain('FROM public.engine_maintenance_break m');
    expect(HELPER).toContain('WHERE m.enforce_freeze');
    expect(HELPER).toContain('range_agg(f.r * win.w)');
    expect(HELPER).toContain('Undeclared downtime is live time.');
    expect(HELPER).not.toMatch(/engine_table_leases|engine_tournament_leases|heartbeat/);
  });

  it('bounds a break in progress so a row that is never cleared cannot discount forever', () => {
    expect(HELPER).toContain("LEAST(p_to, o.started + interval '20 minutes')");
  });

  it('is not a definer function and is not callable by clients', () => {
    expect(HELPER).not.toMatch(/SECURITY DEFINER/);
    expect(FIX).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_engine_live_minutes(timestamptz, timestamptz) FROM anon, authenticated;'
    );
    expect(FIX).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_engine_live_minutes(timestamptz, timestamptz) TO service_role;'
    );
  });

  it('pages an unpaid winner on 15 live minutes, or on 45 wall-clock minutes whatever the breaks', () => {
    expect(FIX).toContain('WHERE w.live_minutes >= extract(epoch FROM v_cutoff) / 60.0');
    expect(FIX).toContain(
      "OR w.last_elimination < now() - GREATEST(v_cutoff * 3, interval '45 minutes');"
    );
    expect(FIX).toContain("'live_minutes', live_minutes,");
    expect(FIX).toContain("'frozen_minutes',");
  });

  it('keeps the first 200 characters of the alert message, which the incident bridge keys on', () => {
    expect(FIX).toContain(
      "|| 'and healthy tournaments settle within 20s of it (p99 over 4,242 events). '"
    );
    expect(FIX).not.toMatch(/'Tournament %s has one player or fewer left/);
  });

  it('calls an event orphaned only when nobody has dealt it either, measured to clock_timestamp()', () => {
    expect(FIX).toContain('FROM public.hand_atomic_commits hc');
    expect(FIX).toContain('ORDER BY hc.hand_number DESC');
    expect(FIX).toContain('clock_timestamp()) >= GREATEST(p_dwell_minutes, 1))');
    expect(FIX).toContain('OR (l.tournament_id IS NOT NULL AND l.heartbeat_at IS NULL)');
    expect(FIX).toContain(
      'OR l.heartbeat_at < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1)))$w$'
    );
  });

  it('keeps the wall prefilter on the absent-player and cannot-deal checks and adds the live one', () => {
    expect(FIX).toContain(
      'AND public.fn_ca_engine_live_minutes(a.lost_chair_at, now()) >= GREATEST(p_min_absent_minutes, 1)'
    );
    expect(FIX).toContain(
      'AND public.fn_ca_engine_live_minutes(e.last_change, now()) >= GREATEST(p_dwell_minutes, 1)'
    );
  });

  it('edits by exact anchors against measured preimages and is idempotent', () => {
    expect(FIX).toContain(
      "'fn_ca_tournament_finished_but_not_completed', 'ba367204fd36dc9a0034d56c960f4500'"
    );
    expect(FIX).toContain(
      "'fn_ca_orphaned_running_tournaments',         'ed7600565d0dd3573957e70ddb202f1b'"
    );
    expect(FIX).toContain(
      "'fn_ca_absent_tournament_players',            '29087f5ade3b9677605692048c65374c'"
    );
    expect(FIX).toContain(
      "'fn_ca_tables_that_cannot_deal',              'bd78d4c1db935ec06df350d85ba0a32d'"
    );
    expect(FIX).toContain('IF v_n <> 1 THEN');
    expect(FIX).toContain('already carries the change; skipping');
  });

  it('changes no severity, adds no job and carries live proofs', () => {
    const code = FIX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
    expect(code).not.toMatch(/cron\.schedule\s*\(/i);
    expect(code).not.toMatch(/'warning'|'info'/);
    expect(FIX.match(/^-- @live-proof: .+$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect([...FIX].filter((ch) => (ch.codePointAt(0) ?? 0) > 127)).toEqual([]);
  });
});
