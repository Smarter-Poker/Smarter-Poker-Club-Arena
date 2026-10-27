import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(path, 'utf8');
const files = readdirSync('supabase/migrations').filter((file) =>
  file.endsWith('_weekly_fee_preparation_starts_when_the_week_closes.sql')
);
const fixture = 'scripts/ci/fixtures/weekly-fee-preparation/';
type Change = { signature: string; replacements: string[][] };
type Owner = { signature: string; definition: string };
const changes: Change[] = JSON.parse(read(fixture + 'replacement-contracts.json'));
const owners: Owner[] = JSON.parse(read(fixture + 'original-owners.json'));
const scopeChange = changes.find((change) =>
  change.signature.includes('fn_process_weekly_accounting_scope(')
)!;
const before = owners.find(
  (owner) => 'public.' + owner.signature === scopeChange.signature
)!.definition;
const after = scopeChange.replacements.reduce((body, replacement) => {
  const [oldText, newText] = replacement.length === 2 ? replacement : replacement.slice(1);
  return body.split(oldText).join(newText);
}, before);
describe('Closed fees prepare before the four AM payment', () => {
  it('retains the original financial due guard and every money-stage statement', () => {
    expect(files).toHaveLength(1);
    const migration = read('supabase/migrations/' + files[0]);
    expect(migration).toContain('earned_fee_certification_in_progress');
    expect(migration).toContain('v_preparing_before_due');
    expect(migration).not.toMatch(/cron\.(schedule|alter_job|unschedule)\s*\(/);
    const unionMoney = (body: string) => {
      const start = body.indexOf('        IF EXISTS(SELECT 1 FROM public.rake_records rr');
      const end = body.indexOf('      EXCEPTION WHEN OTHERS THEN', start);
      return body.slice(start, end);
    };
    expect(unionMoney(after)).toBe(unionMoney(before));
    expect(after).toContain('IF v_now < v_due AND NOT v_preparing_before_due THEN EXIT; END IF;');
    expect(after).toContain('IF v_now<v_due AND NOT v_preparing_before_due THEN EXIT;END IF;');
    const runAt = JSON.parse(read(fixture + 'original-helpers.json')).find((owner: Owner) =>
      owner.signature.startsWith('fn_union_accounting_run_at(')
    );
    expect(runAt.definition).toContain("time '04:00'");
    expect(runAt.definition).toContain("'America/Chicago'");
  });
  it('enforces the actual owner/native clock, restart and source-refusal regression', () => {
    const ci = read('.github/workflows/unpaid-lightning-funding-contracts.yml');
    expect(ci).toContain('python3 -B scripts/ci/test-weekly-fee-preparation-postgres.py');
    const native = read('scripts/ci/test-weekly-fee-preparation-postgres.py');
    for (const proof of [
      'original_missing_fee_prefix_reproduces_whole_week_fallback',
      'actual_automatic_selector_and_recursive_visitor_prepare_before04',
      'actual04_financial_due_boundary_retained',
      'actual_DST_fall_week_closed02CST_payment04CST',
      'original_prefix_one_window_durable_restart',
      'source_refusal_precedes_fee_progress',
      'older_paid_book_does_not_withhold_current_fees_or_claim_old_book_complete',
      'actual_standalone02_preparation04_money_gate',
      'actual_original_scheduler_lock_refuses_competing_scope',
    ])
      expect(native).toContain(proof);
    expect(native).toContain('capacity qualification');
  });
});
