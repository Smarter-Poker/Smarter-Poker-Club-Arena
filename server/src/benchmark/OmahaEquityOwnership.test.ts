import { describe, expect, it } from 'vitest';
import type { Card } from '../types.js';
import { evaluateOmahaEquity, type OmahaEquityRequest } from './OmahaEquityOracle.js';

const cards = (text: string): Card[] =>
  text.split(' ').map((value) => ({
    rank: value[0] as Card['rank'],
    suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[value[1] as 'c'],
  }));
function request(): OmahaEquityRequest {
  return {
    variant: 'plo8',
    heroId: 'hero',
    players: [
      {
        id: 'hero',
        seat: 1,
        contributed: 100,
        range: { combos: [{ cards: cards('As 2s Jh Td'), weight: 1 }] },
      },
      {
        id: 'opponent',
        seat: 2,
        contributed: 100,
        range: {
          combos: [
            { cards: cards('Kh Kd Qc Qd'), weight: 3 },
            { cards: cards('Ah 2h 9s 9d'), weight: 1 },
          ],
        },
      },
    ],
    boards: [cards('3c 4d 8h Kc Qh')],
    chipUnit: 0.01,
    dealerSeat: 1,
    mode: 'exact_river',
    samples: 16,
    seed: 901901,
  };
}
const withoutClock = ({
  elapsedMs: _clock,
  ...result
}: Awaited<ReturnType<typeof evaluateOmahaEquity>>) => result;

describe('Phase 9 asynchronous oracle owns its admitted evidence', () => {
  it.each(['hero', 'board', 'holding'] as const)(
    'ignores caller mutation of %s after admission and before settlement',
    async (field) => {
      const input = request();
      const baseline = await evaluateOmahaEquity(structuredClone(input));
      let mutated = false;
      const result = await evaluateOmahaEquity(input, () => {
        if (!mutated) {
          mutated = true;
          if (field === 'hero') input.heroId = 'opponent';
          if (field === 'board') input.boards[0][0].rank = '9';
          if (field === 'holding' && 'combos' in input.players[0].range)
            input.players[0].range.combos[0].cards[0].rank = '7';
        }
        return true;
      });
      expect(mutated).toBe(true);
      expect(withoutClock(result)).toEqual(withoutClock(baseline));
    }
  );
});
