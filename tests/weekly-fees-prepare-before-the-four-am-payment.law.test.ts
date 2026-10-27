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
  it('advances the original nonfinancial R2/R3 proof owner after successful pre04 preparation for both scopes', () => {
    expect(after).toContain(
      'PERFORM public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end);'
    );
    expect(after).toContain(
      'PERFORM public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end);'
    );
    const originalPending = read(fixture + 'original-windows-pending.sql');
    expect(originalPending).toContain('public.fn_settle_accounting_commission_advance');
    expect(originalPending).toContain('public.fn_settle_accounting_rakeback_advance');
    expect(originalPending).not.toMatch(
      /INSERT INTO public\.chip_ledger|fn_settle_accounting_rakeback_stage/
    );
    const standaloneMoney = (body: string) => {
      const start = body.indexOf(
        '          PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_end);'
      );
      expect(start).toBeGreaterThan(0);
      return body.slice(start, body.indexOf('        EXCEPTION WHEN OTHERS THEN', start));
    };
    expect(standaloneMoney(after)).toBe(standaloneMoney(before));
    const native = read('scripts/ci/test-weekly-fee-preparation-postgres.py');
    for (const proof of [
      'frozen269f_reproduces_ready_pre04_scope_without_R2_R3_progress',
      'actual_windows_pending_pre04_union_advances_R2_then_R3_and_ready_no_money',
      'actual_windows_pending_pre04_standalone_advances_both_rounds_no_money',
      'actual_windows_pending_DST169hour_week_pre04_all85windows_no_money',
      'actual_original_deadline_refuses_ready_proofs_before_money',
    ])
      expect(native).toContain(proof);
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
