/**
 * THE CASH-OUT / ADD-ON RACE — pinned so it cannot open a third time.
 *
 * History, because it is the reason these assertions are shaped this way:
 *
 *   2026-08-25  A trigger starts recording every non-zero seat exit.
 *   2026-08-26  `atomic_table_addon` gains FOR UPDATE "so this serialises with
 *               atomic_table_cashout", plus a zero-row guard. Both correct.
 *               Both INERT: the engine does not call atomic_table_cashout.
 *   2026-08-27  The bug fires again (exit 21541, 137.10 chips). The engine's
 *               own cash-out never took the lock. Fixed by moving read+credit+
 *               vacate into one locked transaction.
 *
 * These are source-pinned rather than behaviour-mocked on purpose: the defect
 * lives in the SHAPE of the code (how many transactions, does the read lock),
 * which a mock of the Supabase client cannot observe. Everything asserted here
 * is a property someone could quietly undo while all behavioural tests stay
 * green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../');
const SEATS = readFileSync(resolve(ROOT, 'server/src/services/supabase/seats.ts'), 'utf8');

const MIGRATION = (() => {
  const dir = resolve(ROOT, 'supabase/migrations');
  const f = readdirSync(dir).find((n) => n.includes('cashout_must_take_the_lock'));
  if (!f) throw new Error('the cash-out lock migration is missing from supabase/migrations');
  return readFileSync(resolve(dir, f), 'utf8');
})();

describe('the engine cashes out through the locked RPC', () => {
  it('both cash-out paths converge on the occupancy-bound locked transaction', () => {
    expect(SEATS).toMatch(/rpc\(\s*'fn_cashout_seat_occupancy'/);
    const delegated = SEATS.slice(
      SEATS.indexOf('export async function markSeatAsLeft('),
      SEATS.indexOf('export async function atomicCashout(')
    );
    expect(delegated).toMatch(/await atomicCashout\(/);
    expect(delegated).toContain('occupancyId');
  });

  it('neither path credits the wallet directly any more', () => {
    /* A direct credit here means the stack was read in a SEPARATE transaction
       from the credit - which is the bug. The credit belongs inside the RPC,
       under the lock. */
    expect(SEATS).not.toMatch(/atomic_credit_wallet_and_log/);
  });

  it('neither path stamps left_at itself', () => {
    /* Vacating outside the RPC re-opens the gap even if the credit moved: the
       seat could be cleared while an add-on is still in flight. */
    expect(SEATS).not.toMatch(/left_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('records why, so the next reader does not "simplify" it back', () => {
    expect(SEATS).toMatch(/One side of a handshake is not a handshake/);
  });
});

describe('the migration is the half of the handshake that was missing', () => {
  it('takes FOR UPDATE on the seat row', () => {
    expect(MIGRATION).toMatch(/FOR UPDATE/);
  });

  it('asserts the add-on still holds its own half', () => {
    /* If a later change strips FOR UPDATE from atomic_table_addon, this lock
       is talking to nobody again - exactly the 2026-08-26 failure, mirrored. */
    expect(MIGRATION).toMatch(/atomic_table_addon lost its FOR UPDATE/);
  });

  it('is not callable by anon', () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.atomic_seat_cashout_locked/);
    expect(MIGRATION).toMatch(/anon can execute atomic_seat_cashout_locked/);
  });
});

describe('the idempotency key must match what PostgREST wrote', () => {
  /* This is the one that would have COST money rather than saved it.
     to_char(...'.US') pads microseconds to six digits; PostgREST trims trailing
     zeros. A key that does not match is a key that does not dedupe, so a
     committed-but-timed-out credit would be retried and PAY TWICE. Verified
     against five real timestamp shapes: to_json matched all five, to_char one. */
  it('derives the timestamp with to_json, never to_char padding', () => {
    /* Scoped to the DERIVATION, not the whole file: the migration's own guard
       quotes the forbidden format string in order to forbid it, and a blanket
       match on the filename would fail on that guard - which is the thing
       protecting us. Assert on the assignment, and that to_char is never
       CALLED. */
    const derivation = MIGRATION.slice(
      MIGRATION.indexOf('v_key := CASE'),
      MIGRATION.indexOf("v_legacy := 'cashout:'")
    );
    expect(derivation).toMatch(/to_json\(v_seat\.joined_at\)/);
    expect(derivation).not.toMatch(/to_char\s*\(/);
    // And nowhere in the migration does a to_char call build a key.
    expect(MIGRATION).not.toMatch(/to_char\s*\([^)]*joined_at/);
  });

  it('keeps the guard that forbids the padding format coming back', () => {
    expect(MIGRATION).toMatch(/to_char padding again/);
  });

  it('keeps the key scoped to the occupancy, not the bare seat id', () => {
    /* The tournament balancer REUSES a table_seats row for the next occupant.
       Keyed on seat id alone, the first occupant to cash out poisons the seat
       for everyone after them. */
    expect(MIGRATION).toMatch(/cashout:'\s*\|\|\s*v_seat\.id\s*\|\|\s*':'/);
  });
});
