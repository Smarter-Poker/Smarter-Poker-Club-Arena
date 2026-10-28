import { expect, it } from 'vitest';
import { uniformPolicyContinuationCost as cost } from './HorseManiacPressure.test-support.js';

it.each([
  ['flop', 0.05],
  ['turn', 0.03],
  ['river', 0],
] as const)('%s nonterminal cost preserves the independent street contract', (street, expected) => {
  expect(cost(street, 63, 173)).toBe(expected);
});
it.each(['flop', 'turn', 'river'])('%s all-in calls have no remaining-street cost', (street) => {
  expect(cost(street, 173, 173)).toBe(0);
  expect(cost(street, 173, 172)).toBe(0);
});
it('preserves net price, raw uniform equity, and the 0.12 excess margin', () => {
  // 126 pot plus 63 call minus the independent six-chip rake cap.
  const price = 63 / (126 + 63 - 6);
  const rawUniformEquity = 0.4646666666666667;
  const required = price + cost('flop', 63, 173);
  expect(price).toBeCloseTo(0.3442622950819672, 12);
  expect(required).toBeCloseTo(0.3942622950819672, 12);
  expect(rawUniformEquity - price).toBeGreaterThan(0.12);
  expect(rawUniformEquity - required).toBeLessThan(0.12);
  // The smoke test still catches an unequivocal profitable-call omission.
  expect(0.6 > required + 0.12).toBe(true);
  expect(0.6 > price + cost('river', 63, 173) + 0.12).toBe(true);
  expect(0.6 > price + cost('flop', 63, 63) + 0.12).toBe(true);
});
