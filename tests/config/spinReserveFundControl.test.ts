/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN RESERVE FUND CONTROL — putting a button on a money path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * union_wallets.spin_reserve_wallet holds the capital every Spin bonus pool a
 * union owns is seeded from, and a 100x is paid out of it. It shipped on
 * 2026-08-22 reading zero, with no UI and no API: the only way to put money in
 * was to type fn_spin_reserve_wallet_fund by hand. Which is why the live pool
 * had been seeded 20,000 out of promo_wallet - money earmarked for promotions,
 * chosen because promo_wallet was the only balance anyone could see.
 *
 * Like spinReserveOwnership and spinEngineWiring, these read source rather than
 * execute it: the RPC needs a live Postgres and a real union. What is pinned is
 * that four specific regressions cannot come back.
 *
 *   1. THE UI CALLING THE BARE FUNCTION. Two functions differ by a suffix and
 *      return the same shape. fn_spin_reserve_wallet_fund has no replay
 *      protection whatsoever, and reads a NULL source wallet as an operator
 *      deposit - it mints the chips. fn_spin_reserve_wallet_fund_op claims an
 *      op id and refuses to mint. A button is retried; the bare function behind
 *      one double-credits and nothing anywhere reports it.
 *
 *   2. THE STAMP CLAIMING MORE THAN ONE ROW. uq_union_wallet_tx_op is unique on
 *      (union_id, tx_type, period_id). The first version of the wrapper stamped
 *      BOTH rows the inner call writes - the credit into the reserve and the
 *      debit out of the source - and they collided with each other inside one
 *      statement. Every genuine fund tripped its own replay guard, rolled
 *      itself back, and returned duplicate:true. Exactly one row may claim it.
 *
 *   3. THE FUND CALL ESCAPING THE EXCEPTION BLOCK. The rollback on a duplicate
 *      is what makes the guard worth having. Move the inner call above the
 *      BEGIN and a replay reports "already processed" AFTER a second credit has
 *      landed - which reads, in every log and every response, as if it worked.
 *
 *   4. THE INDEX FORGETTING WHAT IT ALREADY GUARDED. This migration rebuilds
 *      uq_union_wallet_tx_op to add one tx_type. Dropping any of the six that
 *      were already in it would silently remove replay protection from BBJ
 *      payouts, clawbacks and manual transfers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** Comments quote the very things these tests ban. Never match against them. */
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');
const tsxCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260822210000_spin_reserve_wallet_fund_op.sql';

const migration = sqlCode(read(MIGRATION));
const service = tsxCode(read('src/services/UnionApiService.ts'));
const page = tsxCode(read('src/pages/UnionDashboardPage.tsx'));

/** The body of fn_spin_reserve_wallet_fund_op, bounded by its own $fn$ pair. */
function wrapperBody(): string {
  const start = migration.indexOf('FUNCTION public.fn_spin_reserve_wallet_fund_op(');
  expect(start, 'fn_spin_reserve_wallet_fund_op is not defined in the migration').toBeGreaterThan(
    -1
  );
  const open = migration.indexOf('AS $fn$', start);
  expect(open, 'the wrapper has no $fn$ body').toBeGreaterThan(start);
  const close = migration.indexOf('$fn$;', open + 7);
  expect(close, 'the wrapper body is unterminated').toBeGreaterThan(open);
  return migration.slice(open, close);
}

describe('the wrapper is what makes this safe to put behind a button', () => {
  const body = wrapperBody();

  it('refuses to move anything without an op id', () => {
    expect(body).toMatch(/IF p_op_id IS NULL THEN[\s\S]{0,200}op_id_required/);
  });

  it('refuses a null or unknown source wallet, because null means mint', () => {
    expect(body).toMatch(/p_from_wallet IS NULL OR p_from_wallet NOT IN/);
    expect(body).toMatch(/'promo_wallet'[\s\S]{0,40}'rake_wallet'[\s\S]{0,40}'chip_balance'/);
    expect(body).toMatch(/source_wallet_required/);
  });

  it('calls the inner fund from INSIDE the block that rolls back on a duplicate', () => {
    const blockStart = body.indexOf('\n  BEGIN\n');
    const handler = body.indexOf('WHEN unique_violation');
    const innerCall = body.indexOf('public.fn_spin_reserve_wallet_fund(');

    expect(blockStart, 'the wrapper has no inner BEGIN block').toBeGreaterThan(-1);
    expect(handler, 'the wrapper does not handle unique_violation').toBeGreaterThan(-1);
    expect(innerCall, 'the wrapper never calls fn_spin_reserve_wallet_fund').toBeGreaterThan(-1);

    // Both the money move and the op-id claim must sit between BEGIN and the
    // handler, or a duplicate is reported after the second credit has landed.
    expect(innerCall).toBeGreaterThan(blockStart);
    expect(innerCall).toBeLessThan(handler);
    expect(body.indexOf('SET period_id  = p_op_id')).toBeGreaterThan(blockStart);
    expect(body.indexOf('SET period_id  = p_op_id')).toBeLessThan(handler);
  });

  it('claims the op id on exactly one row', () => {
    // One target, resolved before the UPDATE, and updated by primary key.
    expect(body).toMatch(/SELECT id INTO v_target[\s\S]*?LIMIT 1;/);
    expect(body).toMatch(/WHERE t\.id = v_target/);
    // The regression: stamping the credit and the debit together.
    expect(body).not.toMatch(/LIMIT 2/);
    expect(body).toMatch(/direction = 'credit'/);
  });

  it('never adopts an unstamped row that predates the call', () => {
    expect(body).toMatch(/SELECT COALESCE\(array_agg\(id\), '\{\}'::uuid\[\]\) INTO v_before/);
    expect(body).toMatch(/NOT \(id = ANY \(v_before\)\)/);
  });

  it('returns a duplicate rather than raising, so the endpoint can answer 409', () => {
    expect(body).toMatch(/'duplicate', true/);
    expect(body).toMatch(/'already_processed'/);
  });
});

