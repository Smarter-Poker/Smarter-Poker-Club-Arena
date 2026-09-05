/**
 * SHOWDOWN POLISH 2026-08-25 — unit tests for the pure presentation logic
 * extracted from TablePage (lib/showdownPresentation): award sequencing,
 * hi-lo board labels, and the spec-21 stack hold. These are the beats the
 * table plays; they were previously inline in a 13k-line component where
 * nothing could test them.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAwardGroups,
  boardLabelFromAwards,
  pendingStackHold,
  type PotAwardGroupWire,
} from '../../src/lib/showdownPresentation';

const groupsFixture: PotAwardGroupWire[] = [
  {
    pot_index: 0,
    board: 1,
    low: false,
    winners: [
      {
        user_id: 'a',
        amount: 100,
        hand_name: 'Full House',
        hand_description: 'Kings Full Of Nines',
      },
    ],
  },
  {
    pot_index: 0,
    board: 1,
    low: true,
    winners: [{ user_id: 'b', amount: 50, hand_name: 'Low: 5-4-3-2-1' }],
  },
  {
    pot_index: 1,
    board: 1,
    low: false,
    winners: [{ user_id: 'a', amount: 30, hand_name: 'Full House' }],
  },
];

describe('buildAwardGroups', () => {
  it('prefers the engine pot_awards groups and keeps their order + exact shares', () => {
    const groups = buildAwardGroups(groupsFixture, [], ['a', 'b'], {});
    expect(groups.length).toBe(3);
    // Same user in two pots = two separate beats with per-pot shares —
    // the exact case the merged winners[] could never sequence.
    expect(groups[0].winners).toEqual([{ userId: 'a', amount: 100 }]);
    expect(groups[1].low).toBe(true);
    expect(groups[1].winners).toEqual([{ userId: 'b', amount: 50 }]);
    expect(groups[2].potIndex).toBe(1);
    expect(groups[2].winners).toEqual([{ userId: 'a', amount: 30 }]);
    // Review fix 2026-08-25: engine groups are flagged exact — consumers
    // must render their amounts verbatim (a zero is a real zero) and never
    // fall back to merged totals or equal-split estimates.
    expect(groups.every((g) => g.exact)).toBe(true);
  });

  it('falls back to per-winner pot_index grouping on the interim wire', () => {
    const groups = buildAwardGroups(
      undefined,
      [
        { user_id: 'a', amount: 100, pot_index: 0 },
        { user_id: 'c', amount: 40, pot_index: 1 },
      ],
      ['a', 'c'],
      {}
    );
    expect(groups.length).toBe(2);
    expect(groups[0].winners[0]).toEqual({ userId: 'a', amount: 100 });
    expect(groups[1].winners[0]).toEqual({ userId: 'c', amount: 40 });
    // Legacy groupings are estimates — never flagged exact.
    expect(groups.every((g) => g.exact === false)).toBe(true);
  });

  it('degrades to one group for pre-2026 payloads (winner_ids only)', () => {
    const groups = buildAwardGroups(undefined, [], ['a', 'b'], { a: 60, b: 60 });
    expect(groups.length).toBe(1);
    expect(groups[0].winners).toEqual([
      { userId: 'a', amount: 60 },
      { userId: 'b', amount: 60 },
    ]);
  });

  it('a chopped pot stays ONE beat: same-pot winners fire together (spec 12)', () => {
    const groups = buildAwardGroups(
      [
        {
          pot_index: 0,
          low: false,
          winners: [
            { user_id: 'a', amount: 50 },
            { user_id: 'b', amount: 50 },
          ],
        },
      ],
      [],
      ['a', 'b'],
      {}
    );
    expect(groups.length).toBe(1);
    expect(groups[0].winners.length).toBe(2);
  });
});

describe('boardLabelFromAwards (spec 33)', () => {
  it('names the high hand and surfaces the low half as its own line', () => {
    const label = boardLabelFromAwards(groupsFixture, 'fallback', 'fallback desc');
    expect(label.handName).toBe('Full House');
    expect(label.handDescription).toBe('Kings Full Of Nines');
    expect(label.lowWinnerLabel).toBe('Low: 5-4-3-2-1');
  });

  it('no low awarded means no low line, and absent groups fall back cleanly', () => {
    const noLow = boardLabelFromAwards([groupsFixture[0]], 'fallback', 'fallback desc');
    expect(noLow.lowWinnerLabel).toBe('');
    const legacy = boardLabelFromAwards(undefined, 'Straight', 'Nine High');
    expect(legacy).toEqual({
      handName: 'Straight',
      handDescription: 'Nine High',
      lowWinnerLabel: '',
    });
  });
});

describe('pendingStackHold (spec 21)', () => {
  const winners = [
    { userId: 'a', amount: 120 },
    { userId: 'b', amount: 0 },
  ];

  it('holds a pending winner by their share until release', () => {
    expect(pendingStackHold(winners, 'a', false)).toBe(120);
  });

  it('releases to zero, ignores non-winners and zero shares', () => {
    expect(pendingStackHold(winners, 'a', true)).toBe(0);
    expect(pendingStackHold(winners, 'zz', false)).toBe(0);
    expect(pendingStackHold(winners, 'b', false)).toBe(0);
    expect(pendingStackHold(undefined, 'a', false)).toBe(0);
  });
});

/**
 * THE POT SHIPS PER BOARD (2026-09-05).
 *
 * The reported bug: on a run-it-twice or run-it-three-times hand the engine
 * credits ONE merged total and the seat held all of it until the last board's
 * fan landed, so the stack sat still through boards 1..N-1 and then jumped the
 * whole amount in one step. The reference client steps the stack with each
 * board's chips (frame-verified: 0 → 2.73 → 5.46 across three runs).
 *
 * These are the laws that make that possible.
 */
