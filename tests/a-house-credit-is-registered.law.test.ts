/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A HOUSE CREDIT IS REGISTERED, NOT ONLY BANKED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rule R2 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 3.1: a
 * Diamond crossing the line between a player and the house is a registered
 * PAIR in one transaction - the payer's spend journal row, which the register
 * retires from the player, and a house `mint` row in ca_mint_ledger, which
 * issues it to the house. "Nothing crosses with one row, and nothing crosses
 * through ca_diamond_house_ledger, which the register does not see."
 *
 * enter_trivia_tournament_v2 crossed it with one row. It retired the player's
 * whole entry fee through the journal, credited the 10 percent cut to
 * ca_diamond_house, wrote a ca_diamond_house_ledger row, and wrote no mint
 * row - so the house held Diamonds the register had never issued. That is
 * section 6 item 4 of the design, and it was still live on 2026-10-04.
 *
 * Measured on production that day in a transaction that ended in
 * RAISE EXCEPTION and rolled back (CLAUDE.md 11.5 rule 1): a 50 Diamond entry
 * put 45 in the prize pool and 5 in the house, wrote one house ledger row and
 * no mint row, and moved fn_ca_diamond_register_vs_supply().difference from
 * 0.00 to 5.00 - exactly the cut. That difference being 0 is the assertion
 * every Diamond migration ends on, so the next Diamond migration to run after
 * a paid trivia entry would have refused itself. Through the fixed door, built
 * in pg_temp and run against the same fixture, the difference stayed 0.00, one
 * mint row was written, and a replay returned `already_entered`.
 *
 * The caller is the World Hub's pages/api/trivia/tournament-enter.js; the
 * function is this repository's, written by
 * 20260903002841_diamond_e_every_earn_engine_has_a_budget_line (DR14).
 *
 * The pins below are the shape of the migration that closed it: an in-place
 * edit with the live md5 pinned, the reverse substitution proved, the mint
 * row's holder and reason, its idempotency key, and the identity asserted on
 * the way out.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const named = (suffix: string) => {
  const name = migrationNames()
    .filter((n) => n.endsWith(suffix))
    .at(-1);
  if (!name) throw new Error(`the migration ${suffix} is missing`);
  return migrationText(name);
};
const BOOKS = named('_the_diamond_books_do_not_invent_a_number.sql');

const TRIVIA = sliceBetween(
  BOOKS,
  "-- 1. A TRIVIA ENTRY'S HOUSE CUT IS REGISTERED, NOT ONLY BANKED",
  '-- 2. AN UNSET REWARD BUDGET IS UNSET'
);
const FINAL = sliceBetween(BOOKS, '-- 3. THE ESTATE IS AS IT WAS', 'COMMIT;');

// A counterfeit fix: bank the cut and explain it in the house's own ledger,
// which is what the door already did. Every pin below must reject it.
const COUNTERFEIT = `
  UPDATE public.ca_diamond_house SET balance = balance + v_cut WHERE id = 1;
  INSERT INTO public.ca_diamond_house_ledger (delta, reason) VALUES (v_cut, 'cut');
`;

describe('a house credit is registered, not only banked', () => {
  it('edits the live door in place, with its md5 pinned and the reversal proved', () => {
    expect(TRIVIA).toContain("'e636c45d5552ce1484e602bbb5d07917'");
    expect((TRIVIA.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length).toBe(1);
    expect((TRIVIA.match(/IF md5\(replace\(/g) ?? []).length).toBe(1);
    expect(TRIVIA).toContain('EXECUTE replace(v_def, v_old, v_new);');
  });

  it('proves the anchor it replaces occurs exactly once', () => {
    expect(TRIVIA).toContain(
      "v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);"
    );
    expect(TRIVIA).toMatch(/IF v_n <> 1 THEN/);
  });

  it('writes a house mint row into the register, not another house-ledger row', () => {
    expect(TRIVIA).toContain('INSERT INTO public.ca_mint_ledger');
    expect(TRIVIA).toContain("''mint'', ''diamonds'', ''house''");
    expect(TRIVIA).toContain("''00000000-0000-0000-0000-00000000d1a0''::uuid, ''the house''");
    expect(COUNTERFEIT).not.toContain('ca_mint_ledger');
  });

  it('keeps the house-ledger row it already wrote - the pair is both rows', () => {
    // the substitution APPENDS to the house ledger write, it does not replace it
    expect(TRIVIA).toContain('v_new := v_old');
    expect(TRIVIA).toContain("''trivia_tournament_entry_cut''");
  });

  it('issues the cut once: the register key is the house ledger reference', () => {
    expect(TRIVIA).toContain(
      "''trivia-tournament-cut:''||p_tournament_id::text||'':''||p_user_id::text"
    );
    expect(TRIVIA).toMatch(/ca_mint_ledger\.op_id is/);
  });

  it('carries the balances and the supply the register needs, and names its reason', () => {
    expect(TRIVIA).toContain('v_cut, v_house_after - v_cut, v_house_after');
    expect(TRIVIA).toContain("WHEN m.action = ''mint'' THEN m.amount");
    expect(TRIVIA).toContain('DR14 (trivia_tournament_entry_cut)');
    expect(COUNTERFEIT).not.toContain('DR14');
  });

  it('leaves the door a service_role door and never a browser one', () => {
    expect(BOOKS).toContain(
      'REVOKE ALL ON FUNCTION public.enter_trivia_tournament_v2(uuid, uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(BOOKS).toContain(
      'GRANT EXECUTE ON FUNCTION public.enter_trivia_tournament_v2(uuid, uuid) TO service_role;'
    );
    expect(FINAL).toContain("has_function_privilege('anon', r.oid, 'EXECUTE')");
  });

  it('ends on the identity it was breaking, and on the arena doors staying shut', () => {
    expect(FINAL).toContain(
      'IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN'
    );
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('this migration must not open the arena doors');
  });

  it('horses are players: the door branches on nothing about them (10.5)', () => {
    expect(FINAL).toContain("position('is_horse' IN pg_get_functiondef(r.oid)) > 0");
    expect(TRIVIA).not.toMatch(/is_horse/);
  });

  it('is one transaction and repairs nothing on a schedule (10.12)', () => {
    expect(BOOKS.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(BOOKS.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(BOOKS).not.toMatch(/cron\.schedule|_backpay_|_redrive_|_sweep_|_catchup_|_heal_/);
  });
});
