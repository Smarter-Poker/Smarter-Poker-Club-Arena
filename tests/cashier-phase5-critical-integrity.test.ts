import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260830235990_cashier_claim_back_cent_integrity.sql'),
  'utf8'
);
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('cashier Phase 1 critical integrity contracts', () => {
  it('rejects sub-cent claim amounts before either wallet can move', () => {
    expect(migration).toContain('p_amount <> round(p_amount, 2)');
    expect(migration).toContain('v_remaining := trunc(v_remaining_exact, 2)');
    expect(migration).toMatch(/if p_amount is not null[\s\S]+perform pg_advisory_xact_lock/);
  });

  it('binds every replay key to its original send and explicit amount', () => {
    expect(migration).toContain("metadata ->> 'original_transaction_id'");
    expect(migration).toContain('v_prior.amount is distinct from p_amount');
    expect(migration).toContain('That Retry Key Belongs To A Different Claim Back');
  });

  it('asks the server for all safe cents and reports the returned amount', () => {
    const start = page.indexOf("supabase.rpc('fn_agent_wallet_claim_back'");
    const end = page.indexOf('});', start);
    const call = page.slice(start, end + 3);
    expect(call).toContain('p_amount: null');
    expect(page).toContain('const claimedAmount = Number(res.amount) || 0');
    expect(page).toContain('fmt(claimedAmount)');
  });

  it('recreates all three browser balance guards during a clean replay', () => {
    expect(migration).toContain(
      'create or replace function public.fn_block_browser_balance_writes'
    );
    expect(migration).toContain(
      'create or replace function public.fn_block_browser_balance_inserts'
    );
    expect(migration).toContain('create trigger trg_block_browser_balance_inserts');
    expect(migration).toContain('create trigger trg_block_browser_balance_writes');
    expect(migration).toContain('create trigger trg_block_browser_treasury_writes');
    expect(migration).not.toMatch(/select\s+1\s*;/i);
  });
});

describe('cashier Phase 5 production certification contracts', () => {
  it('runs an exact live database contract canary after every successful publish', () => {
    const workflow = source('.github/workflows/post-deploy-e2e.yml');
    const canary = source('scripts/verification-harness/cashier-release-contract.sql');
    const runner = source('scripts/verification-harness/certify-cashier-contract.mjs');
    const stepStart = workflow.indexOf('- name: Certify the live cashier database contract');
    const stepEnd = workflow.indexOf('\n      - name:', stepStart + 1);
    const databaseContractStep = workflow.slice(stepStart, stepEnd);
    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(workflow).toContain('node scripts/verification-harness/certify-cashier-contract.mjs');
    /**
     * THE CERTIFICATION IS THE NODE RUNNER, NOT A RAW psql CALL - inside THIS
     * STEP. The pin used to read the whole workflow, and main went red on it
     * (2026-09-05, #3217, commit 05dd513de): the same pull request that moved
     * the certification onto the runner also added an "Ensure PostgreSQL
     * client is available" step, because the estate runner carries the
     * Playwright libraries but not the PostgreSQL client and the contract died
     * with `psql: command not found` before a single assertion ran. That step
     * ends with `psql --version`, an indented line beginning with the word,
     * and the pin fired on it. A presence check is not a certification. Scoped
     * to the step it is about, and named here so nobody re-widens it.
     */
    expect(databaseContractStep).not.toMatch(/^\s+psql(?:\s|\\)/m);
    expect(canary).toContain('md5(pg_get_functiondef(v_oid))');
    expect(canary).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(canary).toContain('cashier_operations_insert_own');
    expect(canary).toContain('club_members_cashier_tree_idx');
    expect(canary).toContain("('20260831235992')");
    expect(runner).toContain("await client.query('SET LOCAL ROLE authenticated')");
    expect(runner).toContain('INSERT INTO public.cashier_operations');
    expect(runner).toContain("await client.query('ROLLBACK')");
    expect(runner).toContain('SUPABASE_DB_PASSWORD');
  });

  it('gives the deployed Trade cashier a dedicated authenticated assertion', () => {
    const workflow = source('.github/workflows/post-deploy-e2e.yml');
    const spec = source('tests/e2e/production-cashier.spec.ts');
    expect(workflow).toContain('tests/e2e/production-cashier.spec.ts');
    expect(spec).toContain('[data-cashier-surface="trade"]');
    expect(spec).toContain("name: 'Every Chip. Accounted For.'");
    expect(spec).not.toContain("name: 'CASHIER'");
    expect(spec).toContain("tabs.first()).toHaveAttribute('aria-selected', 'true')");
    expect(spec).toContain("tabs.nth(1)).toHaveAttribute('aria-selected', 'false')");
  });

  it('records only bounded cashier SLO fields behind insert-only RLS', () => {
    const telemetry = source('src/services/CashierOperationsTelemetry.ts');
    const telemetryMigration = source(
      'supabase/migrations/20260831235992_cashier_operational_telemetry.sql'
    );
    expect(telemetry).toContain("supabase.from('cashier_operations').insert(row)");
    expect(telemetry).not.toContain('amount:');
    expect(telemetryMigration).toContain('FOR INSERT TO authenticated');
    expect(telemetryMigration).toContain('WITH CHECK (user_id = auth.uid())');
    expect(telemetryMigration).toContain(
      'REVOKE ALL ON public.cashier_operations FROM PUBLIC, anon, authenticated'
    );
    expect(telemetryMigration).toContain('v_cashier_health_hourly');
  });
});
