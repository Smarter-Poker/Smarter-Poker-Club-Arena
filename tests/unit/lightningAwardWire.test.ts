import { describe, expect, it } from 'vitest';
import { potWinFrame } from '../../server/src/engine/presentation/handEventFrames';
import {
  buildAwardGroups,
  boardLabelFromAwards,
  normalizePotAwardWire,
} from '../../src/lib/showdownPresentation';
import { createPotToWinnerEvent } from '../../src/components/table/ChipAnimation';

const awards = [
  {
    userId: 'winner-low',
    potIndex: 0,
    board: 2,
    low: true,
    amount: 5.25,
    hand: { name: 'Low: 8-6-4-3-2', cards: [{ rank: '8', suit: 'h' }] },
  },
  { userId: 'winner-high', potIndex: 1, board: 1, low: false, amount: 0 },
  {
    userId: 'winner-high',
    potIndex: 0,
    board: 1,
    low: false,
    amount: 23.8,
    hand: { name: 'Two Pair', cards: [{ rank: 'A', suit: 's' }] },
    handDescription: 'Aces And Kings',
  },
];
const expected = [
  {
    board: 1,
    potIndex: 0,
    low: false,
    exact: true,
    winners: [{ userId: 'winner-high', amount: 23.8 }],
  },
  {
    board: 1,
    potIndex: 1,
    low: false,
    exact: true,
    winners: [{ userId: 'winner-high', amount: 0 }],
  },
  {
    board: 2,
    potIndex: 0,
    low: true,
    exact: true,
    winners: [{ userId: 'winner-low', amount: 5.25 }],
  },
];

describe('Lightning per-pot awards reach the same client animation contract', () => {
  it('animates the old serving frame using exact shares, including real zero shares', () => {
    const groups = buildAwardGroups(awards, [], ['winner-high', 'winner-low'], {
      'winner-high': 744,
    });
    expect(groups).toEqual(expected);
    const fan = createPotToWinnerEvent(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      groups[0].winners[0].amount
    );
    expect(fan.length).toBeGreaterThan(0);
    expect(fan[0].labelAmount).toBe(23.8);
  });

  it('the actual shared engine frame groups flat awards and strips evaluated private cards', () => {
    const frame = potWinFrame({
      tableId: 'table',
      emitHandNumber: 42,
      capturedWinnerIds: ['winner-high', 'winner-low'],
      capturedPotSize: 744,
      capturedBoard: [],
      capturedWinners: [],
      capturedShowdownResults: [],
      capturedWinnersByBoard: [],
      capturedPotAwards: awards,
    });
    const grouped = frame.pot_awards as Parameters<typeof buildAwardGroups>[0];
    expect(buildAwardGroups(grouped, [], [], {})).toEqual(expected);
    expect(JSON.stringify(grouped)).not.toContain('"cards"');
    expect(JSON.stringify(grouped)).not.toContain('"hand"');
    expect(frame.hand_number).toBe(42);
    expect(awards[0].hand?.cards).toEqual([{ rank: '8', suit: 'h' }]);
  });

  it('normalizes legacy groups once for the other display consumers too', () => {
    const grouped = normalizePotAwardWire(awards);
    expect(boardLabelFromAwards(grouped, '', '')).toMatchObject({
      handName: 'Two Pair',
      handDescription: 'Aces And Kings',
      lowWinnerLabel: 'Low: 8-6-4-3-2',
    });
    expect(normalizePotAwardWire(grouped)).toBe(grouped);
  });

  it('does not change already grouped physical-table wire records', () => {
    const grouped = normalizePotAwardWire(awards);
    const frame = potWinFrame({
      tableId: 'table',
      emitHandNumber: 42,
      capturedWinnerIds: [],
      capturedPotSize: 29.05,
      capturedBoard: [],
      capturedWinners: [],
      capturedShowdownResults: [],
      capturedWinnersByBoard: [],
      capturedPotAwards: grouped,
    });
    expect(frame.pot_awards).toBe(grouped);
    expect(buildAwardGroups([], [{ user_id: 'winner', amount: 2 }], [], {})).toMatchObject([
      { exact: false, winners: [{ userId: 'winner', amount: 2 }] },
    ]);
  });
});
