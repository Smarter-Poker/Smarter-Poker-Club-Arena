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
    const block = TURNS.slice(TURNS.indexOf('const capBB ='), TURNS.indexOf('const capBB =') + 900);
    expect(block).toContain('totalInvested');
    expect(block).not.toMatch(/capRemaining\s*=[\s\S]{0,120}player\.bet/);
  });

  it('is Infinity when the table is uncapped, so every clamp is a no-op', () => {
    const block = TURNS.slice(
      TURNS.indexOf('const capRemaining ='),
      TURNS.indexOf('const capRemaining =') + 220
    );
    expect(block).toContain('Infinity');
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
    const fn = TURNS.slice(
      TURNS.indexOf("if (normalizedAction === 'all_in' && capRemaining !== Infinity)")
    );
    expect(fn.slice(0, 600)).toContain('Math.min(player.stack, capRemaining)');
    expect(fn.slice(0, 600)).toMatch(/normalizedAction = state\.currentBet > 0 \? 'raise' : 'bet'/);
  });

  it('does NOT cap a call, and says why', () => {
    // A short call is an under-call the pot logic must turn into a side pot —
    // a real integrity hazard. It is also unnecessary: every wager that can be
    // called has already been clamped, so a caller can never pass a ceiling
    // the bettor in front of them already respects.
    const call = TURNS.slice(TURNS.indexOf('A CALL IS DELIBERATELY NOT CAPPED'));
    expect(call.slice(0, 900)).toContain('side pot');
    expect(TURNS).toContain("if (normalizedAction === 'call') amount = toCall;");
  });

  it('leaves a capped player with chips in front of them', () => {
    // That is the whole point of a cap game: reaching the ceiling is not
    // being all-in, and the remaining stack plays the next hand.
    const block = TURNS.slice(TURNS.indexOf('── CAP: A PER-HAND CEILING'));
    expect(block.slice(0, 1600)).toContain('their remaining stack stays');
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
