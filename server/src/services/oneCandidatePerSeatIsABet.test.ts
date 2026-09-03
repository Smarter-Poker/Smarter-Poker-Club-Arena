/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SEAT-FIRST FILL BRINGS SPARES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-09-03, one hour of engine log: 247 boards logged "seat-first
 * fill added nobody", and 89 of the 98 refusals underneath them were
 * `FOUR TABLE LIMIT`. Every one of those lines read
 *
 *     0 own registrant(s) + 1 free horse(s) - shortfall 1
 *
 * One candidate for one seat. The candidate lost a race - 413 of the 1,000
 * horses were already at four games and 247 more were at three, so the busy set
 * pickFreeHorses read a moment earlier was stale by the time it claimed - and
 * the seat stayed empty on a board Dan opened to get horses playing.
 *
 * These pin the two halves of the answer and the one thing the answer must not
 * break: bring spares, stop when the seats are full, and stop calling the cap a
 * failure.
 */
import { describe, it, expect } from 'vitest';
import {
  seatFirstCandidateCount,
  isExpectedSeatRefusal,
  seatFirstFillOrder,
  SEAT_FIRST_CANDIDATES_PER_SEAT,
  SEAT_FIRST_CANDIDATE_FLOOR,
} from './TournamentRecurringService.js';

describe('seatFirstCandidateCount - more candidates than seats', () => {
  it('never asks for exactly the shortfall (the shape that went red)', () => {
    for (const seats of [1, 2, 3, 6, 9]) {
      expect(seatFirstCandidateCount(seats)).toBeGreaterThan(seats);
    }
  });

  it('the single empty seat - the case in every one of the 247 lines - gets spares', () => {
    expect(seatFirstCandidateCount(1)).toBe(SEAT_FIRST_CANDIDATE_FLOOR);
    expect(seatFirstCandidateCount(1)).toBeGreaterThanOrEqual(3);
  });

  it('scales with the seats once the floor is passed', () => {
    expect(seatFirstCandidateCount(3)).toBe(3 * SEAT_FIRST_CANDIDATES_PER_SEAT);
    expect(seatFirstCandidateCount(9)).toBe(9 * SEAT_FIRST_CANDIDATES_PER_SEAT);
  });

  it('no seats, no candidates - and junk is not a seat', () => {
    expect(seatFirstCandidateCount(0)).toBe(0);
    expect(seatFirstCandidateCount(-4)).toBe(0);
    expect(seatFirstCandidateCount(NaN)).toBe(0);
    expect(seatFirstCandidateCount(2.7)).toBe(2 * SEAT_FIRST_CANDIDATES_PER_SEAT);
  });

  it('the spares reach the candidate list, home still first', () => {
    // What the caller now does: ask for the padded count, order home before fleet.
    const own = ['ownA'];
    const pool = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const list = seatFirstFillOrder(seatFirstCandidateCount(1), own, pool);
    expect(list.length).toBeGreaterThan(1); // the whole point
    expect(list[0]).toBe('ownA'); // seatFirstFillOrder's own rule, unchanged
    expect(new Set(list).size).toBe(list.length); // no id offered twice
  });
});

describe('isExpectedSeatRefusal - the cap is a rule, not a fault', () => {
  it('the exact production message is expected, not reported', () => {
    expect(
      isExpectedSeatRefusal(
        'FOUR TABLE LIMIT: user 7a74d9fe-baef-4224-b20e-cea476853795 is already ' +
          'committed to 4 games and may not enter another'
      )
    ).toBe(true);
  });

  it('the other ordinary race outcomes too - the same list HorseFleetManager keeps', () => {
    expect(isExpectedSeatRefusal('TABLE_CAP_REACHED')).toBe(true);
    expect(isExpectedSeatRefusal('Player already seated')).toBe(true);
    expect(isExpectedSeatRefusal('duplicate key value violates unique constraint')).toBe(true);
  });

  it('everything else is still an error - this must never become a mute button', () => {
    expect(isExpectedSeatRefusal('tournament_full: 10 Chip Spin PLO4 already has 3 of 3')).toBe(
      false
    );
    expect(isExpectedSeatRefusal('no_table')).toBe(false);
    expect(isExpectedSeatRefusal('seat_taken')).toBe(false);
    expect(isExpectedSeatRefusal('fetch failed')).toBe(false);
    expect(isExpectedSeatRefusal('')).toBe(false);
    expect(isExpectedSeatRefusal(null)).toBe(false);
    expect(isExpectedSeatRefusal(undefined)).toBe(false);
  });
});

describe('the spares fill refusals, never extra seats', () => {
  /** The loop the service runs, reduced to its arithmetic. */
  function fill(shortfall: number, candidates: string[], seatable: Set<string>): number {
    let added = 0;
    for (const horse of candidates) {
      if (added >= shortfall) break;
      if (!seatable.has(horse)) continue; // the cap refused this one
      added++;
    }
    return added;
  }

  it('a refused candidate no longer costs the board its seat', () => {
    const candidates = seatFirstFillOrder(seatFirstCandidateCount(1), [], ['a', 'b', 'c']);
    expect(fill(1, candidates, new Set(['c']))).toBe(1); // a and b refused, c seats
  });

  it('the old one-per-seat shape is what left it empty', () => {
    const oldCandidates = seatFirstFillOrder(1, [], ['a', 'b', 'c']);
    expect(oldCandidates).toEqual(['a']);
    expect(fill(1, oldCandidates, new Set(['c']))).toBe(0); // the 247 lines
  });

  it('a 3-handed spin never takes a fourth, however many spares it carried', () => {
    const candidates = seatFirstFillOrder(
      seatFirstCandidateCount(3),
      [],
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
    );
    expect(candidates.length).toBeGreaterThan(3);
    expect(fill(3, candidates, new Set(candidates))).toBe(3);
  });

  it('nothing to fill, nobody seated', () => {
    expect(fill(0, ['a', 'b'], new Set(['a', 'b']))).toBe(0);
  });
});
