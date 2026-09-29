import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * BOARD PRODUCERS MEASURE WHAT THEY NAME (2026-09-26).
 *
 * Three drift-board producers reported a real-looking number for the wrong
 * thing, and one alarm fired for three days without being able to say what it
 * was seeing:
 *
 *   - fn_tournament_chip_conservation_check called a starting stack that was
 *     never issued (a late registrant never given a chair) "chip drift -30,000";
 *   - fn_ca_absent_tournament_players could not see that registrant at all,
 *     because it only counted chairs that were LOST;
 *   - fn_ca_tables_that_cannot_deal clocked "stuck for" from the newest
 *     seating, so an event thinned by busts twelve minutes ago read as stuck
 *     for eight days;
 *   - MttPlayStopped counted stalled MTTs with no denominator and was always
 *     on, so the whole tournament fleet stopping looked like every other day.
 */
const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const MIGRATION = 'supabase/migrations/20260926023322_board_producers_measure_what_they_name.sql';
const sql = read(MIGRATION);

function body(fn: string): string {
  const start = sql.search(new RegExp(`FUNCTION public\\.${fn}\\(`));
  expect(start, `${fn} is defined in ${MIGRATION}`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + 1);
  return sql.slice(open, close);
}

describe('board producers measure what they name', () => {
  it('is one transaction with a lock timeout', () => {
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
  });

  it('does not call a stack that was never issued a stack that was lost', () => {
    const b = body('fn_tournament_chip_conservation_check');
    expect(b).toMatch(
      /fn_ca_tournament_chip_supply\(t\.id\)\s*--[\s\S]*?-\s*COALESCE\(t\.starting_chips/
    );
    expect(b).toMatch(/tp\.status = 'registered'/);
    expect(b).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.table_seats s/);
  });

  it('leaves the shared supply definition alone, because seating guards read it', () => {
    expect(sql).not.toMatch(/FUNCTION\s+public\.fn_ca_tournament_chip_supply\s*\(/);
  });

  it('reports a chair that was never given, clocked from registration', () => {
    const b = body('fn_ca_absent_tournament_players');
    expect(b).toMatch(/THEN p\.registered_at END\) AS lost_chair_at/);
  });

  it('clocks a table shape from its latest bust as well as its latest seating', () => {
    const b = body('fn_ca_tables_that_cannot_deal');
    expect(b).toMatch(/max\(v\.left_at\)/);
  });

  it('publishes the denominator the stalled count never had', () => {
    const b = body('fn_tournament_progress_metrics');
    expect(sql).toMatch(
      /RETURNS TABLE\(stalled_running integer, overdue_breaks integer, progressing_running integer\)/
    );
    expect(b).toMatch(/AND EXISTS \(\s*SELECT 1 FROM public\.hand_history h/);
    // Grants restored exactly after the DROP.
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_tournament_progress_metrics\(integer, integer\) TO service_role;/
    );
    expect(sql).toMatch(/FROM PUBLIC, anon, authenticated;/);
  });

  it('alarms on the share of the fleet that deals, behind the break guard', () => {
    const rules = read('infra/monitoring/tournament-rules.yml');
    const at = rules.indexOf('- alert: MttFleetNotDealing');
    expect(at).toBeGreaterThan(0);
    const rule = rules.slice(at, rules.indexOf('- alert:', at + 10));
    expect(rule).toMatch(/poker_mtt_progressing_running\s*\/\s*clamp_min\(/);
    expect(rule).toMatch(/\)\s*<\s*0\.25/);
    expect(rule).toMatch(/>=\s*10/);
    expect(rule).toMatch(
      /unless on\(\) max_over_time\(poker_maintenance_break_active\[6m\]\) == 1/
    );
    expect(rule).toMatch(/severity: critical/);
    // The threshold carries its measurement (CLAUDE.md 10.84).
    const before = rules.slice(Math.max(0, at - 2500), at);
    expect(before).toMatch(/0\.13/);
    expect(before).toMatch(/0\.53/);
  });

  it('the engine emits the series the rule reads, and only when the database answered', () => {
    const metrics = read('server/src/services/TournamentMetrics.ts');
    expect(metrics).toMatch(/poker_mtt_progressing_running \$\{s\.progressingRunning\}/);
    expect(metrics).toMatch(/s\.progressingRunning === null/);
  });
});
