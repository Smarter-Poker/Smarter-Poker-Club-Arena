/**
 * LAW: THE MINT REGISTER IS A SUPPLY LEDGER, AND ITS PER-WALLET NET IS NOT A
 * BALANCE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Written 2026-09-30, after the second agent in two days measured the same
 * thing and had to re-derive what it meant from twenty queries.
 *
 * 20260930055147 closed a real journal defect and left a note saying the
 * register "does not agree with holdings wallet-by-wallet. 1,068 wallets
 * differ, netting to zero globally. That is a different defect." It is not a
 * defect, and they do not net to zero: measured on production 2026-09-30 all
 * 1,068 lean the SAME way (gross difference 1,021,092 equals net difference
 * 1,021,092, so not one wallet is short), because the pre-2026-09-03 supply
 * was acknowledged as ONE row against the `circulation` holder and
 * deliberately never attributed per holder. docs/DIAMOND-ACCOUNTING-STANDARD
 * lane B says exactly that and says "backfill NOTHING".
 *
 * What this law pins, and why each pin exists:
 *
 *  1. The reporting functions stay READ ONLY. The finding was that no money is
 *     owed; a later agent must not turn this into a sweep, a backfill or a
 *     paying job (CLAUDE.md 10.11, 10.12).
 *  2. THREE verdicts, never two. A wallet the register has never tracked is
 *     `opening_stock_only`, which is COULD NOT TELL, not "balanced"
 *     (CLAUDE.md 10.86 rule 1).
 *  3. Nobody re-attributes the baseline. Writing per-holder opening rows would
 *     contradict lane B and rewrite 1,231 rows of a money ledger for no money.
 *  4. The chain is read BY VALUE, not by `ORDER BY created_at DESC LIMIT 1`.
 *     Dozens of register rows share one `created_at` when one transaction
 *     claims many rewards, and ordering by it reported 38 false drifts on the
 *     first pass of this audit.
 *  5. No `is_horse` anywhere in the migration (CLAUDE.md 10.5).
 *  6. The Diamond Arena statement never prints "Every Session Reconciles" to a
 *     player who has never played. `fn_diamond_arena_reconciliation` returns
 *     `balanced: true` vacuously for a wallet with no sessions, and the
 *     `sessions === 0` branch in the component is the only thing standing
 *     between that and a claim nobody checked.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const migrations = () =>
  readdirSync(MIG)
    .filter((f) => f.endsWith('.sql'))
    .sort();

/** SQL with its line comments removed: a mention is not a statement. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

const MIGRATION = '20260930164146_the_register_is_a_supply_ledger_and_says_so_per_wallet.sql';

describe('the register is a supply ledger', () => {
  const sql = readFileSync(join(MIG, MIGRATION), 'utf8');

  it('ships both reads, and neither writes anything', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_mint_wallet_attribution(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_mint_register_attribution(');
    const body = code(sql);
    for (const verb of ['INSERT INTO', 'UPDATE public.', 'DELETE FROM', 'TRUNCATE']) {
      expect(body).not.toContain(verb);
    }
    // STABLE, not VOLATILE: a read cannot be mistaken for a door.
    expect(sql.match(/STABLE SECURITY DEFINER/g)?.length).toBe(2);
  });

  it('names three verdicts and never folds the unknown one into agreement', () => {
    for (const v of ['register_agrees', 'register_drifts', 'opening_stock_only']) {
      expect(sql).toContain(`'${v}'`);
    }
    // The unknown verdict must not be produced by the branch that checks the
    // chain: it belongs to the wallet with NO register row at all.
    expect(code(sql)).toContain("WHEN NOT b.tracked THEN 'opening_stock_only'");
    expect(sql).toContain('NOTHING IS CONCLUDED');
  });

  it('reads the chain by value, not by the last timestamp', () => {
    // The FUNCTION BODY only. The comments beside it quote the wrong query on
    // purpose, so the next person recognises what not to reach for.
    const body = code(sql.slice(sql.indexOf('AS $fn$'), sql.indexOf('$fn$;') + 5));
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/ORDER BY\s+m?\.?created_at\s+DESC/i);
    expect(body).toContain('m.balance_after = s.held');
  });

  it('re-attributes no baseline and writes no register row', () => {
    const body = code(sql);
    expect(body).not.toContain('ca_mint_ledger (');
    expect(body).not.toContain('fn_ca_mint(');
    // The baseline rows are named in prose so the next agent can find them,
    // and nowhere else.
    expect(sql).toContain('baseline:diamonds:2026-09-03:v2');
  });

  it('is not a repair job by any of its names', () => {
    const body = code(sql).toLowerCase();
    for (const banned of ['_repair_', '_backpay_', '_redrive_', '_sweep_', '_catchup_', '_heal_']) {
      expect(body).not.toContain(banned);
    }
    expect(body).not.toContain('cron.schedule');
  });

  it('never selects on is_horse', () => {
    expect(code(sql)).not.toContain('is_horse');
  });

  it('nobody later attributes the diamond baseline per holder', () => {
    const offenders = migrations()
      .filter((f) => f > MIGRATION)
      .filter((f) => {
        const s = code(readFileSync(join(MIG, f), 'utf8'));
        return (
          s.includes('register-opening-stock') ||
          (s.includes("holder_type = 'circulation'") &&
            /INSERT INTO public\.ca_mint_ledger/.test(s))
        );
      });
    expect(offenders).toEqual([]);
  });

  it('the arena statement never claims a reconciliation it did not make', () => {
    const component = read('src/components/wallet/DiamondArenaStatement.tsx');
    expect(component).toContain('statement.sessions === 0');
    const zero = component.indexOf('statement.sessions === 0');
    const balanced = component.indexOf('statement.balanced');
    expect(zero).toBeGreaterThan(-1);
    expect(balanced).toBeGreaterThan(zero);
    expect(component).toContain('No Diamond Arena Sessions Yet');
  });
});
