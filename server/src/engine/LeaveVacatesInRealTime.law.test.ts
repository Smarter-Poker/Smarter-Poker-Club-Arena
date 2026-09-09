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
 *      - the block whose own comment says "BUSTED PLAYERS DO NOT LINGER" - sat
 *      INSIDE `if (t && (t.is_rebuy || t.is_reentry))`. spinSpec and headsUpSpec
 *      declare neither, and a freezeout MTT declares neither by definition, so
 *      that block had never once executed for Spins, Heads-Up or freezeout
 *      tournaments. Those seats waited up to five seconds for the elimination
 *      sweep instead.
 *
 * The existing law (tests/unit/allInShowsAndBustsClear.law.test.ts) slices that
 * block by string and asserts its CONTENTS, which is exactly how a block that
 * was never reached kept passing. This file asserts REACHABILITY: it walks the
 * braces and proves the vacate is not nested inside the rebuy gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', 'engine', p), 'utf8');
const SEATING = read('ServerTableEngineSeating.ts');
const DEALING = read('ServerTableEngineDealing.ts');

/** First line at which brace depth returns to 0, ignoring strings and comments. */
function closesBefore(lines: string[], from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const line = lines[i]
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\/\/.*$/, '')
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/`[^`]*`/g, '``');
    for (const c of line) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth === 0 && i > from) return i;
  }
  return -1;
}

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
  const lines = DEALING.split('\n');
  const gate = lines.findIndex((l) => l.includes('if (t && (t.is_rebuy'));
  const vacate = lines.findIndex(
    (l, i) => i > gate && l.includes('update({ left_at: new Date().toISOString() })')
  );

  it('still has both landmarks', () => {
    expect(gate, 'the rebuy-window gate has moved or gone').toBeGreaterThan(-1);
    expect(vacate, 'the busted-seat vacate has moved or gone').toBeGreaterThan(gate);
  });

  it('does NOT nest the vacate inside the rebuy/re-entry gate', () => {
    /* THE REGRESSION THIS EXISTS FOR. Nested, this block is dead code for every
       Spin, every Heads-Up match and every freezeout MTT - which is most of the
       tournament product. A contents-only assertion cannot see that; brace depth
       can. */
    const closes = closesBefore(lines, gate, vacate);
    expect(
      closes,
      'the rebuy gate never closes before the vacate - the vacate is unreachable ' +
        'for Spins, Heads-Up and freezeout MTTs'
    ).toBeGreaterThan(-1);
    expect(closes).toBeLessThan(vacate);
  });

  it('keeps the rebuy arithmetic gated, because that part really is rebuy-only', () => {
    const closes = closesBefore(lines, gate, vacate);
    expect(lines.slice(gate, closes).join('\n')).toMatch(/rebuy_levels|windowOpen/);
  });

  it('still zeroes tournament_players.chips in the same breath as the vacate', () => {
    /* Vacating first without this froze `chips` at the last pre-bust value and
       the elimination sweep never eliminated anyone - ten RUNNING MTTs hung in
       production on 2026-08-30. The pair must stay together. */
    /* Bounded by the try block the vacate lives in, not by a line count. */
    const block = sliceEnclosingBlock(DEALING, 'update({ left_at: new Date().toISOString() })');
    expect(block, 'the busted-seat vacate block has moved or gone').not.toBe('');
    expect(block).toMatch(/from\('tournament_players'\)[\s\S]*?update\(\{ chips: 0 \}\)/);
  });
});
