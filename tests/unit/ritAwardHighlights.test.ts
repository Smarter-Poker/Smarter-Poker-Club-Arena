import { expect, it } from 'vitest';
import { ritAwardHighlights } from '@/utils/ritAwardHighlights';
import type { Card } from '@/components/table/CardImage';
const cards = (s: string): Card[] => s.split(' ').map((c) => ({ rank: c[0], suit: c[1] }) as Card);

it("lights the awarded low five instead of the same player's high hand", () => {
  const board = cards('3h 4d 5s Kc Qd');
  const result = ritAwardHighlights(
    board,
    [{ userId: 'low', cards: cards('As 2c 3h 4d 5s') }],
    [{ id: 'low', holeCards: cards('Kh Kd As 2c') }]
  );
  expect(result).toEqual({ boardIndices: [0, 1, 2], holeIndices: { low: [2, 3] } });
});

it('keeps every tied or side-pot winner and their own card indices', () => {
  const result = ritAwardHighlights(
    cards('3h 4d 5s Kc Qd'),
    [
      { userId: 'a', cards: cards('Kh Kd Kc Qd 5s') },
      { userId: 'b', cards: cards('As 2c 3h 4d 5s') },
    ],
    [
      { id: 'a', holeCards: cards('Kh Kd Ac 2d') },
      { id: 'b', holeCards: cards('Ks Qs As 2c') },
    ]
  );
  expect(result).toEqual({ boardIndices: [0, 1, 2, 3, 4], holeIndices: { a: [0, 1], b: [2, 3] } });
});

it('preserves original indices around hidden-card placeholders', () => {
  const result = ritAwardHighlights(
    cards('3h 4d 5s Kc Qd'),
    [{ userId: 'a', cards: cards('As 2c 3h 4d 5s') }],
    [{ id: 'a', holeCards: [null, ...cards('As'), null, ...cards('2c')] }]
  );
  expect(result.holeIndices).toEqual({ a: [1, 3] });
});

it('does not invent a best five for an older award payload', () => {
  expect(
    ritAwardHighlights(
      cards('3h 4d 5s Kc Qd'),
      [{ userId: 'a' }],
      [{ id: 'a', holeCards: cards('Kh Kd As 2c') }]
    )
  ).toEqual({ boardIndices: [], holeIndices: {} });
});
