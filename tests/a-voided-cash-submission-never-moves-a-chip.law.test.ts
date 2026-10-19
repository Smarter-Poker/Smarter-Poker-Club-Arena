/**
 * A VOIDED CASH SUBMISSION NEVER MOVES A CHIP (2026-09-26)
 *
 * fn_ca_void_unsettled_cash_submission exists to unstick a cash table whose
 * oldest unresolved hand_submissions row can provably never be replayed
 * (a seat the retained request captured no longer matches the live table).
 * The one guarantee that makes voiding such a row safe with no wallet write
 * is that it only ever applies to a hand that was NEVER atomically committed
 * under any submission - no chip was ever moved for it, so there is nothing
 * to reconcile. This law pins that guarantee directly against the migration
 * source: the void function contains no write to any ledger/wallet/balance
 * table, it refuses outright when a hand_atomic_commits row already exists
 * for the hand, it is service_role-only, it is cash-table-only, and
 * fn_ca_resume_hand_submission's candidate query is wired to skip a voided
 * row so a void actually stops the crash-loop re-selection instead of being
 * inert.
 *
 * 20260926231546. supabase/migrations/20260926231546_cash_table_hand_submission_void_door.sql
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260926231546_cash_table_hand_submission_void_door.sql'
  ),
  'utf8'
);

function functionBody(name: string, args: string): string {
  const start = SQL.indexOf(`FUNCTION ${name}(${args}`);
  expect(start).toBeGreaterThan(-1);
  const open = SQL.indexOf('AS $function$', start) + 'AS $function$'.length;
  const close = SQL.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return SQL.slice(open, close);
}

const VOID_BODY = functionBody(
  'public.fn_ca_void_unsettled_cash_submission',
  '\n  p_table_id uuid, p_hand_number bigint, p_receipt_id uuid, p_reason text\n)'
);

const RESUME_BODY = functionBody(
  'public.fn_ca_resume_hand_submission',
  'p_table_id uuid, p_instance_id text, p_lease_generation uuid'
);

const MONEY_WRITE_PATTERNS = [
  /insert\s+into\s+public\.chip_ledger/i,
  /insert\s+into\s+public\.chip_transactions/i,
  /update\s+public\.club_members/i,
  /update\s+public\.table_seats\s+set\s+stack/i,
  /wallets/i,
  /fn_add_chips/i,
  /fn_credit_and_log/i,
];

describe('fn_ca_void_unsettled_cash_submission never moves a chip', () => {
  it('contains no write to any ledger, wallet, or stack column', () => {
    for (const pattern of MONEY_WRITE_PATTERNS) {
      expect(VOID_BODY).not.toMatch(pattern);
    }
  });

  it('refuses outright when a hand_atomic_commits row already exists for the hand', () => {
    const guardAt = VOID_BODY.indexOf(
      'EXISTS (SELECT 1 FROM public.hand_atomic_commits WHERE table_id = p_table_id AND hand_number = p_hand_number)'
    );
    const raiseAt = VOID_BODY.indexOf(
      "RAISE EXCEPTION 'HAND_SUBMISSION_VOID_ALREADY_SETTLED'",
      guardAt
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeGreaterThan(guardAt);
  });

  it('is service_role-only', () => {
    expect(VOID_BODY).toContain(
      "IF auth.role() IS DISTINCT FROM 'service_role' THEN\n    RAISE EXCEPTION 'HAND_SUBMISSION_VOID_ENGINE_ONLY'"
    );
  });

  it('refuses a tournament table (cash-only door)', () => {
    const tourAt = VOID_BODY.indexOf('IF tour IS NOT NULL THEN');
    const raiseAt = VOID_BODY.indexOf("RAISE EXCEPTION 'HAND_SUBMISSION_VOID_CASH_ONLY'", tourAt);
    expect(tourAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeGreaterThan(tourAt);
  });

  it('is receipt-idempotent: a replayed receipt returns the stored outcome, not a fresh write', () => {
    const lookupAt = VOID_BODY.indexOf(
      'SELECT * INTO existing FROM smarter_private.hand_submission_voids WHERE receipt_id = p_receipt_id'
    );
    const returnAt = VOID_BODY.indexOf("'replayed', true", lookupAt);
    const insertAt = VOID_BODY.indexOf('INSERT INTO smarter_private.hand_submission_voids');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(lookupAt);
    expect(returnAt).toBeLessThan(insertAt);
  });

  it('takes the same advisory lock key fn_ca_resume_hand_submission takes before it would ever commit', () => {
    const key =
      "hashtextextended('hand:submission:'||p_table_id::text||':'||p_hand_number::text,0)";
    expect(VOID_BODY).toContain(key);
    expect(RESUME_BODY).toContain(
      "hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0)"
    );
  });
});

describe('fn_ca_resume_hand_submission skips a voided submission', () => {
  it('adds a NOT EXISTS clause against hand_submission_voids to its candidate SELECT', () => {
    const selectAt = RESUME_BODY.indexOf(
      'SELECT j.* INTO s FROM smarter_private.hand_submissions j'
    );
    const orderByAt = RESUME_BODY.indexOf('ORDER BY j.hand_number LIMIT 1', selectAt);
    const voidClauseAt = RESUME_BODY.indexOf(
      'NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_voids v WHERE v.submission_id = j.submission_id)',
      selectAt
    );
    expect(selectAt).toBeGreaterThan(-1);
    expect(voidClauseAt).toBeGreaterThan(selectAt);
    expect(voidClauseAt).toBeLessThan(orderByAt);
  });
});

describe('the detector never repairs, only reports', () => {
  it('fn_ca_stuck_cash_hand_submission_check contains no INSERT/UPDATE/DELETE against money or submission state', () => {
    const body = functionBody('public.fn_ca_stuck_cash_hand_submission_check', '');
    expect(body).not.toMatch(/insert\s+into/i);
    expect(body).not.toMatch(/update\s+/i);
    expect(body).not.toMatch(/delete\s+from/i);
    expect(body).toContain('fn_ca_raise_drift_incident');
  });
});
