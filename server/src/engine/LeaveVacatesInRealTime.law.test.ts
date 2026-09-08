/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEAVING IS REAL TIME, AND A BUSTED SEAT IS FINISHED AT EVERY FORMAT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-05, after leaving a cash game on his desktop and finding the seat
 * still his on his phone:
 *
 *   "LEAVE TABLE OR GAME NEEDS TO BE REAL TIME, YOU LEAVE THE GAME, MOVE THE
 *    CHIPS TO THE PLAYER WALLET, VACATE THE SEAT, AND OPEN IT FOR ANOTHER
 *    PLAYER. THIS IS FOR CASH GAMES, BUT IM SURE THIS SAME BUG EXISTS IN ALL THE
 *    OTHER SEATS FOR MTT, SPINS AND HEADS UP AS WELL."
 *
 * Three engine-side defects, none of which had a test:
 *
 *   1. The deferred mid-hand leave wrote `status: 'sitting_out'` and nothing
 *      else. `status` is not the column anything reads: `trg_stamp_sit_out_at`
 *      stamps `sit_out_at` from `is_sitting_out`, `restoreSitOutsFromSeats`
 *      rebuilds a sit-out from `is_sitting_out`, and TablePage's ten-second seat
 *      poll READS `is_sitting_out`. Writing only `status` left all three blind.
 *
 *   2. That same branch emitted `seat_left` and then stopped - no state
 *      re-broadcast - so every other client kept a snapshot in which the player
 *      was still in the hand. The between-hands branches had always
 *      re-broadcast; the branch a player actually hits mid-hand was the silent
 *      one. The tournament sit-out branch was silent too.
 *
 *   3. THE ONE THAT ANSWERS DAN'S "ALL THE OTHER SEATS". The busted-seat vacate
 *      first sat inside the rebuy-only branch, so Spins, Heads-Up, and freezeout
 *      tournaments never reached it. Moving the write in TypeScript still left
 *      a crash window between the seat and standings updates. The hand-stack
 *      database authority now mirrors standings and releases every named zero
 *      seat in the same transaction for every tournament format.
 *
 * This file now asserts OWNERSHIP as well as reachability: the runtime may
 * publish the durable result, but it cannot write either half, while the
 * inspected SQL authority must mirror the stack before it releases the seat.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode, sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', 'engine', p), 'utf8');
const SEATING = read('ServerTableEngineSeating.ts');
const DEALING = read('ServerTableEngineDealing.ts');
const HAND_STACK_HARDENER = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908153329_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

describe('a departing seat is visible to everything that reads a seat', () => {
  it('the deferred mid-hand leave writes is_sitting_out, not status alone', () => {
    expect(SEATING).toMatch(
      /\.update\(\{ leave_pending: true, status: 'sitting_out', is_sitting_out: true \}\)/
    );
  });

  it('the tournament sit-out writes it too', () => {
    expect(SEATING).toMatch(/\.update\(\{ status: 'sitting_out', is_sitting_out: true \}\)/);
  });

  it('no leave path writes status without the boolean anything reads', () => {
    /* The whole defect in one assertion: a `status: 'sitting_out'` update with
       no `is_sitting_out` beside it is invisible to the trigger, the restart
       restore and the client poll. */
    const writes = SEATING.match(/\.update\(\{[^}]*status: 'sitting_out'[^}]*\}\)/g) || [];
    expect(writes.length, 'both sit-out writes must be present').toBeGreaterThanOrEqual(2);
    for (const write of writes) {
      expect(write, `this write is invisible to the sit-out trigger: ${write}`).toContain(
        'is_sitting_out: true'
      );
    }
  });
});

