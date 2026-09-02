/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CLAIM CANNOT DESTROY CHIPS (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found by reading `fn_agent_claim_commission` line by line after the phase 7
 * work had landed and been published. Two defects and one measurement.
 *
 * 1. THE CLAIM COULD DEBIT THE BANK AND CREDIT NOBODY. The function read the
 *    caller's club_members row for their role WITHOUT `FOR UPDATE`, and ninety
 *    lines later credited that row without checking it matched - by which point
 *    the clubs row had been locked and debited. Delete the membership row in
 *    that window and the sequence is: treasury -= amount (committed), wallet +=
 *    amount (matched NOTHING, silently), settled_at = now() (rows stamped
 *    paid). The chips leave the club treasury, land nowhere, and the ledger
 *    records a payment that did not happen. CLAUDE.md 11.5 was written after
 *    exactly this failure class on `table_seats`, and unlike that one there is
 *    no trigger watching this path.
 *
 *    The role read locks now, and the credit RAISES if it matched nothing -
 *    RAISE and not RETURN, because a refusal here has to take the debit back
 *    with it, and only an exception rolls back what PostgREST would commit.
 *
 * 2. THE CLAIM RECEIPT HAD NO IDEMPOTENCY INDEX. Every other money path on
 *    chip_transactions carries a partial UNIQUE index on
 *    (club_id, metadata->>'op_id') - agent_wallet_send, club_bank_send,
 *    admin_removal, mint, club_bank_claim, promo_wallet_send, the four cashout
 *    types. `commission_claim`, the newest, had none, so its replay guard was
 *    check-then-act. Added while production held ZERO claim rows, which is the
 *    only moment it costs nothing.
 *
 * 3. 643.43 CHIPS ARE OWED TO PAYEES WHO CANNOT CLAIM THEM. 79 (club, user)
 *    pairs hold unsettled commission booked to a club they are not a member of,
 *    so the claim refuses them at the membership check. All 79 are horses, and
 *    CLAUDE.md 10.5 says a horse is paid everything a human is paid. The cause
 *    is the unscoped fallback in `credit_agent_commission_from_rake`, which
 *    finds the user's agents row in ANY club and books to `v_book_club`.
 *
 *    THAT LOOKUP IS DELIBERATELY NOT CHANGED HERE. Narrowing it decides who
 *    earns money, and CLAUDE.md 10.5 exists because an agent once wrote an
 *    earnings exclusion on its own assumption and reported the resulting zero
 *    as correct behaviour. It is put to Dan with both options costed. What this
 *    law pins is that it is VISIBLE - which the horses law requires on its own
 *    terms: never silently filtered out of a report, a total, or a ledger.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const CLAIM = read('supabase/migrations/20260902035829_a_claim_cannot_destroy_chips.sql');
const INDEX = read(
  'supabase/migrations/20260902040500_the_claim_receipt_joins_the_idempotency_family.sql'
);

describe('the membership row cannot vanish mid-claim', () => {
  it('the role read takes FOR UPDATE', () => {
    expect(CLAIM).toMatch(/FOR UPDATE;'/);
    expect(CLAIM).toMatch(/v_role_old text/);
    expect(CLAIM).toMatch(/v_role_new text/);
  });

  it('and the patch asserts it found exactly one membership read', () => {
    expect(CLAIM).toMatch(
      /expected exactly 1 membership read in fn_agent_claim_commission, found %/
    );
  });
});

describe('a credit that lands nowhere aborts the claim', () => {
  it('the credit is asserted, not assumed', () => {
    expect(CLAIM).toMatch(/IF v_to_after IS NULL THEN/);
    expect(CLAIM).toMatch(/commission claim could not credit the member wallet/);
  });

  it('and it RAISES, because a RETURN would commit the debit', () => {
    // PostgREST commits the transaction on a plain RETURN. Only an exception
    // takes the bank debit back with it.
    expect(CLAIM).toMatch(
      /RAISE EXCEPTION ''commission claim could not credit the member wallet''/
    );
    expect(CLAIM).toMatch(/USING ERRCODE = ''25000''/);
  });

  it('the patch asserts it found exactly one wallet credit', () => {
    expect(CLAIM).toMatch(/expected exactly 1 wallet credit in fn_agent_claim_commission, found %/);
  });
});

describe('the refusal order the original author protected still holds', () => {
  // Every write in the claim happens AFTER the last thing that can refuse. An
  // earlier draft stamped settled_at before the bank was checked, so a short
  // bank returned "cannot pay" while leaving the rows marked paid.
  it('the migration refuses to apply if the settle moved before the debit', () => {
    expect(CLAIM).toMatch(/the settle now runs before the bank debit; refusal order broken/);
  });
});

describe('the claim is patched, never re-emitted', () => {
  it('it reads the live source and asserts the match count', () => {
    expect(CLAIM).toMatch(/DO \$patch\$/);
    expect(CLAIM).toMatch(/pg_get_function_arguments\(p\.oid\)/);
    // The identity form strips DEFAULTs and CREATE OR REPLACE cannot remove
    // them; that cost a failed apply on the previous migration in this family.
    expect(CLAIM).not.toMatch(/pg_get_function_identity_arguments/);
    expect(CLAIM).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_agent_claim_commission\(%s\) RETURNS jsonb/
    );
    expect(CLAIM).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_agent_claim_commission\s*\(\s*\n?\s*p_/
    );
  });

  it('and skips cleanly if it is already applied', () => {
    expect(CLAIM).toMatch(/already carries both guards; skipping/);
  });
});

describe('the claim receipt joins the idempotency family', () => {
  it('a partial unique index on (club_id, op_id), like every sibling path', () => {
    expect(INDEX).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/);
    expect(INDEX).toMatch(/chip_transactions_commission_claim_op_id_uidx/);
    expect(INDEX).toMatch(/\(club_id, \(\(metadata ->> 'op_id'\)\)\)/);
    expect(INDEX).toMatch(/WHERE transaction_type = 'commission_claim' AND metadata \? 'op_id'/);
  });

  it('built CONCURRENTLY, and alone, because it cannot be transactional', () => {
    // A plain CREATE INDEX takes ACCESS EXCLUSIVE on the table every money path
    // writes to. CONCURRENTLY cannot run inside a transaction, so it gets its
    // own migration rather than breaking the one-transaction-per-change rule.
    expect(INDEX).toMatch(/CONCURRENTLY/);
    expect(INDEX).not.toMatch(/^BEGIN;/m);
    expect(INDEX).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/);
  });
});

