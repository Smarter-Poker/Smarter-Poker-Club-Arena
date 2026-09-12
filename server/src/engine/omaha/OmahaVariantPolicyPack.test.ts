import { describe, expect, it } from 'vitest';
import {
  omahaVariantHandShape,
  omahaVariantEntryBars,
  omahaVariantSeatCap,
} from './OmahaVariantPolicyPack.js';
import { PLO4_CORE_DEPTHS, PLO4_PREFLOP_ROLES, positionForOffset } from '../plo4/Plo4PolicyPack.js';
import { plo4PreflopChoice } from '../plo4/Plo4LivePolicy.js';
import { variantCards } from '../../benchmark/OmahaVariantPolicyEvidence.js';

describe('Phase 11 independently parameterized variants', () => {
  it('prices nut suits, connected extra cards and duplicated ranks as distinct high-hand structures', () => {
    for (const variant of ['plo5', 'plo6'] as const) {
      const extra = variant === 'plo6' ? ' Jd' : '';
      const premium = omahaVariantHandShape(variant, variantCards('As Ad Ks Kd Qs' + extra));
      const waste = omahaVariantHandShape(variant, variantCards('As Ad Ah Ac 2s' + extra));
      expect(premium.quality).toBeGreaterThan(waste.quality);
      expect(premium.nutSuits.length).toBe(2);
      expect(waste.tripleRanks).toContain(14);
    }
    const joined = omahaVariantHandShape('plo6', variantCards('Ks Qh Js Th 9c 8d'));
    const dangling = omahaVariantHandShape('plo6', variantCards('Ks Qh Js Th 2c 7d'));
    expect(joined.connectedCores).toBeGreaterThan(dangling.connectedCores);
    expect(joined.quality).toBeGreaterThan(dangling.quality);
  });
  it('values A2 plus backup low independently from high-only broadways', () => {
    const low = omahaVariantHandShape('plo8', variantCards('As 2s 3d Ac'));
    const high = omahaVariantHandShape('plo8', variantCards('Ks Qs Jh Th'));
    expect(low.aceDeuce && low.backupLow).toBe(true);
    expect(low.lowQuality).toBeGreaterThan(high.lowQuality);
    expect(low.quality).toBeGreaterThan(high.quality);
    expect(() => omahaVariantHandShape('plo5', variantCards('As Ad Ks Kd'))).toThrow();
    expect(() => omahaVariantHandShape('plo6', variantCards('As Ad Ks Kd Qs Qs'))).toThrow();
  });
  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s certifies every preflop coordinate and interpolation boundary',
    (variant) => {
      let checked = 0;
      for (const mode of ['cash', 'tournament'] as const)
        for (let seats = 2; seats <= omahaVariantSeatCap(variant, mode); seats++)
          for (let hero = 0; hero < seats; hero++)
            for (let opponent = 0; opponent < seats; opponent++)
              for (const depthBB of PLO4_CORE_DEPTHS)
                for (const role of PLO4_PREFLOP_ROLES)
                  for (const anteBB of [0, 0.5, 1])
                    for (const straddle of [false, true])
                      for (const rakePercent of mode === 'cash' ? [0, 5, 10] : [0]) {
                        const node = {
                          position: positionForOffset(hero, seats),
                          aggressorPosition:
                            hero === opponent ? null : positionForOffset(opponent, seats),
                          role,
                          seats,
                          depthBB,
                          anteBB,
                          straddle,
                          rakePercent,
                        };
                        const bars = omahaVariantEntryBars(variant, node),
                          next = omahaVariantEntryBars(variant, {
                            ...node,
                            depthBB: depthBB + 0.001,
                          });
                        for (const key of ['open', 'call', 'raise', 'callOff'] as const)
                          if (
                            !Number.isFinite(bars[key]) ||
                            bars[key] < 0 ||
                            bars[key] > 1.5 ||
                            Math.abs(bars[key] - next[key]) > 0.0001
                          )
                            throw new Error(JSON.stringify(node));
                        for (const callBB of [0.5, depthBB]) {
                          let previous = -1;
                          for (const quality of [0, 0.4, 0.6, 0.8, 1]) {
                            const choice = plo4PreflopChoice(quality, bars, role, callBB, depthBB);
                            const risk = { passive: 0, call: 1, wager: 2 }[choice.action];
                            if (risk < previous || (quality === 0 && risk !== 0))
                              throw new Error(JSON.stringify(node));
                            previous = risk;
                          }
                        }
                        checked++;
                      }
      const squares = (cap: number) =>
        Array.from({ length: cap - 1 }, (_, n) => (n + 2) ** 2).reduce((a, b) => a + b, 0);
      expect(checked).toBe(
        (squares(omahaVariantSeatCap(variant, 'cash')) * 3 +
          squares(omahaVariantSeatCap(variant, 'tournament'))) *
          PLO4_CORE_DEPTHS.length *
          PLO4_PREFLOP_ROLES.length *
          3 *
          2
      );
    },
    30000
  );
});
