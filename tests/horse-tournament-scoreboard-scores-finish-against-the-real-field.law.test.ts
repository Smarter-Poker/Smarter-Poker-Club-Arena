import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The horse tournament scoreboard measured every finish as a win.
 *
 * fn_horse_tournament_daily_compile divided the finishing position by
 * t.current_players, which is 0 or 1 once a tournament is COMPLETED, so every
 * row took the "else 0" branch: finish_pct_sum = 0 for all 432,313 horse
 * entries in the 7 days to 2026-10-16. It also dropped satellite winners
 * (status 'winner', position NULL; rule carried from PR #7091).
 */
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20261017033522_horse_tournament_scoreboard_scores_finish_against_the_real_f.sql'
  ),
  'utf8'
);
const BODY = MIGRATION.slice(MIGRATION.indexOf('BEGIN;'));

describe('the horse tournament scoreboard scores finish against the real field', () => {
  it('never divides by current_players', () => {
    expect(BODY).not.toContain('current_players');
  });

  it('takes the field from every seat of the tournament, horse or human', () => {
    expect(BODY).toMatch(
      /field_ as \(\s*--[^\n]*\n\s*select tp\.tournament_id, count\(\*\)::int as field/
    );
    const field = BODY.slice(BODY.indexOf('field_ as ('), BODY.indexOf('rows_ as ('));
    expect(field).not.toContain('is_horse');
  });

  it('scores 0 for a win and 1 for first out', () => {
    expect(BODY).toContain('then (coalesce(tp.position, 1) - 1)::numeric');
    expect(BODY).toContain('/ (greatest(f.field, coalesce(tp.position, 1)) - 1)');
    expect(BODY).toContain('min(coalesce(tp.position, 1)) as best_finish');
  });

  it('keeps satellite winners that have no position', () => {
    expect(BODY).toContain("where (tp.position is not null or tp.status = 'winner')");
  });

  it('keeps the invested and won formulas the audit compares', () => {
    expect(BODY).toContain('+ coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)');
    expect(BODY).toContain(
      'sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) + coalesce(tp.mystery_bounty_value, 0)) as won'
    );
  });

  it('recompiles every day on the scoreboard, service_role only, in one transaction', () => {
    expect(BODY).toContain('select min(day) from public.horse_tournament_daily');
    expect(BODY).toContain('perform public.fn_horse_tournament_daily_compile(d);');
    expect(BODY).toContain(
      'REVOKE ALL ON FUNCTION public.fn_horse_tournament_daily_compile(date) FROM PUBLIC, anon, authenticated;'
    );
    expect(BODY).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_daily_compile(date) TO service_role;'
    );
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
