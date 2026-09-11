/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A DEAD READ IS NOT AN EMPTY ROOM (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-09 the HorseSessionRotator was inert for three and a half hours
 * and nothing anywhere said so.
 *
 * At 17:23:50 and 17:25:29 two migrations added COMPOSITE foreign keys from
 * `table_seats` to `tables` (`live_seat_parent_cannot_close`,
 * `active_seat_game_scope_parent`). `table_seats` then had three
 * relationships to `tables`, and PostgREST refuses an unqualified embed when
 * there is more than one: PGRST201, HTTP 300, "Could not embed because more
 * than one relationship was found".
 *
 * The rotator's ONE read of the room is that embed. Every page returned 300,
 * and the handler was a bare `return`:
 *
 *     if (error || !chunk) return;          // no log, no report, no metric
 *
 * So the whole departure side of the fleet stopped at once - session ends,
 * the lone stand, tournament leaves, seat changes, top-ups, short breaks, the
 * retiring-table drain, and the human release rule (Dan 2026-09-02), which is
 * the ONLY thing that opens a seat for a person on a waiting list. It was
 * found from the felt, not from a log: four cluster tables holding one horse
 * for 415, 129, 121 and 54 minutes against a ten-minute rule. The first pass
 * after the constraints were dropped at 20:55:08 stood up a horse that had
 * been "alone for 222 min".
 *
 * TWO RULES, and the second is the one that matters.
 *
 * 1. THE EMBED NAMES ITS PARENT. `tables!table_seats_table_id_fkey!inner(...)`
 *    can never be made ambiguous by adding a foreign key, so the number of
 *    relationships between two tables stops being something a migration in a
 *    different lane can break from a distance.
 *
 * 2. A READ THAT FAILED SAYS SO. CLAUDE.md 10.86 rule 1: "I could not tell"
 *    is a distinct outcome and never gets folded into "nothing to do". A
 *    rotator that cannot read the room must be loud about declining the pass,
 *    because a silent decline is indistinguishable from a quiet floor for as
 *    long as the read stays broken - which was three and a half hours.
 *
 * The third pin here is a different bug found in the same file on the same
 * day: the seat-change memo was keyed on the game and held for twelve hours,
 * while the door's budget is per STAY (`cash_game_roster` opens a fresh row
 * with a null `seat_change_used_at` when a player rejoins). A horse that left
 * a game and came back was never asked again - a button a human gets and a
 * horse did not, which CLAUDE.md 10.5 forbids.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pruneSeatChangeMemo } from './HorseBehavior.js';

const ROTATOR = readFileSync(resolve(__dirname, 'HorseSessionRotator.ts'), 'utf8');

/** The room read: from `.from('table_seats')` to the end of its error branch. */
function seatReadBlock(): string {
  const from = ROTATOR.indexOf(".from('table_seats')");
  expect(from, 'the rotator must still read table_seats').toBeGreaterThan(-1);
  const end = ROTATOR.indexOf('seats.push(...chunk)', from);
  expect(end, 'the seat read must still push its page').toBeGreaterThan(from);
  return ROTATOR.slice(from, end);
}

describe('the embed names its parent, so a new foreign key cannot kill it', () => {
  it('the rotator embeds tables through table_seats_table_id_fkey by name', () => {
    expect(seatReadBlock()).toContain('tables!table_seats_table_id_fkey!inner(');
  });

  it('carries NO unqualified tables embed anywhere in the file', () => {
    // `tables!inner(` and `tables(` are the two forms PostgREST resolves by
    // guessing, and both return HTTP 300 the moment a second relationship
    // exists. Comments are stripped so the history above does not count.
    const code = ROTATOR.split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toMatch(/[^!_a-zA-Z]tables!inner\(/);
    expect(code).not.toMatch(/select\([^)]*[^!_a-zA-Z]tables\(/);
  });

  it('still selects every column the passes below it decide on', () => {
    const block = seatReadBlock();
    for (const col of [
      'cluster_id',
      'lifecycle',
      'role',
      'main_index',
      'created_at',
      'big_blind',
      'tournament_id',
      'status',
      'settings',
    ]) {
      expect(block, `the ${col} column feeds a rule in this file`).toContain(col);
    }
  });
});

describe('a read that failed is never silence', () => {
  it('reports and warns before it declines the pass', () => {
    const block = seatReadBlock();
    const guard = block.indexOf('if (error || !chunk)');
    expect(guard, 'the fail-closed guard must still exist').toBeGreaterThan(-1);
    const branch = block.slice(guard);
    // The exact shape that hid the outage: a bare return on the same line.
    expect(branch).not.toMatch(/if \(error \|\| !chunk\) return;/);
    expect(branch).toContain('reportError(');
    expect(branch).toContain('HorseSessionRotator.seat_read_failed');
    expect(branch).toContain('console.warn(');
    // It still declines the pass - rotating half a room is the other bug.
    expect(branch).toContain('return;');
  });

  it('names what stops, so the reader knows the blast radius', () => {
    const block = seatReadBlock();
    for (const word of ['session ends', 'lone stands', 'tournament leaves', 'seat changes']) {
      expect(block).toContain(word);
    }
  });

  it('throttles the report rather than filing one per page for ever', () => {
    const block = seatReadBlock();
    expect(block).toContain('lastSeatReadFailureReportAt');
    expect(ROTATOR).toMatch(/private lastSeatReadFailureReportAt = 0;/);
  });
});

describe('the seat-change memo dies with the stay, not on a clock', () => {
  it('drops an entry whose stay has ended, keeps one still seated', () => {
    const now = 1_000_000;
    const memo = new Map<string, number>([
      ['g1:h1', now + 60_000], // still seated -> kept
      ['g1:h2', now + 60_000], // left the game -> dropped
      ['g2:h3', now - 1], // expired -> dropped
    ]);
    const ended = pruneSeatChangeMemo(memo, new Set(['g1:h1']), now);
    expect([...memo.keys()]).toEqual(['g1:h1']);
    expect(ended, 'only the ended stay is counted as ended').toBe(1);
  });

  it('an empty room clears every unexpired entry, because nobody is seated', () => {
    const now = 1_000_000;
    const memo = new Map<string, number>([['g1:h1', now + 60_000]]);
    expect(pruneSeatChangeMemo(memo, new Set(), now)).toBe(1);
    expect(memo.size).toBe(0);
  });

  it('is called by the rotator against the pairs seated right now', () => {
    expect(ROTATOR).toContain('pruneSeatChangeMemo(this.seatChangeAsked, seatedPairs, now)');
    expect(ROTATOR).toMatch(/seatedPairs\.add\(HorseSessionRotator\.seatChangeKey\(/);
    // The old shape: an expiry sweep with no idea whether the stay had ended.
    expect(ROTATOR).not.toMatch(/if \(until <= now\) this\.seatChangeAsked\.delete\(k\);/);
  });
});
