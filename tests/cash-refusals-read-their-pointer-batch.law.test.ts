import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027164000_cash_refusals_read_the_compact_scope_set_once.sql',
  'utf8'
);
describe('cash refusals read their pointer batch', () => {
  it('guards the exact private original owner and its installed metadata', () => {
    expect(sql).toContain('294935a386ce126757330f577631dafe');
    expect(sql).toContain('b4ca57c875ff41b0879bcbadc7bcbb63');
    expect(sql.match(/\{postgres=X\/postgres\}/g)).toHaveLength(2);
    expect(sql).toContain('cash_refusal_scope_set_install_frozen');
    expect(sql).not.toMatch(
      /CREATE INDEX|GRANT |UPDATE public\.|INSERT INTO public\.|DELETE FROM public\.|cron\./
    );
  });
  it('deduplicates only the lookup keyset and rejoins the original blocked bag', () => {
    expect(sql).toContain('WITH blocked_work AS MATERIALIZED');
    expect(sql).toContain("WHERE status='blocked'");
    expect(sql).toContain('array_agg(DISTINCT receipt_id) FILTER(WHERE receipt_id IS NOT NULL)');
    expect(sql).toContain('x.id=ANY((SELECT ids FROM receipt_ids)::uuid[])');
    expect(sql).toContain('FROM blocked_work w JOIN scoped_receipts r ON r.id=w.receipt_id');
    expect(sql).toContain('NOT isfinite(x.earned_at)');
    expect(sql).toContain("x.scope->>'kind'='unknown'");
    expect(sql).toContain('ORDER BY r.rake_record_id');
  });
  it('runs actual old/new owner and guarded installer proof in maintained CI', () => {
    const ci = readFileSync('.github/workflows/weekly-refusal-cover.yml', 'utf8');
    expect(ci).toContain(
      'python3 -B scripts/ci/test-cash-refusal-pointer-batch-postgres.py --pg-bin "$PG_BIN" --scratch "${{ runner.temp }}"'
    );
    const native = readFileSync('scripts/ci/test-cash-refusal-pointer-batch-postgres.py', 'utf8');
    for (const proof of [
      'assert answers()==baseline',
      'forced_rollback',
      'empty_before',
      'work_before',
      "n['Heap Fetches']==0",
      'cash_refusal_scope_set_preimage_changed',
    ])
      expect(native).toContain(proof);
  });
});
