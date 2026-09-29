/**
 * THE CLOSED UNION SEND DOOR CREDITS ONE OWNER, AND THE SQUARE-UP CHECKS THE
 * ECO RECORD'S OWN ARITHMETIC.
 *
 * Migration 20260925145748. Two refusals added to two existing writers.
 *
 * DEFECT A. public.fn_union_send_chips_to_club resolved ONE club owner with
 * `LIMIT 1` and no ORDER BY, then credited EVERY `role = 'owner'` row while
 * debiting the union wallet once. A club with two owner rows received 2 x
 * p_amount for a 1 x p_amount debit and the difference was minted. It had no
 * authorization check of any kind, no idempotency key, and wrote no
 * `chip_ledger` row.
 *
 * It has no caller. 20260903201301 closed it after finding zero callers and
 * zero rows in 30 days, and a-money-door-nothing-calls-is-closed.law.test.ts
 * keeps it revoked from PUBLIC, anon, authenticated and service_role. This file
 * asserts the other half: that the BODY behind the revoke is correct, and that
 * fixing it did not hand a key back.
 *
 * It was also jammed. Its audit row named `wallet = 'main'`, which
 * union_wallet_transactions_wallet_check has never permitted, so every call it
 * ever received aborted at that INSERT - the real reason no chip has gone
 * through it. Corrected in the same change.
 *
 * DEFECT B. fn_union_issue_weekly_invoices refuses a square-up whose ECO
 * disagrees with union_eco_ledger. Since 20260921040847 fn_union_club_invoice
 * RETURNS the recorded ECO, so that comparison is the record against itself and
 * can never fire. The naive repair - comparing against a fresh
 * fn_union_eco_adjustment call - is the 2026-09-14 defect that overstated one
 * club's debt by 1.21, because fn_union_pnl_evidence_report is VOLATILE. The
 * independent basis used instead is inside the record: eco_base, eco_rate and
 * eco_amount are stored side by side, all NOT NULL, and the producer defines
 * the amount as round(-eco_rate * eco_base, 2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'supabase/migrations');
const FILE = readdirSync(DIR).find((f) => f.startsWith('20260925145748'));
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

/** SQL with its comments stripped, so a rule about code is not read off prose. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** The replaced body of fn_union_send_chips_to_club, bounded by its own quoting. */
function sendDoorBody(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club(');
  expect(open, 'the send door replacement has moved or gone').toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end, 'the send door body is not dollar-quoted as expected').toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('20260925145748 ships as one guarded forward migration', () => {
  it('exists', () => {
    expect(FILE, 'the union-doors migration is missing').toBeTruthy();
  });

  it('wraps all of its DDL in exactly one transaction', () => {
    const statements = SQL.split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter((l) => /^(BEGIN|COMMIT|ROLLBACK);$/i.test(l));
    expect(statements).toEqual(['BEGIN;', 'COMMIT;']);
  });

  it('asserts its own readback before it commits', () => {
    expect(SQL).toMatch(/STEP C -- READBACK ASSERTIONS, INSIDE THE SAME TRANSACTION/);
    expect(SQL).toMatch(/RAISE EXCEPTION 'the union send door does not credit one resolved owner'/);
  });
});

describe('A: the send door credits one owner, or it refuses', () => {
  it('credits the one resolved owner by user_id and no longer every owner row', () => {
    const body = sendDoorBody();
    expect(body).toContain('WHERE club_id = p_club_id AND user_id = v_owner_user_id');
    // The predecessor's minting predicate, unqualified. Every role read in the
    // new body is qualified (cm.role), so this must not appear at all.
    expect(body).not.toMatch(/AND role = 'owner'/);
    expect(body).not.toMatch(/LIMIT 1/);
  });

  it('resolves the owner from clubs.owner_id and refuses an ambiguous one', () => {
    const body = sendDoorBody();
    expect(body).toContain('SELECT c.owner_id INTO v_owner_user_id');
    expect(body).toContain('union_send_club_owner_is_ambiguous');
    expect(body).toMatch(/IF v_owner_rows <> 1/);
  });

  it('carries the house authorization check', () => {
    const body = sendDoorBody();
    expect(body).toContain('IF NOT public.fn_caller_is_engine() THEN');
    expect(body).toContain('u.owner_id = v_actor');
    expect(body).toContain('union_send_not_authorized');
    expect(body).toContain('union_send_club_not_in_union');
  });

  it('carries an idempotency key it never invents for itself', () => {
    const body = sendDoorBody();
    expect(body).toContain("current_setting('app.union_send_chips_op_id', true)");
    expect(body).toContain('union_send_requires_operation_id');
    expect(body).toContain("'union_send_chips_to_club:' || v_op");
    expect(body).toContain('idempotency_key');
    // A generated key would make every retry a fresh payment. The body says so
    // in a comment; what it must not do is CALL one.
    expect(code(body)).not.toMatch(/gen_random_uuid/);
  });

  it('writes one chip_ledger leg that names the club, with both journals stood down', () => {
    const body = sendDoorBody();
    expect(body).toContain('INSERT INTO public.chip_ledger');
    expect(body).toContain("'union_send', p_club_id, p_union_id");
    expect(body).toContain("fn_ca_declare_ledger('union_send', 'union_bank'");
    expect(body).toContain("ARRAY['union_wallets', 'club_members']");
    expect(body).toContain("set_config('app.ledger_autoskip_union_wallets', '', true)");
    expect(body).toContain("set_config('app.ledger_autoskip_club_members', '', true)");
  });

  it('records its audit row against a wallet the CHECK permits', () => {
    const body = sendDoorBody();
    expect(body).toContain("p_union_id, 'chip_balance', 'debit'");
    expect(body).not.toContain("p_union_id, 'main', 'debit'");
  });

  it('does not hand the closed door a key back', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_union_send_chips_to_club\(uuid, uuid, numeric, text\)\s*\n?\s*FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.fn_union_send_chips_to_club/i
    );
    // And no overload: a fifth parameter would be a new function with default
    // PUBLIC EXECUTE, which is the closed door reopening.
    const signatures = SQL.match(/FUNCTION public\.fn_union_send_chips_to_club\([^)]*\)/g) || [];
    for (const signature of signatures) {
      expect(signature.replace(/\s+/g, ' ')).toMatch(
        /\((uuid, uuid, numeric, text|\s*p_union_id uuid,)/
      );
    }
    expect(SQL).not.toMatch(/p_op_id|p_operation_id/);
  });

  it('keeps the invoker’s own privileges: it is not made SECURITY DEFINER', () => {
    const head = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club('),
      SQL.indexOf(
        '$function$',
        SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club(')
      )
    );
    expect(head).not.toMatch(/SECURITY\s+DEFINER/);
  });
});

