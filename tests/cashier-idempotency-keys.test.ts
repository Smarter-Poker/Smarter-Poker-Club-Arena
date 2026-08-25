/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER IDEMPOTENCY — every money RPC carries a key, and the key is scoped
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * The dangerous shape on this page is not a double tap - `busyRef` stops that.
 * It is a request that COMMITTED on the server and then failed on the way back:
 * a dropped connection, a proxy timeout. To the client that is indistinguishable
 * from a request that never ran, and the natural next step, retrying, takes the
 * chips a second time.
 *
 * Claim Back was hardened against that on 2026-08-24. Send Out and Send Ticket
 * were not, for four months, even though the client already minted and RETAINED
 * a submission id specifically so a retry could be recognised - they simply did
 * not pass it. Migration 20260825300000 gave both functions the guard and this
 * pins the client half.
 *
 * THE SCOPE MATTERS AS MUCH AS THE PRESENCE. The unique index behind all this
 * is GLOBAL on chip_transactions.metadata, so a key without the club in it can
 * collide across clubs - and chips are PER CLUB (CLAUDE.md). A cross-club
 * collision replays the other club's outcome, moves nothing, and reports
 * success: money the user believes they moved never moved.
 *
 * Source-level assertions on purpose. Mounting the page cannot prove an
 * argument reaches an RPC without a live database, and the argument being
 * absent is exactly the defect.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/CashierTradePage.tsx'), 'utf8');

/** The body of runTransfers, where every chip movement on this page happens. */
const RUN_TRANSFERS = PAGE.slice(
  PAGE.indexOf('const runTransfers ='),
  PAGE.indexOf('const initial = (name: string)')
);

/**
 * One RPC call's argument object, sliced by SYNTAX rather than by a fixed
 * character count. A `+ 1400` window is exactly what broke the sibling test in
 * tests/config/claimBackIdempotency.test.ts when a comment was added inside a
 * call: the window silently stopped covering the thing it is named after.
 */
function callArgs(rpc: string): string {
  const start = RUN_TRANSFERS.indexOf(`supabase.rpc('${rpc}'`);
  if (start < 0) return '';
  const end = RUN_TRANSFERS.indexOf('});', start);
  return end < 0 ? RUN_TRANSFERS.slice(start) : RUN_TRANSFERS.slice(start, end + 3);
}

describe('every money RPC on the cashier carries an idempotency key', () => {
  it('finds the function it is asserting about', () => {
    expect(RUN_TRANSFERS.length).toBeGreaterThan(500);
    expect(RUN_TRANSFERS).toContain('fn_cashier_send_chips');
    expect(RUN_TRANSFERS).toContain('fn_issue_tournament_ticket');
    expect(RUN_TRANSFERS).toContain('fn_cashier_claim_back');
  });

  it.each([
    ['fn_cashier_send_chips', 'send'],
    ['fn_issue_tournament_ticket', 'ticket'],
    ['fn_cashier_claim_back', 'claim'],
  ])('%s passes p_idempotency_key prefixed "%s"', (rpc, prefix) => {
    const call = callArgs(rpc);
    expect(call).toContain('p_idempotency_key');
    expect(call).toContain(`\`${prefix}:`);
  });

  it.each([['fn_cashier_send_chips'], ['fn_issue_tournament_ticket'], ['fn_cashier_claim_back']])(
    '%s scopes its key to the club, the submission, the target and the amount',
    (rpc) => {
      const call = callArgs(rpc);
      const key = call.slice(call.indexOf('p_idempotency_key'));
      // clubUuid FIRST: chips are per club and the unique index is global, so a
      // key without it can collide across clubs and silently replay.
      expect(key).toMatch(/\$\{clubUuid\}/);
      expect(key).toMatch(/\$\{submissionId\}/);
      expect(key).toMatch(/\$\{t\.userId\}/);
      // the amount, so a different amount is a different intent
      expect(key).toMatch(/\$\{(value|claim)\}/);
    }
  );
});

describe('the submission nonce belongs to ONE intent', () => {
  it('is cleared when the amount or the selection changes', () => {
    /**
     * Without this the nonce was minted only when null and cleared only on a
     * fully clean batch, so it survived a partial failure into every later
     * submission - and a genuinely new claim of the same amount from the same
     * player replayed the old one and moved nothing while reporting success.
     */
    expect(PAGE).toMatch(
      /useEffect\(\(\) => \{\s*submissionIdRef\.current = null;\s*\},\s*\[amount, selected, clubUuid\]\)/
    );
  });

  it('is still retained across a failure, which is what makes a retry safe', () => {
    // Cleared only when everything went through; a partial batch keeps it so
    // the committed targets replay instead of being charged twice.
    expect(RUN_TRANSFERS).toMatch(
      /if \(skipped \+ ok === targets\.length\) submissionIdRef\.current = null;/
    );
  });
});

describe('the migration that makes the keys mean anything', () => {
  const MIGRATION = readFileSync(
    resolve(__dirname, '../supabase/migrations/20260825300000_send_and_ticket_idempotency.sql'),
    'utf8'
  );

  it('adds the parameter to both functions', () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_cashier_send_chips[\s\S]{0,400}p_idempotency_key text/
    );
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_issue_tournament_ticket[\s\S]{0,400}p_idempotency_key text/
    );
  });

  it('drops the unkeyed 4-arg forms, so PostgREST cannot resolve to one', () => {
    // Adding a parameter CREATES a new function; leaving the old one lets a
    // caller reach a version with no replay guard at all.
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.fn_cashier_send_chips(uuid, uuid, numeric, text);'
    );
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.fn_issue_tournament_ticket(uuid, uuid, numeric, text);'
    );
  });

  it('relies on the unique index, not only on the pre-check', () => {
    // A pre-check alone loses the race between two concurrent identical
    // submissions, which is precisely the double-charge being prevented.
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_chip_transactions_idempotency_key'
    );
    expect(MIGRATION.match(/exception when unique_violation then/g) ?? []).toHaveLength(2);
  });

  it('never leaves anon able to move money', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_cashier_send_chips[^\n]*FROM anon/
    );
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_issue_tournament_ticket[^\n]*FROM anon/
    );
  });
});
