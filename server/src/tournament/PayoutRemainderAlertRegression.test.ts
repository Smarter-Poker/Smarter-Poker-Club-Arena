import { describe, expect, it } from 'vitest';
import { computePlacePrize } from './payoutMath.js';
import { CHIP_UNIT_CENTS } from './tournamentUnit.js';

// Received alert6550: the flat 23rd-place percentage was compared with a
// remainder payment. These are the actual published ladder and paid amounts.
const percentages = [
  26.64, 19.18, 13.81, 9.94, 7.16, 5.15, 3.71, 2.67, 1.92, 0.85, 0.82, 0.8, 0.77, 0.75, 0.73, 0.71,
  0.68, 0.66, 0.64, 0.62, 0.61, 0.59, 0.59,
];
const paidCents = [
  35964, 25893, 18644, 13419, 9666, 6953, 5009, 3605, 2592, 1148, 1107, 1080, 1040, 1013, 986, 959,
  918, 891, 864, 837, 824, 797, 791,
];
const structure = percentages.map((percentage, i) => ({ place: i + 1, percentage }));

describe('the received 1350-chip last-place alert', () => {
  it('reproduces every actual payment and conserves the entire pool in cents', () => {
    const actual = structure.map(({ place }) =>
      Math.round(computePlacePrize(1350, structure, place, CHIP_UNIT_CENTS) * 100)
    );
    expect(actual).toEqual(paidCents);
    expect(actual.reduce((sum, cents) => sum + cents, 0)).toBe(135000);
  });

  it('assigns the exact residual rather than another independently rounded percentage', () => {
    expect(Math.round((135000 * 59) / 10000)).toBe(797);
    expect(computePlacePrize(1350, structure, 23, CHIP_UNIT_CENTS)).toBe(7.91);
    expect(135000 - paidCents.slice(0, -1).reduce((sum, cents) => sum + cents, 0)).toBe(791);
  });
});
