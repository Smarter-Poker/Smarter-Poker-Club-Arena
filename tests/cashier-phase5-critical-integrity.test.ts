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
    const start = page.indexOf("supabase.rpc('fn_club_wallet_claim_back'");
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
  it('pins the installed Union directory after the deleted-account filter', () => {
    const canary = source('scripts/verification-harness/cashier-release-contract.sql');
    const entry = canary.match(
      /'signature', 'public\.fn_union_player_directory\(uuid\)'([\s\S]*?)\n {4}\)/
    );
    expect(entry).not.toBeNull();
    expect(
      [...entry![1].matchAll(/'(?:replacement_)?hash', '([a-f0-9]{32})'/g)].map((match) => match[1])
    ).toEqual(['fc06a6bf8f02822da43f6f4b4fe76385']);
    expect(canary).toContain("version = '20261017001657'");
    expect(canary).toContain("name = 'a_deleted_account_leaves_every_club_and_every_list'");
  });

  it('pins only the installed journal-origin conservation definition and its migration receipt', () => {
    const canary = source('scripts/verification-harness/cashier-release-contract.sql');
    const entry = canary.match(
      /'signature', 'public\.fn_cashier_conservation_report\(uuid\)'([\s\S]*?)\n {4}\)/
    );
    expect(entry).not.toBeNull();
    expect(
      [...entry![1].matchAll(/'(?:replacement_)?hash', '([a-f0-9]{32})'/g)].map((match) => match[1])
    ).toEqual(['617a6a58c41f8a1f204e3438d6ea2a4c']);
    const origin = source(
      'supabase/migrations/20261019185853_new_clubs_reconcile_player_wallets_from_their_journal_origin.sql'
    );
    expect(origin).toContain(
      "md5(pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure))='617a6a58c41f8a1f204e3438d6ea2a4c'"
    );
    expect(canary).toContain("version = '20261019185853'");
    expect(canary).toContain(
      "name = 'new_clubs_reconcile_player_wallets_from_their_journal_origin'"
    );
    // Retired predecessors and any unqualified definition still raise.
    expect(canary).toContain(
      "IF v_actual_hash <> v_item ->> 'hash'\n       AND v_actual_hash <> coalesce(v_item ->> 'replacement_hash', '') THEN\n      RAISE EXCEPTION 'cashier function drift: % expected %, got %'"
    );
  });

  it('pins the launch wallet wrappers after the global intent lock', () => {
    const authority = source(
      'supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql'
    );
    const contract = source('scripts/verification-harness/cashier-release-contract.sql');
    const sendWrapper = authority.slice(
      authority.indexOf('CREATE FUNCTION public.fn_agent_wallet_send('),
      authority.indexOf('CREATE FUNCTION public.fn_agent_wallet_claim_back(')
    );
    const claimWrapper = authority.slice(
      authority.indexOf('CREATE FUNCTION public.fn_agent_wallet_claim_back('),
      authority.indexOf(
        'REVOKE ALL ON FUNCTION',
        authority.indexOf('CREATE FUNCTION public.fn_agent_wallet_claim_back(')
      )
    );
    for (const wrapper of [sendWrapper, claimWrapper]) {
      expect(wrapper.indexOf('fn_cashier_exact_intent_begin')).toBeGreaterThanOrEqual(0);
      expect(wrapper.indexOf('fn_cashier_exact_intent_begin')).toBeLessThan(
        wrapper.indexOf('_core_20261004')
      );
    }
    expect(contract).toContain("'hash', 'c6c14eb18feb9a645a7aa2ffad3cf6f1'");
    expect(contract).toContain("'hash', '85976e86092390fb1950b8ed31c36c0d'");
    expect(contract).toContain(
      'public.fn_agent_wallet_send_core_20261004(uuid,uuid,numeric,text,text,uuid)'
    );
    expect(contract).toContain(
      'public.fn_agent_wallet_claim_back_core_20261004(uuid,uuid,numeric,text,uuid)'
    );
  });

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
    // The bodies installed and read back live on 2026-10-12, and only those:
    // the bodies they replaced are no longer accepted as an alternative.
    for (const [installed, superseded] of [
      // fn_club_trade_ledger (20261012040542; superseded 20261010005048)
      ['1b1312459ecc90069375d8bcdb3127ca', 'd489a8b997a25320b0b4ec8b14a43587'],
      // fn_agent_wallet_reversible (20261010005048)
      ['3cc86bbb6317359a7b43fc34524d5876', '61b3478f0332f8ee7945d6eb2810bb71'],
      // fn_respond_chip_request (20261010003544)
      ['10fb3a12f5113521a2366a98af90ecbd', 'f6b8bf0d7d035d063780b37ff614b068'],
      // fn_club_bank_ledger (20261016155801; superseded 20261012040542)
      ['cb7edf507b92e7c22535d6fed10a416b', 'f17eb94522c177856683617945d9f371'],
      // fn_ca_chip_statement_page (20261012040542)
      ['d513f6f312b29835cc5e74aa8ff00ce0', 'c706109ed8dab335912f046aaa6ee215'],
    ] as const) {
      expect(canary).toContain(`'hash', '${installed}'`);
      expect(canary).not.toContain(`'replacement_hash', '${installed}'`);
      expect(canary).not.toContain(superseded);
    }
    expect(canary).not.toContain("'hash', 'ea5a5a57ec31f396958246def887e5e6'");
    expect(canary).not.toContain("'hash', '49797528c3b5ddfcd2ccbaa01f8a1bd3'");
    // The approved launch boundary refuses only unfinished prior intents.
    expect(canary).toContain("'hash', '424fc2b2ee2ec319ecbbb7f267515f27'");
    expect(canary).not.toContain("'hash', '3ec6fc367b3dae5c4bf3978d0175ef22'");
    expect(canary).not.toContain("'hash', '910f8859d4c683aafd4403c4f386772b'");
    // Installed restricted-bank core after the 20261029065153 journal-source label.
    expect(canary).toContain("'hash', 'aa695a9cec9ffb9516cf329fcd04fcf9'");
    expect(canary).not.toContain("'hash', 'e2fa848a65ab3615117385fc0614c229'");
    expect(canary).not.toContain("'hash', '5990c675526e842d0671f47890c1ff27'");
    expect(canary).toContain("'hash', '7a357ba95a8ca4eb13f00f798233d8d4'");
    expect(canary).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(canary).toContain('fn_record_cashier_operation');
    expect(canary).toContain("('20260906093024')");
    expect(canary).toContain('club_members_cashier_tree_idx');
    expect(canary).toContain("('20260831235992')");
    expect(canary).toContain("('20261004124327')");
    expect(canary).toContain('cashier_rpc_operation_intents');
    expect(canary).toContain('fn_cashier_exact_intent_begin');
    expect(canary).toContain('cashier_agent_balance_actor_guard');
    expect(runner).toContain("await client.query('SET LOCAL ROLE authenticated')");
    expect(runner).toContain('SELECT public.fn_record_cashier_operation');
    expect(runner).not.toContain('INSERT INTO public.cashier_operations');
    expect(runner).toContain("await client.query('ROLLBACK')");
    expect(runner).toContain('SUPABASE_DB_PASSWORD');
  });

  it('gives the deployed Trade cashier a dedicated authenticated assertion', () => {
    const workflow = source('.github/workflows/post-deploy-e2e.yml');
    const spec = source('tests/e2e/production-cashier.spec.ts');
    expect(workflow).toContain('tests/e2e/production-cashier.spec.ts');
    expect(spec).toContain('[data-cashier-surface="trade"]');
    expect(spec).toContain("name: 'Wallet Command'");
    expect(spec).not.toContain("name: 'CASHIER'");
    expect(spec).toContain("tabs.first()).toHaveAttribute('aria-selected', 'true')");
    expect(spec).toContain("tabs.nth(1)).toHaveAttribute('aria-selected', 'false')");
  });

  it('records bounded cashier SLO fields through an auth-derived, club-scoped RPC', () => {
    const telemetry = source('src/services/CashierOperationsTelemetry.ts');
    const telemetryBase = source(
      'supabase/migrations/20260831235992_cashier_operational_telemetry.sql'
    );
    const telemetryBoundary = source(
      'supabase/migrations/20260906093024_cashier_rpc_idempotency_and_telemetry_boundary.sql'
    );
    expect(telemetry).toContain("supabase.rpc('fn_record_cashier_operation', args)");
    expect(telemetry).not.toContain("supabase.from('cashier_operations')");
    expect(telemetry).not.toContain('amount:');
    expect(telemetryBoundary).toContain('v_user_id uuid := auth.uid()');
    expect(telemetryBoundary).toContain('fn_club_cashier_scope(p_club_id, v_user_id)');
    expect(telemetryBoundary).toContain('DROP POLICY IF EXISTS cashier_operations_insert_own');
    expect(telemetryBoundary).toContain(
      'REVOKE ALL ON public.cashier_operations FROM PUBLIC, anon, authenticated'
    );
    expect(telemetryBase).toContain('v_cashier_health_hourly');
  });
});
