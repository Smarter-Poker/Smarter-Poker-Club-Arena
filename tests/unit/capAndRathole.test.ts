/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CAP AND NO RATHOLE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The last two entries in Phase 2 of the parity audit. Both had a working
 * toggle, a real column, and no reader.
 *
 * NO RATHOLE was worse than unenforced: the lobby printed a medallion for it
 * reading "Players must return with their full previous stack", so the
 * platform was actively asserting a rule it did not keep.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceStatement, sliceBlockAfter, sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');
const SELECT = read('server/src/services/supabase/tables.ts');
const RATHOLE_MIGRATION = read(
  'supabase/migrations/20260825_atomic_table_buyin_enforces_no_rathole.sql'
);

describe('Cap', () => {
  it('has an amount to enforce, which it never had before', () => {
    // cap_enabled was the ONLY cap column in the schema. A boolean cannot cap
    // anything, so even a reader could not have enforced it.
    expect(SELECT).toContain('cap_enabled');
    expect(SELECT).toContain('cap_bb');
  });

  it('measures the ceiling against the WHOLE HAND, not one street', () => {
    // player.bet is this street only; capping on that would let a player
    // commit the cap once per street, four times over.
    // Two different scopes on purpose. The positive is about the cap block as
    // a whole; the negative is about ONE statement, and widening it to the
    // block made it read a `player.bet` belonging to something else entirely.
    expect(sliceEnclosingBlock(TURNS, 'const capBB =')).toContain('totalInvested');
    expect(sliceStatement(TURNS, 'const capRemaining =')).not.toMatch(/player\.bet/);
  });

  it('is Infinity when the table is uncapped, so every clamp is a no-op', () => {
    // The human action path retains Infinity as its arithmetic no-op. The
    // Phase 5 canonical menu represents the same state as null so it can cross
    // the worker boundary without serializing a non-finite number.
    const humanCap = sliceEnclosingBlock(TURNS, '── CAP: A PER-HAND CEILING');
    expect(humanCap).toMatch(/const capRemaining =[\s\S]*?: Infinity;/);
    expect(TURNS).toContain('commitmentCapRemaining: null');
  });

  it('CLAMPS rather than rejects, like the pot-limit ceiling beside it', () => {
    expect(TURNS).toContain('amount = Math.min(amount, capRemaining);');
    expect(TURNS).toContain('const capRaiseTo =');
    // ABOVE_MAX_RAISE is never emitted: a client with a stale cap should still
    // make a legal bet rather than have its action bounce.
    expect(TURNS).not.toContain("'ABOVE_MAX_RAISE'");
  });

  it('closes the all-in hole, which skips every amount clamp', () => {
    // validateAllIn returns sanitizedAmount: playerStack unconditionally, so
    // without this the cap would hold for every action EXCEPT the largest.
    const fn = sliceBlockAfter(
      TURNS,
      "if (normalizedAction === 'all_in' && capRemaining !== Infinity)"
    );
    expect(fn).toContain('Math.min(player.stack, capRemaining)');
    expect(fn).toMatch(/normalizedAction = state\.currentBet > 0 \? 'raise' : 'bet'/);
  });

  it('refuses a full call that crosses the caller cap without inventing an under-call', () => {
    // Forced/dead contributions can make caller and bettor whole-hand totals
    // unequal. The legal menu and authoritative action path both fail closed;
    // neither truncates a call into a non-all-in partial call.
    expect(TURNS).toContain('source.toCall > capRemaining + 0.005');
    expect(TURNS).toContain('toCall > capRemaining + 0.005');
    expect(TURNS).toContain("Calling would exceed this table's per-hand commitment cap");
    expect(TURNS).not.toContain('Math.min(toCall, capRemaining)');
  });

  it('leaves a capped player with chips in front of them', () => {
    // That is the whole point of a cap game: reaching the ceiling is not
    // being all-in, and the remaining stack plays the next hand.
    const block = sliceEnclosingBlock(TURNS, '── CAP: A PER-HAND CEILING');
    expect(block).toContain('their remaining stack stays');
  });
});

describe('No Rathole', () => {
  it('reads the stack the player left with, which was already recorded', () => {
    expect(RATHOLE_MIGRATION).toContain('left_at IS NOT NULL');
    expect(RATHOLE_MIGRATION).toContain('ORDER BY ts.left_at DESC');
  });

  it('caps the floor at the table maximum', () => {
    // A player who won a big pot must not be asked to bring back more than
    // the table will accept — that locks them out of their own game forever.
    expect(RATHOLE_MIGRATION).toContain('v_rathole_floor > v_max_buy_in');
  });

  it('runs BEFORE the function erases the history it depends on', () => {
    // atomic_table_buyin deletes departed rows for the seat being taken. The
    // check must precede that or it reads nothing when a player returns to
    // the same seat number. The migration asserts this itself.
    expect(RATHOLE_MIGRATION).toContain(
      'the check landed after the departed-seat DELETE and would read nothing'
    );
  });

  it('does nothing at all when the host has not asked for it', () => {
    expect(RATHOLE_MIGRATION).toContain('IF v_no_rathole THEN');
    expect(RATHOLE_MIGRATION).toContain('COALESCE(t.no_rathole, false)');
  });
});
