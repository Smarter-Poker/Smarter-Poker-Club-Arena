import { describe, expect, it } from 'vitest';
import {
  remainingVariantEntryBars,
  remainingVariantSeatCap,
} from './RemainingVariantPolicyPack.js';
import { PLO4_CORE_DEPTHS, PLO4_PREFLOP_ROLES, positionForOffset } from '../plo4/Plo4PolicyPack.js';
import { plo4PreflopChoice } from '../plo4/Plo4LivePolicy.js';
import { KNOWN_VARIANTS } from '../VariantRules.js';

describe('complete remaining-variant preflop domain', () => {
  it('assigns every actual engine variant to an implemented core policy owner', () => {
    const owners = {
      nlh: 'phase4/5/6/7',
      plo4: 'phase10',
      plo5: 'phase11',
      plo6: 'phase11',
      plo8: 'phase11',
      short_deck: 'phase12',
      pineapple: 'phase12',
      flh: 'phase12',
      flo8: 'phase12',
    };
    expect(Object.keys(owners).sort()).toEqual([...KNOWN_VARIANTS].sort());
  });
  it.each(['short_deck', 'pineapple', 'flh', 'flo8'] as const)(
    '%s certifies every preflop coordinate and interpolation boundary',
    (variant) => {
      let checked = 0;
      for (const mode of ['cash', 'tournament'] as const)
        for (let seats = 2; seats <= remainingVariantSeatCap(variant, mode); seats++)
          for (let hero = 0; hero < seats; hero++)
            for (let opponent = 0; opponent < seats; opponent++)
              for (const depthBB of PLO4_CORE_DEPTHS)
                for (const role of PLO4_PREFLOP_ROLES)
                  for (const anteBB of [0, 0.5, 1])
                    for (const straddle of variant === 'flh' || variant === 'flo8'
                      ? [false]
                      : [false, true])
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
                        const bars = remainingVariantEntryBars(variant, node),
                          next = remainingVariantEntryBars(variant, {
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
        Array.from({ length: Math.max(0, cap - 1) }, (_, n) => (n + 2) ** 2).reduce(
          (a, b) => a + b,
          0
        );
      expect(checked).toBe(
        (squares(remainingVariantSeatCap(variant, 'cash')) * 3 +
          squares(remainingVariantSeatCap(variant, 'tournament'))) *
          PLO4_CORE_DEPTHS.length *
          PLO4_PREFLOP_ROLES.length *
          3 *
          (variant === 'flh' || variant === 'flo8' ? 1 : 2)
      );
    },
    30000
  );
});
