import { describe, expect, it } from 'vitest';
import {
  parsePayoutStructure as parseClient,
  resolvePayoutStructure as resolveClient,
} from '../../src/lib/payoutStructure';
import {
  parsePayoutStructure as parseServer,
  resolvePayoutStructure as resolveServer,
} from '../../server/src/tournament/payoutStructure.js';

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

const resolvers = [
  ['client', resolveClient],
  ['server', resolveServer],
] as const;

describe.each(resolvers)('%s payout-structure resolver', (_name, resolve) => {
  it('lets a drawn Spin tier outrank its stale winner-take-all placeholder', () => {
    expect(
      resolve({
        variant: 'spin',
        spin_multiplier: 10,
        payout_structure: [{ place: 1, percentage: 100 }],
      })
    ).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 20 },
    ]);

    expect(
      resolve({
        tournament_type: 'SPIN',
        spin_multiplier: 25,
        payout_structure: [{ place: 1, percentage: 100 }],
      })
    ).toEqual([
      { place: 1, percentage: 80 },
      { place: 2, percentage: 12 },
      { place: 3, percentage: 8 },
    ]);
  });

  it('fails closed for an unknown Spin tier instead of showing the placeholder', () => {
    expect(
      resolve({
        variant: 'spin',
        spin_multiplier: 500,
        payout_structure: [{ place: 1, percentage: 100 }],
      })
    ).toBeNull();
  });

  it('preserves the stored operator-authored ladder for non-Spin events', () => {
    expect(
      resolve({
        variant: 'freezeout',
        spin_multiplier: 10,
        payout_structure: [
          { place: 1, percentage: 65 },
          { place: 2, percentage: 35 },
        ],
      })
    ).toEqual([
      { place: 1, percentage: 65 },
      { place: 2, percentage: 35 },
    ]);
  });
});
