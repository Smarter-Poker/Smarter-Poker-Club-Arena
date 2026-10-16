import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The horse tournament scoreboard dropped every satellite winner.
 *
 * fn_horse_tournament_daily_compile kept only tournament_players rows with a
 * position. A satellite seat/ticket/cash winner finishes with status 'winner'
 * and position NULL, so the 7 days to 2026-10-15 scored 5,723 losing entries
 * (prize 25,200.50) and none of the 2,975 winners (prize 164,900.00):
 * SATELLITE ROI -81.1%, when the real figure, counting both, is -9.2% (the
 * 10% fee). Found by the 2026-10-15 daily horse audit analysis.
 */
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20261016103322_horse_tournament_scoreboard_counts_satellite_winners.sql'
  ),
  'utf8'
);

describe('the horse tournament scoreboard counts satellite winners', () => {
  it('keeps a winner that has no position', () => {
    expect(MIGRATION).toContain("and (tp.position is not null or tp.status = 'winner')");
    expect(MIGRATION).not.toMatch(/and tp\.position is not null\s*\n\s*group by/);
  });

  it('scores a positionless winner as first, not as last or as missing', () => {
    expect(MIGRATION).toContain(
      '(coalesce(tp.position, 1) - 1)::numeric / (t.current_players - 1)'
    );
    expect(MIGRATION).toContain('min(coalesce(tp.position, 1)) as best_finish');
  });

  it('keeps the invested and won formulas the audit compares', () => {
    expect(MIGRATION).toContain('+ coalesce(tp.rebuys, 0) * coalesce(t.rebuy_cost, 0)');
    expect(MIGRATION).toContain(
      'sum(coalesce(tp.prize, 0) + coalesce(tp.bounty_winnings, 0) + coalesce(tp.mystery_bounty_value, 0)) as won'
    );
  });

  it('backfills from the first positionless winner through the audited day', () => {
    expect(MIGRATION).toContain("generate_series('2026-09-18'::date, '2026-10-15'::date");
    expect(MIGRATION).toContain('perform public.fn_horse_tournament_daily_compile(d);');
  });

  it('is service_role only and runs in one transaction', () => {
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.fn_horse_tournament_daily_compile(date) FROM PUBLIC, anon, authenticated;'
    );
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_horse_tournament_daily_compile(date) TO service_role;'
    );
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
