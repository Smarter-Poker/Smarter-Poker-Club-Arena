import { describe, expect, it } from 'vitest';
import { mttCreationProfileValues } from './mttCreationProfiles.js';

describe('MTT setup policy is relative to the actual opening blind', () => {
  it('scales the same regular depth at different opening stakes', () => {
    expect(mttCreationProfileValues('regular', 20)).toEqual({
      blindStructure: 'standard',
      blindsUpMinutes: 10,
      startingChips: 3000,
    });
    expect(mttCreationProfileValues('regular', 50)).toEqual({
      blindStructure: 'standard',
      blindsUpMinutes: 10,
      startingChips: 7500,
    });
  });
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
    'refuses an unusable opening blind %s',
    (opening) => {
      expect(() => mttCreationProfileValues('regular', opening)).toThrow();
    }
  );
  it('never falls back to a different setup for an unknown key', () => {
    expect(() => mttCreationProfileValues('unknown' as 'regular', 20)).toThrow(
      'Unknown MTT Structure Preset'
    );
  });
});