describe('pendingStackHold — per-board release (run-it-twice parity)', () => {
  // A three-run hand: this player took two of the three boards for 2.73 each.
  const ritWinners = [{ userId: 'gordo', amount: 5.46 }];

  it('holds the WHOLE amount before any board has shipped', () => {
    expect(pendingStackHold(ritWinners, 'gordo', false, {})).toBe(5.46);
    // Undefined ledger behaves like an empty one — old three-arg call sites
    // keep their exact previous meaning.
    expect(pendingStackHold(ritWinners, 'gordo', false)).toBe(5.46);
  });

  it('shrinks the hold by each board as it lands, so the seat steps up', () => {
    // Board 1 pays 2.73 → the seat must now show 2.73 more than it did.
    expect(pendingStackHold(ritWinners, 'gordo', false, { gordo: 2.73 })).toBe(2.73);
    // Board 3 pays the second 2.73 → nothing held back.
    expect(pendingStackHold(ritWinners, 'gordo', false, { gordo: 5.46 })).toBe(0);
  });

  it('never holds a negative amount if a release overshoots', () => {
    expect(pendingStackHold(ritWinners, 'gordo', false, { gordo: 9.99 })).toBe(0);
  });

  it('subtracts in cents, so repeated releases cannot strand a rounding crumb', () => {
    // 0.1 + 0.2 !== 0.3 in float. A 0.30 total released in float-dirty steps
    // must land exactly on zero, not 0.000000000000004 — which renders as a
    // stack permanently a cent short of the truth.
    const w = [{ userId: 'p', amount: 0.3 }];
    expect(pendingStackHold(w, 'p', false, { p: 0.1 })).toBe(0.2);
    expect(pendingStackHold(w, 'p', false, { p: 0.30000000000000004 })).toBe(0);
  });

  it('is per player — one winner shipping does not release another', () => {
    const twoWinners = [
      { userId: 'p1', amount: 10.16 },
      { userId: 'p5', amount: 0.44 },
    ];
    // The side pot chopped to p1 and p5 lands first; p1 is still owed the
    // main pot from the second board. (This is the split-pot recording:
    // p5 finishes on 0.44 while p1 goes on to collect 9.72 more.)
    const afterSidePot = { p1: 0.44, p5: 0.44 };
    expect(pendingStackHold(twoWinners, 'p1', false, afterSidePot)).toBe(9.72);
    expect(pendingStackHold(twoWinners, 'p5', false, afterSidePot)).toBe(0);
  });

  it('the global release still wins outright — it is the backstop', () => {
    // HAND_COMPLETE / HAND_STARTED must always be able to end the hold, even
    // if a per-board release timer was dropped.
    expect(pendingStackHold(ritWinners, 'gordo', true, {})).toBe(0);
    expect(pendingStackHold(ritWinners, 'gordo', true, { gordo: 1 })).toBe(0);
  });
});
