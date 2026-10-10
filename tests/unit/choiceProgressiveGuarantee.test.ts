import { describe, expect, it } from 'vitest';
import {
  choiceLossGuarantee,
  choiceNextOdds,
  minePrizeV5,
  roadProbabilityV5,
  roadSurvivesV5,
} from '../../src/utils/choiceProgressiveGuarantee';
import { ROAD_LADDERS_V4, RANDOM_SPACE } from '../../src/utils/diamondChoiceMath';
describe('Progressive choice guarantee', () => {
  it.each([25, 50, 75])(
    'six-mine physical odds and every stopping expectation agree at stake %s',
    (bet) => {
      const minimum = bet === 75 ? 50 : bet / 2;
      const prizes = Array.from({ length: 19 }, (_, i) => {
        const p = minePrizeV5(bet, 6, i + 1, minimum);
        return Number(p.numerator) / Number(p.denominator) / 100;
      });
      expect(prizes[0]).toBe(bet * 0.8);
      let probability = 1,
        paidLosses = 0;
      for (let n = 1; n < prizes.length; n++) {
        const odds = choiceNextOdds('mines', n, prizes, minimum, 5)!;
        expect(odds.loss).toBeCloseTo(600 / (25 - n), 10);
        const q = odds.safe / 100,
          loss = choiceLossGuarantee(prizes, n, minimum);
        paidLosses += probability * (1 - q) * loss;
        probability *= q;
        expect(paidLosses + probability * prizes[n]).toBeCloseTo(bet * 0.8, 8);
        expect(loss).toBeGreaterThanOrEqual(prizes[n - 1] / 2);
      }
    }
  );
  it('road probabilities include losses at each earlier street', () => {
    const prizes = ROAD_LADDERS_V4.road.map((m) => (25 * m) / 100);
    let probability = 1,
      paidLosses = 0;
    for (let n = 1; n < prizes.length; n++) {
      const q = choiceNextOdds('crossing', n, prizes, 12.5, 5)!.safe / 100;
      const loss = choiceLossGuarantee(prizes, n, 12.5);
      paidLosses += probability * (1 - q) * loss;
      probability *= q;
      expect(paidLosses + probability * prizes[n]).toBeCloseTo(20, 10);
      const exact = roadProbabilityV5(prizes, n + 1, 12.5);
      const boundary = (exact.numerator * RANDOM_SPACE) / exact.denominator;
      expect(roadSurvivesV5(boundary - 1n, prizes, n + 1, 12.5)).toBe(true);
      expect(roadSurvivesV5(boundary, prizes, n + 1, 12.5)).toBe(false);
    }
  });
  it('shows a safe first move and no next move after the round limit', () => {
    expect(choiceNextOdds('mines', 0, [20, 22.5], 12.5, 5)).toEqual({ safe: 100, loss: 0 });
    expect(choiceNextOdds('crossing', 2, [20, 36.25], 12.5, 5)).toBeNull();
    expect(choiceLossGuarantee([20, 36.25], 2, 12.5)).toBe(18.13);
  });
});
