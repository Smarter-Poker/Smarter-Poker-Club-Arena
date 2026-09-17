import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic } from '../../../engine/HorseLogic.js';
import { seedFastRandom } from '../../../engine/HorseEval.js';
import { _clearGtoCharts } from '../../../engine/GtoCharts.js';
import { horsePhase6AttributionMatchesSnapshot } from '../../../engine/HorsePhase6Attribution.js';
import { fixture, request } from './fixture.js';
afterEach(() => _clearGtoCharts());
describe('current reference-transition receipt refusals', () => {
  it.each(['wrong_node', 'missing_after', 'missing_before', 'changed', 'negative_time'] as const)(
    'rejects an invalid first reference transition: %s',
    (fault) => {
      const f = fixture();
      seedFastRandom(901791);
      const d = structuredClone(HorseLogic.decide(f.hero, f.state, 'balanced', {}, f.opts));
      const first = d.policyGraph!.transitions[0] as any;
      if (fault === 'wrong_node') first.node = 'timing';
      if (fault === 'missing_after') delete first.after;
      if (fault === 'missing_before') delete first.before;
      if (fault === 'changed') first.changed = true;
      if (fault === 'negative_time') first.elapsedMs = -1;
      expect(horsePhase6AttributionMatchesSnapshot(d, request(f))).toBe(false);
    }
  );
});
