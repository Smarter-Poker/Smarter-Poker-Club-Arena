import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ca_chip_baseline was taken once (2026-08-27) and nothing adds a row for a
// member who joins later, so the Cashier Reconciliation Console showed every
// later member as "unverified" forever. The newest definition of the report
// must check those members from zero at the club's existing cutoff.
const dir = resolve(import.meta.dirname, '../supabase/migrations');
const latest = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) =>
    readFileSync(resolve(dir, f), 'utf8').includes(
      'CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report'
    )
  )
  .at(-1)!;
const body = readFileSync(resolve(dir, latest), 'utf8');
// Match complete CTE names: `cutoffs` must not match `report_cutoffs`.
function cte(name: string): string {
  const match = body.match(new RegExp(`\\b${name} AS MATERIALIZED \\([\\s\\S]*?\\n  \\),`));
  if (!match) throw new Error(`Missing conservation CTE: ${name}`);
  return match[0];
}

describe('cashier conservation report coverage', () => {
  it('plans cutoffs from the analyzed source without losing null or future cutoffs', () => {
    const cutoffs = cte('cutoffs');
    const reportCutoffs = cte('report_cutoffs');
    expect(reportCutoffs).toMatch(
      /SELECT DISTINCT taken_at FROM public\.ca_chip_baseline WHERE club_id=p_club_id/
    );
    expect(reportCutoffs).toContain('UNION ALL SELECT taken_at FROM club_origin');
    expect(cutoffs).toContain('SELECT taken_at FROM report_cutoffs');
    expect(reportCutoffs + cutoffs).not.toMatch(/FROM baselines|taken_at\s*(?:IS NOT NULL|<=|<)/);
  });

  it('checks members who joined after the baseline from zero at the same cutoff', () => {
    const baselines = cte('baselines');
    expect(baselines).toContain('UNION ALL');
    expect(baselines).toContain('SELECT m.user_id,0::numeric,f.taken_at');
    expect(baselines).toContain('m.joined_at>=f.taken_at');
    expect(baselines).toMatch(/min\(taken_at\) AS taken_at FROM report_cutoffs/);
  });
});
