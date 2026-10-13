import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const p = 'scripts/qualification/original-flow-eligibility/';
const read = (s: string) => fs.readFileSync(s, 'utf8');
const before = read(p + 'before-flow.sql');
const after = read(p + 'after-flow.sql');
const old = `   FROM public.fn_union_pnl_prove_late_settlement(CASE WHEN q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' THEN q.ledger_id END) p`;
const qualified = `   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p`;
describe('An original flow enters only the proof its original category permits', () => {
  it('changes only the eligible late input; every other original branch remains byte-identical', () => {
    expect(before.split(old)).toHaveLength(2);
    expect(after).toBe(before.replace(old, qualified));
  });
  it('maintains exact helper call-work/economic qualification in directly triggered accounting CI', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('python3 ' + p + 'run-native.py --output');
    expect(ci).toContain('path: ${{ runner.temp }}/original-flow-eligibility/');
    const run = read(p + 'component-native.py');
    expect(run).toContain("b[0]['Actual Loops']==20039 and a[0]['Actual Loops']==32");
    expect(run).toContain("Decimal('125.70')");
    expect(run).toContain("Decimal('339.89')");
    expect(run).toContain("results['before']==results['after']");
  });
  it('preserves actual source40 generation/security and once-only predecessor guards', () => {
    const sql = read(
      'supabase/migrations/20261013084856_original_flow_proofs_run_only_for_their_eligible_receipts.sql'
    );
    expect(sql).toContain("'flow_eligibility_parent_history_refused'");
    expect(sql).toContain('cardinality(statements)=1');
    expect(sql).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    expect(sql).toContain('2f0091a1c85eb9f4ffadce1142ba31a4');
    expect(sql).toContain('flow_eligibility_source40_postimage_refused');
    expect(sql).toContain(after.trim());
  });
});
