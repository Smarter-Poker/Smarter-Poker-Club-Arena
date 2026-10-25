import { describe, expect, it } from 'vitest';
import { orderMadnessCandidates } from './HorseMadnessSelection.js';

const madness = {
  game_variant: 'plo5',
  bomb_pot_enabled: true,
  big_blind_ante_enabled: true,
  nit_game: true,
  maintain_percent_min: 50,
};
const weighted = [
  { h: { id: 'tiny' }, w: 4 },
  { h: { id: 'proven' }, w: 1 },
  { h: { id: 'unknown' }, w: 3 },
];
const performance = new Map([
  ['tiny', { hands: 71, bb100: 219 }],
  ['proven', { hands: 10_000, bb100: 15 }],
]);
async function order(table = madness, records = performance) {
  return orderMadnessCandidates(weighted, table, records);
}

describe('Madness prefers measured PLO strength after normal admission', () => {
  it('does not mistake a 71-hand heater for a well sampled winner', async () => {
    expect((await order()).map((x) => x.h.id)).toEqual(['proven', 'tiny', 'unknown']);
  });
  it('retains every candidate and never mutates the eligible pool', async () => {
    const before = structuredClone(weighted);
    const result = await order();
    expect(result).toHaveLength(weighted.length);
    expect(result.map((x) => x.h.id).sort()).toEqual(weighted.map((x) => x.h.id).sort());
    expect(weighted).toEqual(before);
  });
  it('retains the existing weighted draw when performance is unreadable', async () => {
    expect((await order(madness, new Map())).map((x) => x.h.id)).toEqual([
      'tiny',
      'unknown',
      'proven',
    ]);
  });
  it('leaves ordinary Classic, other variants and unqualified rules on the existing draw', async () => {
    for (const over of [
      { bomb_pot_enabled: false },
      { big_blind_ante_enabled: false },
      { nit_game: false },
      { maintain_percent_min: 40 },
      { game_variant: 'nlh' },
      { game_variant: 'plo6' },
    ]) {
      expect((await order({ ...madness, ...over })).map((x) => x.h.id)).toEqual([
        'tiny',
        'unknown',
        'proven',
      ]);
    }
  });
  it('treats missing and invalid samples as unknown, never as proven wins', async () => {
    for (const bad of [
      { hands: 0, bb100: 1000 },
      { hands: NaN, bb100: 1000 },
      { hands: 20, bb100: Infinity },
      { hands: -1, bb100: 1000 },
    ]) {
      expect(
        (
          await order(
            madness,
            new Map([
              ['tiny', bad],
              ['proven', { hands: 10000, bb100: 15 }],
            ])
          )
        ).map((x) => x.h.id)
      ).toEqual(['proven', 'tiny', 'unknown']);
    }
  });
});
