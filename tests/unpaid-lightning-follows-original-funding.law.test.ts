import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read(
  'supabase/migrations/20261026161532_unpaid_lightning_earnings_follow_the_original_funding_club.sql'
);
const native = read('scripts/ci/test-unpaid-lightning-funding-contracts-postgres.py');
const workflow = parse(read('.github/workflows/unpaid-lightning-funding-contracts.yml'));
const fixture = JSON.parse(read('scripts/ci/fixtures/unpaid-lightning-funding-contracts.json'));

describe('an unpaid Lightning earning follows its original funding witness', () => {
  it('admits only proven unpaid original requests and retains immutable evidence', () => {
    expect(migration).toContain("'funding_cash_admission_week_already_calculated_or_paid'");
    expect(migration).toContain("s.contract->'tiers' IS DISTINCT FROM '[]'::jsonb");
    expect(migration).toContain('source_id uuid PRIMARY KEY');
    expect(migration).toContain('original_contract jsonb NOT NULL');
    expect(migration).toContain('buyin_ledger jsonb NOT NULL');
    expect(migration).toContain('wallet_debit jsonb NOT NULL');
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON public.accounting_cash_funding_contract_admissions'
    );
    expect(migration).toContain(
      'BEFORE TRUNCATE ON public.accounting_cash_funding_contract_admissions'
    );
    expect(migration).toContain('IF matches<>1 OR funding IS NULL OR funding=s.club_id THEN');
    expect(migration).toContain("w.wallet_type='PLAYER' AND w.amount=l.amount");
    expect(migration).toContain("l.created_at=(p->>'seat_joined_at')::timestamptz");
    expect(migration).not.toMatch(
      /(?:UPDATE|DELETE FROM) public\.(?:accounting_cash_rake_sources|rake_attributions|agent_commissions)\b/
    );
    expect(migration).not.toMatch(/chip_balance|agent_wallet_balance|cron\.schedule/);
  });

  it('uses the original accrual restart, historical contract and commission writer', () => {
    for (const owner of [
      'fn_accounting_cash_commission_plan',
      'fn_accounting_earning_contract',
      'fn_post_accounting_commission_source',
    ]) {
      expect(migration).toContain(`public.${owner}(`);
      expect(
        fixture.definitions.some((entry: { signature: string }) =>
          entry.signature.startsWith(owner)
        )
      ).toBe(true);
    }
    expect(migration).toContain("current_setting('app.accounting_funding_contracts',true)");
    expect(migration).toContain('f.admitted_contract AS contract');
    expect(migration).toContain('f.funding_club_id AS club_id');
    expect(migration).toContain(
      'WHERE NOT EXISTS(SELECT FROM public.accounting_cash_funding_contract_admissions f WHERE f.source_id=s.id)'
    );
    expect(migration).toContain('UNION ALL');
    expect(migration).toContain(
      'ON public.accounting_cash_rake_sources(club_id,earned_at) INCLUDE(player_id,id)'
    );
    expect(migration).toContain("'funding_cash_admission_replay_conflict'");
    expect(migration).toContain("'funding_cash_admission_original_changed'");
    expect(migration).toContain("'funding_cash_admission_canonical_changed'");
    expect(native).toContain('assert all(snapshot(t)==h for t,h in before.items())');
    expect(native).toContain("'commission_amount':'0.08'");
    expect(native).toContain('concurrent.futures.ThreadPoolExecutor');
    expect(native).toContain("'funding_rollback_proved'");
  });

  it('executes PostgreSQL qualification for every migration and captured input', () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        'supabase/migrations/**',
        'scripts/ci/fixtures/unpaid-lightning-funding-contracts.json',
        'scripts/ci/fixtures/unpaid-atomic-cash-contract-columns.json',
        'scripts/ci/test-unpaid-lightning-funding-contracts-postgres.py',
        'tests/unpaid-lightning-follows-original-funding.law.test.ts',
      ])
    );
    const steps = workflow.jobs['unpaid-lightning-funding-contracts'].steps;
    expect(
      steps.some((step: { run?: string }) =>
        step.run?.includes('test-unpaid-lightning-funding-contracts-postgres.py')
      )
    ).toBe(true);
    expect(
      steps.some(
        (step: { env?: { PG_BIN?: string } }) => step.env?.PG_BIN === '/usr/lib/postgresql/17/bin'
      )
    ).toBe(true);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.admit_cash_funding_contracts(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role'
    );
  });
});

it('the historical correction reporter keeps exact native parity and runs in CI', () => {
  const source = read(
    'supabase/migrations/20261026212454_historical_club_corrections_rebuild_daily_reporting_once.sql'
  );
  expect(source).toContain('affected daily reporting keys as one set');
  expect(source).toContain('SUM(round(ra.rake_amount*100))::bigint');
  expect(source).toContain('EXCEPTION WHEN OTHERS');
  expect(source).not.toMatch(/DISABLE TRIGGER|chip_balance|agent_wallet_balance|cron.schedule/);
  expect(read('scripts/ci/test-daily-reporting-attribution-change-postgres.py')).toContain(
    'json.loads(actual)==json.loads(expected)'
  );
  expect(read('.github/workflows/unpaid-lightning-funding-contracts.yml')).toContain(
    'python3 -B scripts/ci/test-daily-reporting-attribution-change-postgres.py'
  );
});
