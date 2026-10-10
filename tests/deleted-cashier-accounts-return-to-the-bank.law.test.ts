import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261010184827_deleted_accounts_cannot_receive_cashier_transfers.sql',
  'utf8'
);
describe('deleted cashier accounts return to the bank', () => {
  it('excludes authoritative deleted profiles without guessing from names or player type', () => {
    expect(sql).toContain("p.status='deleted'");
    expect(sql).not.toMatch(/is_horse|LIKE\s+'deleted/i);
  });
  it('locks custody, refuses browsers and freeze, and retains recorded bank movements', () => {
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('public.fn_platform_frozen()');
    expect(sql).toContain('FROM PUBLIC,anon,authenticated');
    expect(sql).toContain("'club_bank_claim','club_treasury'");
    expect(sql).toContain('INSERT INTO public.chip_transactions');
    expect(sql).not.toMatch(/DELETE FROM|UPDATE public.table_seats|cron\.schedule/i);
  });
  it('returns later credits and released holds inside the original transaction', () => {
    expect(sql).toContain('zzzz_deleted_profile_bank_return');
    expect(sql).toContain('zzzz_deleted_member_credit');
    expect(sql).toContain('NEW.held_chips<OLD.held_chips');
    expect(sql).toContain('zzzz_deleted_agent_credit');
    expect(sql).toContain("'app.cash_original_debit_ledger'");
  });
  it('enforces native database concurrency and conservation qualification in required CI', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('python3 scripts/ci/test-cashier-deleted-accounts.py');
    const native = readFileSync('scripts/ci/test-cashier-deleted-accounts.py', 'utf8');
    expect(native).toContain('concurrent-return-is-once');
    expect(native).toContain('repeat-does-not-move-money');
    expect(native).toContain('frozen-refuses-atomically');
    expect(native).toContain('deletion-transition-returns-existing-chips');
  });
});
