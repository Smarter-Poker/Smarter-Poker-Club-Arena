import { describe, expect, it } from 'vitest';
import { parsePayoutStructure as parseClient } from '../../src/lib/payoutStructure';
import { parsePayoutStructure as parseServer } from '../../server/src/tournament/payoutStructure.js';

const parsers = [
  ['client', parseClient],
  ['server', parseServer],
] as const;

describe.each(parsers)('%s payout-structure parser', (_name, parse) => {
  it('accepts, sorts, and de-duplicates the canonical explicit shape', () => {
    expect(
      parse([
        { place: 3, percentage: '20' },
        { place: 1, percentage: 40 },
        { place: 1, percentage: 50 },
      ])
    ).toEqual([
      { place: 1, percentage: 40 },
      { place: 3, percentage: 20 },
    ]);
  });

  it.each([
    ['missing place one', [{ place: 2, percentage: 100 }]],
    [
      'zero share',
      [
        { place: 1, percentage: 100 },
        { place: 2, percentage: 0 },
      ],
    ],
    ['sub-basis-point share', [{ place: 1, percentage: 0.004 }]],
    ['fractional place', [{ place: 1.5, percentage: 100 }]],
    ['boolean place', [{ place: true, percentage: 100 }]],
    ['boolean percentage', [{ place: 1, percentage: true }]],
    ['position alias', [{ position: 1, percentage: 100 }]],
    [
      'range object',
      [
        { place: 1, percentage: 50 },
        { from: 2, to: 3, percentage: 25 },
      ],
    ],
    ['range string', [{ place: '1-3', percentage: 33.33 }]],
  ])('rejects %s', (_case, value) => {
    expect(parse(value)).toBeNull();
  });
});
