import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (path: string) => readFileSync(path, 'utf8');
const fixture = 'scripts/ci/fixtures/weekly-cash-first-clubs';
const replacements = JSON.parse(read(`${fixture}/replacements.json`));
const migration = read(
  'supabase/migrations/20261017012658_weekly_coordinator_skips_redundant_earning_club_witnesses.sql'
);
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('weekly club discovery reuses an already accepted cash witness', () => {
  it('preserves every other byte of both complete qualified functions', () => {
    for (const pin of replacements) {
      const before = read(`${fixture}/${pin.kind}-before.sql`);
      const after = read(`${fixture}/${pin.kind}-after.sql`);
      expect(md5(before)).toBe(pin.before);
      expect(md5(after)).toBe(pin.after);
      expect(before.split(pin.old)).toHaveLength(2);
      expect(after).toBe(before.replace(pin.old, pin.new));
      expect(after.replace(pin.new, pin.old)).toBe(before);
      expect(migration).toContain(pin.old);
      expect(migration).toContain(pin.new);
    }
  });

  it('keeps fee-only clubs and NULL statement error behavior', () => {
    const helper = read(`${fixture}/helper-after.sql`);
    const statement = read(`${fixture}/statement-after.sql`);
    expect(helper).toContain('accepted_cash AS MATERIALIZED');
    expect(helper).toContain('tournament_candidates AS MATERIALIZED');
    expect(helper).toContain('NOT EXISTS(SELECT FROM accepted_cash ac WHERE ac.club_id=t.club_id)');
    expect(helper).toContain('FROM tournament_candidates t LEFT JOIN earning_cutoffs');
    expect(statement).toContain('AND s.club_id IS NULL');
    expect(statement).toContain('weekly_statement_period_missing_or_duplicated');
    expect(statement).toContain('club_weekly_statement_delivery_incomplete');
  });

  it('installs atomically with exact authority and preserves the sealed inventory', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration.match(/^-- @live-proof: /gm)).toHaveLength(1);
    for (const guard of [
      'operator_refused',
      'freeze_or_override_refused',
      'scheduler_owned',
      'history_replay',
      'inventory_seal_required',
      'view_drift',
      'helper_preimage_authority_refused',
      'statement_preimage_authority_refused',
      'exact_replacement_refused',
      'postimage_refused',
      'helper_installed_authority_refused',
      'statement_installed_authority_refused',
      'inventory_seal_changed',
    ]) {
      expect(migration).toContain(`weekly_club_reads_${guard}`);
    }
    expect(migration).toContain("p.proacl::text='{postgres=X/postgres}'");
    expect(migration).toContain("p.provolatile='s'");
    expect(migration).toContain("p.provolatile='v'");
    expect(migration).toContain("p.proconfig=ARRAY['search_path=public']");
    expect(migration).not.toMatch(/CREATE\s+INDEX|ALTER\s+FUNCTION|\bGRANT\b|\bREVOKE\b/i);
    expect(migration).not.toMatch(
      /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(?:chip_ledger|club_members|union_clubs|settlement_invoices|rakeback_periods|agent_commission_settlements)\b/i
    );
    const sealed = JSON.parse(read('scripts/ci/fixtures/inventory-proof-lifetime-sources.json'));
    const names = sealed.functions.map(
      (entry: { signature: string }) => entry.signature.split('(')[0]
    );
    expect(names).not.toContain('public.fn_accounting_week_clubs');
    expect(names).not.toContain('public.fn_issue_scope_weekly_accounting');
  });

  it('executes native whole-function and installer proof in the required accounting parent', () => {
    const invocation =
      "print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-cash-first-clubs-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))";
    expect(
      read('scripts/ci/test_launch_reset_floor.py')
        .split('\n')
        .filter((line) => line === invocation)
    ).toHaveLength(1);
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test_launch_reset_floor.py --candidate-migration'
    );
    const driver = read('scripts/ci/test-weekly-cash-first-clubs-postgres.py');
    expect(driver).toContain('independent_view_history_oracle=True');
    expect(driver).toContain('after_events==0');
    expect(driver).toContain('production_financial_operation_qualified=False');
  });
});
