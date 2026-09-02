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
