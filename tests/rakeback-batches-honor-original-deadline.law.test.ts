import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('Rakeback batches retain the original close deadline', () => {
  it('changes only the original batch stop and retains installer authority', () => {
    const sql = readFileSync(
      'supabase/migrations/20261027175926_rakeback_batches_honor_the_original_close_deadline.sql',
      'utf8'
    );
    expect(sql).toContain('b07dc0dc2bdfa00973b4613e0cfb83d5');
    expect(sql).toContain(
      "CASE WHEN v_batched THEN LEAST(clock_timestamp()+interval ''90 seconds''"
    );
    expect(sql).toContain('app.weekly_accounting_scope_deadline');
    expect(sql).toContain("ELSE clock_timestamp()+interval ''90 seconds'' END;");
    expect(sql).toContain('after_meta IS DISTINCT FROM before_meta');
    expect(sql).not.toMatch(/UPDATE public\.|INSERT INTO public\.|DELETE FROM public\./i);
    expect(readFileSync('scripts/dev/test-agent-accounting-statements.sh', 'utf8')).toContain(
      'test-rakeback-original-deadline-postgres.py'
    );
  });
});
