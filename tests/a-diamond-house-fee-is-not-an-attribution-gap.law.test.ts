import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const name = readdirSync(resolve(ROOT, 'supabase/migrations')).find((f) =>
  f.endsWith('_a_diamond_house_fee_is_not_an_attribution_gap.sql')
);
const SQL = readFileSync(resolve(ROOT, 'supabase/migrations', String(name)), 'utf8');
const RUNBOOK = readFileSync(resolve(ROOT, 'docs/runbooks/rake-attribution-backlog.md'), 'utf8');

/*
 * RakeAttributionBacklog fired on 144 Diamond Arena fees (destination
 * diamond_house) on 2026-10-17. A Diamond fee pays the Diamond house and owes
 * no VIP points, chip rakeback or commission, so "credited nobody" is its
 * designed outcome. The gauge counts chip gaps only; it must never lose one.
 */
describe('a Diamond house fee is not an attribution gap', () => {
  it('leaves out exactly the diamond_house destination', () => {
    expect(name).toBeDefined();
    expect(SQL).toContain("AND (r.destination IS DISTINCT FROM 'diamond_house'::text))");
    // Every verdict the view reported stays.
    for (const verdict of ['never_measured', 'attribution_threw', 'credited_nobody']) {
      expect(SQL).toContain(`'${verdict}'::text`);
    }
  });

  it('is pinned to the reviewed preimage and proves no chip gap is dropped', () => {
    expect(SQL).toContain("'316450d4ce44fa135965716cce6ab8e4'");
    expect(SQL).toContain("RAISE EXCEPTION 'DIAMOND_HOUSE_GAP: the view drops a chip gap'");
    expect(SQL).toMatch(/@live-proof: .*diamond_house.*v_tournament_rake_attribution_gaps/);
  });

  it('the runbook names the exclusion so nobody re-adds the alarm', () => {
    expect(RUNBOOK).toContain('diamond_house');
  });
});
