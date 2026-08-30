import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260830235990_cashier_claim_back_cent_integrity.sql'),
  'utf8'
);

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