describe('the replay guard keeps everything it already guarded', () => {
  it('rebuilds uq_union_wallet_tx_op with the new tx_type and all six old ones', () => {
    const start = migration.indexOf('CREATE UNIQUE INDEX uq_union_wallet_tx_op');
    expect(start, 'the index is not recreated').toBeGreaterThan(-1);
    const def = migration.slice(start, migration.indexOf(';', start));

    for (const t of [
      'bbj_payout',
      'manual_transfer',
      'rake_to_chips',
      'owner_deposit',
      'clawback',
      'bbj_fund',
      'spin_reserve_wallet_fund',
    ]) {
      expect(def, `uq_union_wallet_tx_op no longer guards ${t}`).toContain(`'${t}'`);
    }
    expect(def).toMatch(/union_id, tx_type, period_id/);
    expect(def).toMatch(/period_id IS NOT NULL/);
  });

  it('drops the index only immediately before recreating it', () => {
    const drop = migration.indexOf('DROP INDEX IF EXISTS public.uq_union_wallet_tx_op');
    const create = migration.indexOf('CREATE UNIQUE INDEX uq_union_wallet_tx_op');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it('keeps the wrapper away from client roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_spin_reserve_wallet_fund_op[\s\S]*?FROM anon, authenticated/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_spin_reserve_wallet_fund_op[\s\S]*?TO service_role/
    );
  });
});

describe('the client reaches the reserve only through the endpoint', () => {
  it('exposes fundSpinReserve with a required source wallet', () => {
    expect(service).toMatch(/fundSpinReserve\(/);
    expect(service).toMatch(/action: 'fund_spin_reserve'/);
    // A union of exactly the three real wallets, and not optional: an omitted
    // source is a null source, and a null source mints.
    expect(service).toMatch(
      /fromWallet:\s*'promo_wallet'\s*\|\s*'rake_wallet'\s*\|\s*'chip_balance'/
    );
    expect(service).not.toMatch(/fromWallet\?:/);
  });

  it('never calls either spin reserve RPC from the SPA', () => {
    // union_wallets is service-role-write-only. A client-side .rpc() here would
    // fail under RLS at best, and bypass every check in the endpoint at worst.
    expect(service).not.toMatch(/fn_spin_reserve_wallet_fund/);
    expect(page).not.toMatch(/fn_spin_reserve_wallet_fund/);
  });
});

describe('the union can see and fund the wallet', () => {
  it('reads spin_reserve_wallet with the rest of the wallet row', () => {
    expect(page).toMatch(/\.select\(\s*\n?\s*'[^']*spin_reserve_wallet[^']*'\s*\n?\s*\)/);
    expect(page).toMatch(/spin_reserve_wallet: number;/);
  });

  it('renders the balance', () => {
    expect(page).toMatch(/fmt\(wallets\.spin_reserve_wallet\)/);
    expect(page).toMatch(/Spin Reserve/);
  });

  it('offers the three real wallets as the source and nothing else', () => {
    expect(page).toMatch(/unionApi\.fundSpinReserve\(/);
    expect(page).toMatch(/<option value="promo_wallet">/);
    expect(page).toMatch(/<option value="rake_wallet">/);
    expect(page).toMatch(/<option value="chip_balance">/);
    // No route to the minting path from the UI.
    expect(page).not.toMatch(/<option value="">[^<]*(?:Deposit|Mint|Operator)/i);
  });

  it('gates the control behind union lead, like every other transfer on the page', () => {
    const card = page.indexOf('Fund Spin Reserve');
    expect(card).toBeGreaterThan(-1);
    // The nearest enclosing guard above the card must be the lead check.
    const before = page.slice(Math.max(0, card - 1200), card);
    expect(before).toMatch(/\{isLead && \(/);
  });
});
