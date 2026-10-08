/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND TOP-UP TAKES THE TABLE BEFORE THE WALLET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Diamond Phase 11 line 5 (database locks). Every Diamond cash door that moves
 * a seated player's money takes the table row and then the wallet row: the hand
 * settler, the buy-in and the cash-out. The top-up took the wallet first, so a
 * top-up and the settlement of the hand it followed took the same two rows in
 * opposite orders - measured to deadlock on an isolated cluster with the live
 * doors (scripts/qualification/diamond-lock-waits.py), and not with the table
 * taken first. Migration 20260930130000 moves one lock earlier; the engine
 * treats the settlement window as mid hand.
 *
 * The law pins: the edit is an asserted substitution over the pinned live text
 * with the measured result asserted and the reverse proved; the table is taken
 * before the wallet and the wallet before the validating table read; the door
 * is declared to the guard watch; nothing is opened; and the text the harness
 * measured is the text the migration installs, character for character.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_top_up_takes_the_table_before_the_wallet.sql'))
  .at(-1);
if (!NAME) throw new Error('the top-up lock-order migration is missing');
const MIG = migrationText(NAME);
const HARNESS = readFileSync(
  resolve(__dirname, '..', 'scripts', 'qualification', 'diamond-lock-waits.py'),
  'utf8'
);
const ENGINE = readFileSync(
  resolve(__dirname, '..', 'server', 'src', 'engine', 'ServerTableEngineSeating.ts'),
  'utf8'
);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const FINAL = sliceBetween(MIG, '-- THE ESTATE IS AS IT WAS', 'RAISE NOTICE');

/** The SQL E'' pieces of v_old / v_new, decoded to the text they build. */
const sqlClause = (name: 'v_old' | 'v_new'): string => {
  const block = sliceBetween(MIG, `  ${name} := `, ';\n');
  return [...block.matchAll(/E'((?:[^']|'')*)'/g)]
    .map((m) => m[1].replace(/''/g, "'").replace(/\\n/g, '\n'))
    .join('');
};
/** The Python TOP_UP_OLD / TOP_UP_NEW constants, decoded the same way. */
const pyClause = (name: 'TOP_UP_OLD' | 'TOP_UP_NEW'): string => {
  const block = sliceBetween(HARNESS, `${name} = (`, ')\n');
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"))
    .join('');
};

describe('LAW: a Diamond top-up takes the table before the wallet', () => {
  it('is an asserted substitution over the pinned live text, with the measured text asserted', () => {
    expect(MIG).toContain("IF md5(v_def) <> 'fe1cf0ce225ef0977ceef3dd8bfb4598' THEN");
    expect(MIG).toContain("IF md5(v_after) <> 'f7659bddc424e9e4b6785228ee0eec6a' THEN");
    expect(MIG).toContain(
      "IF md5(replace(v_after, v_new, v_old)) <> 'fe1cf0ce225ef0977ceef3dd8bfb4598' THEN"
    );
    expect(MIG).toMatch(/IF v_n <> 1 THEN/);
    expect(MIG).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(MIG).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\(p\.oid\)\) = 'f7659bddc424e9e4b6785228ee0eec6a'/m
    );
  });

  it('takes the table, then the wallet, and changes nothing else in the clause', () => {
    const oldText = sqlClause('v_old');
    const newText = sqlClause('v_new');
    const table = 'PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;';
    const wallet =
      'SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;';
    expect(oldText).not.toContain(table);
    expect(newText.indexOf(table)).toBeGreaterThan(0);
    expect(newText.indexOf(table)).toBeLessThan(newText.indexOf(wallet));
    // Every statement of the old clause survives verbatim; only comments and the lock are added.
    const statements = (t: string) =>
      t
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('--'));
    expect(statements(newText).filter((l) => l !== table)).toEqual(statements(oldText));
  });

  it('measured the text it ships: the harness substitution is the migration substitution', () => {
    expect(pyClause('TOP_UP_OLD')).toContain(
      '-- Wallet first, exactly as the reserve and the hand settler take it.'
    );
    expect(pyClause('TOP_UP_NEW')).toContain(
      'PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;'
    );
    expect(pyClause('TOP_UP_OLD')).toBe(sqlClause('v_old'));
    expect(pyClause('TOP_UP_NEW')).toBe(sqlClause('v_new'));
    expect(HARNESS).toContain("'fn_poker_diamond_top_up': 'fe1cf0ce225ef0977ceef3dd8bfb4598'");
  });

  it('declares the watched door and leaves the estate as it was', () => {
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_top_up', 'migration a_diamond_top_up_takes_the_table_before_the_wallet');"
    );
    expect(FINAL).toContain(
      'the top-up does not take the table, then the wallet, then validate the table'
    );
    expect(FINAL).toContain(
      "has_function_privilege('authenticated', 'public.fn_poker_diamond_top_up"
    );
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(FINAL).toContain('fn_ca_diamond_register_vs_supply()');
    expect(FINAL).toContain('watched guards off their baseline');
    expect(code(MIG)).not.toMatch(/SET\s+(?:cash_games_enabled|tournaments_enabled)\s*=\s*true/i);
    expect(code(MIG)).not.toMatch(/\bGRANT\b/i);
  });

  it('the engine holds a top-up while the finished hand is still settling', () => {
    // 2026-10-08: the between-hands decision is re-read once the seat boundary
    // is owned (ADiamondSeatCreditWaitsForTheHandBeingPrepared.test.ts), so the
    // settlement window is asked both before and after the wait.
    expect(ENGINE).toContain('if (midHand || this.hasSettlementInFlight()) {');
    expect(ENGINE).toContain('!!this.handController || this.hasSettlementInFlight(),');
    expect(ENGINE).toContain('if (this.handController || this.hasSettlementInFlight()) return;');
  });
});
