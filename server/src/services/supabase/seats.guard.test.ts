/**
 * REGRESSION GUARDS - a seat is never vacated while it still holds uncredited chips.
 *
 * ── 2026-08-27: THESE GUARDS WERE DELIBERATELY REPLACED ────────────────────
 * The previous version of this file pinned `safeToClearSeat`, the catch-block
 * branch, the seat_number scoping on each `left_at` write, and `cashoutKey(seat)`
 * appearing in both functions. Its own header said: "If one of these rules is
 * deliberately superseded, delete the guard IN THE SAME COMMIT and say why."
 * So, why:
 *
 * Every one of those rules was an APPROXIMATION of a single property - that
 * reading the stack, crediting it, and vacating the seat must not come apart.
 * They approximated it because the three steps were three separate PostgREST
 * round-trips, i.e. three transactions, and the only defence available in
 * TypeScript was to sequence them carefully and track a boolean.
 *
 * Careful sequencing was not enough, and the reason is the bug this commit
 * fixes: the first of those three round-trips took NO LOCK. `atomic_table_addon`
 * could commit `stack = stack + n` between the read and the credit, so the
 * credit paid the pre-add-on stack while the seat exit recorded the post-add-on
 * one. Three times in 30 days, 205.68 chips, each reconstructing to the penny as
 * `cash-out + add-on == stack`. `safeToClearSeat` was true and correct
 * throughout - it is not a guard against reading the wrong number.
 *
 * Read, credit and vacate now happen inside `atomic_seat_cashout_locked`, in ONE
 * transaction, with the seat row held under FOR UPDATE. The old properties are
 * no longer approximated, they are structural:
 *
 *   - a failed credit cannot leave a vacated seat, because they roll back
 *     together (this is what safeToClearSeat was for);
 *   - the vacate cannot hit a seat the call never read, because it is scoped to
 *     the row the RPC itself locked (this is what the seat_number scoping was
 *     for);
 *   - the two paths cannot dedupe differently, because the key is derived from
 *     that same locked row (this is what cashoutKey(seat) was for).
 *
 * What is pinned below is therefore the stronger rule: NOTHING about cashing a
 * seat out may happen in TypeScript any more. If a credit, a `left_at` write, or
 * a stack read reappears in this file, the race is back - and it will not
 * announce itself, because it only fires when an add-on lands in a window of a
 * few hundred milliseconds.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SEATS = fs.readFileSync(path.join(process.cwd(), 'src/services/supabase/seats.ts'), 'utf8');

/** Extract one top-level `export async function <name>(...) { ... }` body. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found in seats.ts`).toBeGreaterThan(-1);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

describe('seats.ts - chips cannot leave the felt uncredited', () => {
  const markSeatAsLeft = fnBody(SEATS, 'markSeatAsLeft');
  const atomicCashout = fnBody(SEATS, 'atomicCashout');

  it('both cash-out paths go through the locked RPC', () => {
    expect(markSeatAsLeft).toContain('atomic_seat_cashout_locked');
    expect(atomicCashout).toContain('atomic_seat_cashout_locked');
  });

  it('there is exactly ONE implementation of cashing a seat out', () => {
    /* The two paths have already drifted apart twice while being patched
       separately (2026-08-22 credited different wallets; 2026-08-26 fixed the
       catch block in one and not the other). Sharing the RPC is what stops a
       third time.

       SCOPED TO THE CASH-OUT PATHS 2026-08-30, and the widening is deliberate
       rather than a relaxation. This asserted over the WHOLE FILE, so it read
       "seats.ts calls exactly one RPC" — which happened to be true only while
       the seat-offer path was hand-written TypeScript. That path became
       `fn_offer_open_seat` (one transaction, so the queue-head claim stops
       racing), and this went red for a function that moves no chips at all.

       The rule being protected is about CASHING OUT, so it is asserted about
       the two cash-out bodies. A third cash-out implementation still fails
       this; an unrelated RPC elsewhere in the file no longer does. */
    const cashoutRpcs = [
      ...markSeatAsLeft.matchAll(/rpc\(\s*'([a-z_]+)'/g),
      ...atomicCashout.matchAll(/rpc\(\s*'([a-z_]+)'/g),
    ].map((m) => m[1]);
    expect(new Set(cashoutRpcs)).toEqual(new Set(['atomic_seat_cashout_locked']));

    /* And no OTHER function in this file may cash a seat out. That is the half
       the whole-file assertion was really buying, kept explicitly.

       Comments stripped first: this file's docstrings name the RPC repeatedly
       (that is the point of them), and prose describing the rule must not read
       as a third implementation of it. */
    const outsideCode = SEATS.replace(markSeatAsLeft, '')
      .replace(atomicCashout, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(outsideCode).not.toMatch(/atomic_seat_cashout_locked/);
  });

  it('neither path credits a wallet itself', () => {
    // A credit here is a second transaction, and a second transaction is the race.
    expect(SEATS).not.toContain('atomic_credit_wallet_and_log');
    expect(SEATS).not.toContain('credit_player_wallet');
  });

  it('neither path writes left_at itself', () => {
    /* Vacating outside the RPC re-opens the gap even if the credit moved: the
       seat could be cleared while an add-on is still in flight, and the add-on's
       own zero-row guard would then be the only thing standing between a debited
       wallet and nothing. */
    expect(SEATS).not.toMatch(/left_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('neither path reads the seat stack before cashing out', () => {
    /* THE bug, stated directly. An unlocked `SELECT ... stack` followed by a
       credit is what destroyed 205.68 chips. The stack must only ever be read
       inside the transaction that holds the row. */
    expect(SEATS).not.toMatch(/select\(\s*['"][^'"]*\bstack\b/);
  });

  it('records why the old guards went, so they are not "restored"', () => {
    expect(SEATS).toContain('One side of a handshake is not a handshake');
  });
});
