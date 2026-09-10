import { describe, it, expect } from 'vitest';
import { handAssetTotals } from '../../src/lib/handAssetTotals';

describe('hand archive monetary denominations', () => {
  it('never offsets chip losses with Diamond wins or unclassified amounts', () => {
    expect(
      handAssetTotals([
        { arenaAsset: 'chips', net: -10.25, pot: 200 },
        { arenaAsset: 'diamonds', net: 10, pot: 80 },
        { arenaAsset: 'diamonds', net: 20, pot: 100 },
        { net: 400, pot: 900 },
      ])
    ).toEqual([
      { asset: 'chips', net: -10.25, biggestPot: 200 },
      { asset: 'diamonds', net: 30, biggestPot: 100 },
    ]);
  });
});
