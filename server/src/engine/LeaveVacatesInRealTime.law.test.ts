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
    '20260909215641_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

const DEPARTURE_SQL = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908220604_bind_cashout_requests_to_seat_occupancy.sql'
  ),
  'utf8'
);
const CASH_LEAVE = sliceEnclosingBlock(
  SEATING,
  'A deferred acknowledgement requires a durable request'
);
const TOURNAMENT_LEAVE = sliceEnclosingBlock(
  SEATING,
  'In tournaments, leaving the table NEVER cashes out'
);

describe('a departing seat is durably visible through the occupancy transaction', () => {
  it.each([
    ['cash', CASH_LEAVE],
    ['tournament', TOURNAMENT_LEAVE],
  ])('%s departure awaits the original occupancy request', (_name, branch) => {
    expect(branch).not.toBe('');
    expect(branch).toMatch(/await requestSeatDeparture\(/);
    expect(branch).toContain('player.occupancy_id');
  });
  it('the transaction writes both sit-out columns and cash-only pending state', () => {
    expect(DEPARTURE_SQL).toMatch(/SET status='sitting_out',is_sitting_out=true/);
    expect(DEPARTURE_SQL).toMatch(
      /leave_pending=CASE WHEN v_tournament IS NULL THEN true ELSE leave_pending END/
    );
  });
});

describe('every device is told after durable departure', () => {
  it.each([
    ['cash', CASH_LEAVE],
    ['tournament', TOURNAMENT_LEAVE],
  ])('%s departure re-broadcasts state after confirmation', (_name, branch) => {
    expect(branch).toContain('this.broadcastCurrentState();');
    expect(branch.indexOf('await requestSeatDeparture(')).toBeGreaterThan(-1);
    expect(branch.indexOf('this.broadcastCurrentState();')).toBeGreaterThan(
      branch.indexOf('await requestSeatDeparture(')
    );
  });
});

describe('a busted seat is vacated at EVERY tournament format', () => {
  const bustedFlow = sliceEnclosingBlock(DEALING, 'if (justBustedPlayers.length > 0) {');
  const hardenerStart = HAND_STACK_HARDENER.indexOf(
    'CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute('
  );
  const hardenerEnd = HAND_STACK_HARDENER.indexOf('$function$;', hardenerStart);
  const atomicWrite = HAND_STACK_HARDENER.slice(hardenerStart, hardenerEnd);
  const zeroStackVacateStart = atomicWrite.indexOf(
    '-- A named zero-stack tournament seat is finished on the felt'
  );
  const zeroStackVacateEnd = atomicWrite.indexOf(
    'SELECT count(*) INTO v_table_live_seat_count',
    zeroStackVacateStart
  );
  const zeroStackVacate = atomicWrite.slice(zeroStackVacateStart, zeroStackVacateEnd);

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

  it('installs a complete source-controlled atomic body, never a catalog patch', () => {
    expect(HAND_STACK_HARDENER).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute('
    );
    expect(HAND_STACK_HARDENER).not.toContain('v_hardened := replace(');
    expect(HAND_STACK_HARDENER).not.toContain('EXECUTE v_hardened;');
    expect(zeroStackVacateStart).toBeGreaterThan(-1);
    expect(zeroStackVacateEnd).toBeGreaterThan(zeroStackVacateStart);
    expect(blankNonCode(zeroStackVacate)).not.toMatch(
      /is_rebuy|is_reentry|tournament_type|variant/
    );
  });
});