describe('money nobody can reach is reported, not hidden', () => {
  it('there is a report, and it counts horses rather than filtering them', () => {
    expect(CLAIM).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_club_unclaimable_commission/);
    expect(CLAIM).toMatch(/'horses',\s+COALESCE\(count\(\*\) FILTER \(WHERE t\.is_horse\), 0\)/);
    expect(CLAIM).toMatch(
      /'humans',\s+COALESCE\(count\(\*\) FILTER \(WHERE NOT t\.is_horse\), 0\)/
    );
    // CLAUDE.md 10.5: a horse is NEVER silently filtered out of a report.
    expect(CLAIM).not.toMatch(/AND NOT COALESCE\((pr|p)\.is_horse, ?false\)/);
  });

  it('it is service-role only, and revokes authenticated EXPLICITLY', () => {
    // Supabase's default privileges grant EXECUTE on every new public function
    // to anon AND authenticated. REVOKE ... FROM PUBLIC does not remove those:
    // they are direct grants to named roles. The migration's own assertion
    // caught this on the first apply attempt.
    expect(CLAIM).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_club_unclaimable_commission\(uuid\) FROM authenticated;/
    );
    expect(CLAIM).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_club_unclaimable_commission\(uuid\) TO service_role;/
    );
    expect(CLAIM).toMatch(/fn_club_unclaimable_commission must not be callable by authenticated/);
  });

  it('and the accrual rule is left for Dan, with both options written down', () => {
    expect(CLAIM).toMatch(/THIS MIGRATION DOES NOT CHANGE THAT/);
    expect(CLAIM).toMatch(/credit_agent_commission_from_rake/);
  });
});

describe('the claim function writes its own grants down', () => {
  // check-definer-authorization BLOCKED the first push, correctly: the patch
  // declares the function through EXECUTE format(), so its body - and the
  // auth.uid() on its third statement - never appears literally in the file,
  // and a static scan cannot tell a guarded definer from an unguarded one.
  // Verified against production before the lines were written: anon false,
  // authenticated true, service_role true. They change nothing; they make the
  // state explicit rather than inherited.
  it('revokes PUBLIC and anon, keeps authenticated and service_role', () => {
    const sig = 'public\\.fn_agent_claim_commission\\(uuid, uuid, integer\\)';
    expect(CLAIM).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`));
    expect(CLAIM).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`));
    expect(CLAIM).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`));
    expect(CLAIM).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`));
  });
});
