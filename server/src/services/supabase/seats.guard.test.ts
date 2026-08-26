/**
 * REGRESSION GUARDS - a seat is never vacated while it still holds uncredited chips.
 *
 * WHY THIS FILE EXISTS
 *
 * fn_unaccounted_seat_exits() reported two exits on 2026-08-26 whose stacks had
 * no matching wallet credit: 85.85 chips at 09:38 UTC and 45.00 at 12:55. The
 * detector had been in place since the 2026-08-25 incident and nobody had read
 * it.
 *
 * markSeatAsLeft was the cause of the first. Its happy path is careful - every
 * credit failure returns without vacating - but its catch block vacated the seat
 * unconditionally. Any throw between reading the stack and crediting it (a
 * transport error on the RPC, a timeout) therefore erased the stack: the wallet
 * was never credited and the chips existed nowhere afterwards.
 *
 * atomicCashout, in the same file, has been guarded against exactly this since
 * SWEEP #4 P0-3 via its `safeToClearSeat` flag. markSeatAsLeft never received
 * the same fix. These guards make that asymmetry impossible to reintroduce.
 *
 * If one of these rules is deliberately superseded, delete the guard IN THE SAME
 * COMMIT and say why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SEATS = fs.readFileSync(path.join(process.cwd(), 'src/services/supabase/seats.ts'), 'utf8');

/** Extract one top-level `export async function <name>(...) { ... }` body. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found in seats.ts`).toBeGreaterThan(-1);
  let i = src.indexOf('{', start);
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

  it('markSeatAsLeft declares the safeToClearSeat guard', () => {
    expect(markSeatAsLeft).toContain('let safeToClearSeat = false');
  });

  it('markSeatAsLeft only arms the guard after the credit path has passed', () => {
    const armed = markSeatAsLeft.indexOf('safeToClearSeat = true');
    const softDelete = markSeatAsLeft.indexOf('leave_pending: false');
    expect(armed, 'safeToClearSeat is never armed').toBeGreaterThan(-1);
    expect(armed, 'the guard must be armed before the seat is soft-deleted').toBeLessThan(softDelete);
  });

  it('markSeatAsLeft never vacates a seat from its catch block unguarded', () => {
    const catchIdx = markSeatAsLeft.lastIndexOf('} catch (');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = markSeatAsLeft.slice(catchIdx);
    expect(catchBlock).toContain('if (safeToClearSeat)');
    // the vacate must sit inside the guarded branch, not before it
    expect(catchBlock.indexOf('if (safeToClearSeat)')).toBeLessThan(catchBlock.indexOf('left_at:'));
  });

  it('every left_at write in markSeatAsLeft is scoped to the seat it was asked about', () => {
    // A write scoped only by table_id + user_id vacates EVERY active seat that
    // player holds at the table, including one holding a stack this call never
    // read and therefore never credited.
    const writes = markSeatAsLeft.split('left_at: new Date().toISOString()');
    // writes[0] is the text before the first write; each subsequent chunk is the
    // filter chain that follows one write.
    for (let i = 1; i < writes.length; i++) {
      const chain = writes[i].slice(0, 400);
      expect(chain, `left_at write #${i} in markSeatAsLeft is not scoped to seat_number`).toContain(
        "eq('seat_number', seatNumber)"
      );
    }
  });

  it('atomicCashout keeps the guard it has had since SWEEP #4 P0-3', () => {
    expect(atomicCashout).toContain('safeToClearSeat');
    const catchIdx = atomicCashout.lastIndexOf('} catch (');
    expect(atomicCashout.slice(catchIdx)).toContain('if (safeToClearSeat)');
  });

  it('both cash-out paths still dedupe on the same idempotency key', () => {
    expect(markSeatAsLeft).toContain('cashoutKey(seat)');
    expect(atomicCashout).toContain('cashoutKey(seat)');
  });
});
