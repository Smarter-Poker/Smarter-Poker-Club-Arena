import { describe, expect, it } from 'vitest';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import {
  PLO6_V24_DEVELOPMENT_DESIGN as d,
  plo6V24DevelopmentProfile,
  plo6V24DevelopmentSpec,
} from './Plo6V24Qualification.js';
import { assertAblationArms } from './FeatureAblationLeague.js';
describe('PLO6 V24 finite development design', () => {
  it('uses the exact single-flag contrast, five physical profiles and published pricing', () => {
    expect(d.profiles.map((p) => [p.seats, p.stackBB])).toEqual([
      [2, 100],
      [4, 100],
      [6, 40],
      [6, 100],
      [6, 200],
    ]);
    for (const p of d.profiles) {
      const profile = plo6V24DevelopmentProfile(p.id),
        full = getFullRakeConfig(1, 2, 'plo6');
      expect(profile.publishedRake).toBe(true);
      expect(profile.tableSeats).toBe(6);
      expect(profile.rakePercent).toBe(full.rakePercent);
      expect(profile.rakeCapBB).toBe(full.rakeCap / 2);
      const spec = plo6V24DevelopmentSpec(p.id, {
        id: 'test-only',
        decide() {
          throw Error('not dealt');
        },
      });
      expect(() => assertAblationArms(spec)).not.toThrow();
      expect(spec.candidate).toEqual({ v24PloDefense: true });
      expect(spec.reference).toEqual({ v24PloDefense: false });
    }
  });
  it('keeps development and untouched heldouts disjoint and nonpromoting', () => {
    expect(
      d.developmentSeeds.some((s) => (d.reservedHeldoutSeeds as readonly number[]).includes(s))
    ).toBe(false);
    expect(d.pilotPairsPerProfile % 576).toBe(0);
    expect(d.promotionEligible).toBe(false);
    expect(d.heldoutState).toBe('never_dealt_contract_merge_required');
    expect(() => plo6V24DevelopmentProfile('unknown')).toThrow();
  });
});