describe('B: the ECO record answers for its own arithmetic', () => {
  it('adds the refusal that can fire', () => {
    expect(SQL).toContain('union_squareup_eco_record_fails_its_own_arithmetic');
    expect(SQL).toContain('round(-v_recorded_rate * v_recorded_base, 2)');
    expect(SQL).toContain('l.eco_amount, l.eco_base, l.eco_rate');
  });

  it('keeps both existing refusals rather than deleting an assertion', () => {
    expect(SQL).toContain('union_squareup_eco_not_recorded');
    const kept = SQL.match(/union_squareup_eco_disagrees_with_record/g) || [];
    // Two raises in the patched body, plus the anchor being replaced and the
    // readback assertion: the name is never dropped.
    expect(kept.length).toBeGreaterThanOrEqual(3);
  });

  it('does not reintroduce the volatile recomputation the 2026-09-14 overstatement came from', () => {
    const patch = SQL.slice(
      SQL.indexOf('PART B -- THE SQUARE-UP CHECKS'),
      SQL.indexOf('STEP C -- READBACK ASSERTIONS')
    );
    // The names appear in the patch's own comment, which explains where the
    // producer's definition comes from. What must not appear is a CALL.
    expect(code(patch)).not.toMatch(/fn_union_pnl_evidence_report|fn_union_pnl_qualified_clubs/);
    expect(SQL).toContain("replace(v_src, 'fn_union_eco_adjustment', '')");
  });

  it('asserts its anchors appear exactly once before it rewrites anything', () => {
    const patch = SQL.slice(
      SQL.indexOf('PART B -- THE SQUARE-UP CHECKS'),
      SQL.indexOf('STEP C -- READBACK ASSERTIONS')
    );
    const guards = patch.match(/IF v_n <> 1 THEN/g) || [];
    expect(guards.length).toBe(3);
    expect(patch).toContain('the ECO record arithmetic substitution produced no change');
  });

  it('raises before the document is written, and proves it in the readback', () => {
    expect(SQL).toContain(
      "position('union_squareup_eco_record_fails_its_own_arithmetic' in v_src)\n        > position('INSERT INTO settlement_invoices' in v_src)"
    );
  });

  it('refuses to install over a recorded ECO that already fails the invariant', () => {
    expect(SQL).toContain(
      'a recorded ECO row does not satisfy round(-eco_rate*eco_base,2) = eco_amount'
    );
  });
});