describe('every device is told when a seat changes hands', () => {
  /* Both windows are bounded by the BRANCH that encloses the write, never by a
     byte count: a fixed window drifts off the code it guards as comments are
     added, and it can drift while staying green
     (tests/unit/noFixedSizeSourceWindows.test.ts). */
  it('the deferred mid-hand leave re-broadcasts state', () => {
    const branch = sliceEnclosingBlock(
      SEATING,
      "update({ leave_pending: true, status: 'sitting_out', is_sitting_out: true })"
    );
    expect(branch, 'the deferred leave branch has moved or gone').not.toBe('');
    expect(branch, 'a seat_left with no state broadcast leaves every other client stale').toMatch(
      /this\.broadcastCurrentState\(\);/
    );
  });

  it('the tournament sit-out re-broadcasts state', () => {
    /* Anchored on the tournament branch's own write - `disconnectEngine.sitOut`
       appears in several places, and the first is the sitOut() method, not this
       branch. */
    const branch = sliceEnclosingBlock(
      SEATING,
      "update({ status: 'sitting_out', is_sitting_out: true })"
    );
    expect(branch, 'the tournament sit-out branch has moved or gone').not.toBe('');
    expect(
      branch,
      'a tournament sit-out that broadcasts nothing leaves every other device stale'
    ).toMatch(/this\.broadcastCurrentState\(\);/);
  });
});

describe('a busted seat is vacated at EVERY tournament format', () => {
  const bustedFlow = sliceEnclosingBlock(DEALING, 'if (justBustedPlayers.length > 0) {');
  const hardenerStart = HAND_STACK_HARDENER.indexOf('v_sync_replacement text := $replacement$');
  const hardenerEnd = HAND_STACK_HARDENER.indexOf('v_result_needle text :=', hardenerStart);
  const atomicWrite = HAND_STACK_HARDENER.slice(hardenerStart, hardenerEnd);

  it('keeps only the rebuy-window decision inside the rebuy gate', () => {
    expect(bustedFlow).toContain('if (t && (t.is_rebuy ||');
    expect(bustedFlow).toMatch(/rebuy_levels|windowOpen/);
    expect(bustedFlow).toContain("reason: 'busted_awaiting_rebuy_decision'");
  });

  it('has no second process-side standings or seat writer after a bust', () => {
    const code = blankNonCode(bustedFlow);
    expect(code).not.toContain(".from('table_seats')");
    expect(code).not.toContain(".from('tournament_players')");
    expect(code).not.toContain('update({ left_at:');
    expect(code).not.toContain('update({ chips: 0 })');
  });

  it('the hand-stack authority mirrors standings before releasing zero-stack seats', () => {
    expect(hardenerStart).toBeGreaterThan(-1);
    expect(hardenerEnd).toBeGreaterThan(hardenerStart);
    const mirror = atomicWrite.indexOf('UPDATE public.tournament_players tp');
    const vacate = atomicWrite.indexOf('UPDATE public.table_seats ts', mirror + 1);
    expect(mirror).toBeGreaterThan(-1);
    expect(vacate).toBeGreaterThan(mirror);
    expect(atomicWrite.slice(mirror, vacate)).toMatch(/SET chips = target\.stack/);
    expect(atomicWrite.slice(vacate)).toMatch(
      /SET left_at = v_zero_stack_vacated_at,[\s\S]*status = 'left'/
    );
    expect(HAND_STACK_HARDENER).toContain("'tournament_players_synced'");
    expect(HAND_STACK_HARDENER).toContain("'tournament_zero_stack_seats_vacated'");
  });

  it('installs the atomic write by hardening and executing the inspected RPC body', () => {
    expect(HAND_STACK_HARDENER).toContain('SELECT pg_get_functiondef(p.oid) INTO v_definition');
    expect(HAND_STACK_HARDENER).toContain(
      "'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure"
    );
    expect(HAND_STACK_HARDENER).toContain(
      'v_hardened := replace(v_hardened,v_sync_needle,v_sync_replacement);'
    );
    expect(HAND_STACK_HARDENER).toContain('EXECUTE v_hardened;');
    expect(blankNonCode(atomicWrite)).not.toMatch(/is_rebuy|is_reentry|tournament_type|variant/);
  });
});
