import { describe, expect, it, vi } from 'vitest';
vi.mock('./HorseReplacementBatch.js', () => ({ replacePatternedHorses: vi.fn() }));
import {
  replacementExecutionMode,
  replacementLogSummary,
} from '../scripts/replaceRetiredHorses.js';
describe('finite replacement CLI modes', () => {
  it('keeps the original reservation identities out of public provider summaries', () => {
    const privateMap = [{ retiredHorseId: 'private-original', horseId: 'private-replacement' }];
    const result = {
      batch: 'patterned-retirement-20261006',
      mode: 'inspect',
      reserved: 62,
      replacements: privateMap,
      onboarded: 0,
      seated: false,
      club_funded: false,
    };
    const summary = replacementLogSummary(result);
    expect(summary).toEqual({
      batch: result.batch,
      mode: 'inspect',
      reserved: 62,
      onboarded: 0,
      seated: false,
      club_funded: false,
    });
    expect(JSON.stringify(summary)).not.toContain('private-');
    expect(result.replacements).toBe(privateMap);
  });
  it('defaults to a read-only inspection', () => {
    expect(replacementExecutionMode([])).toBe(false);
    expect(replacementExecutionMode(['--inspect'])).toBe(false);
  });
  it('only the exact one-shot execution argument creates the original reserved cohort', () => {
    expect(replacementExecutionMode(['--execute'])).toBe(true);
    for (const args of [
      ['--execute', '--execute'],
      ['--count', '1000'],
      ['--watch'],
      ['--loop'],
      ['--execute=true'],
    ])
      expect(() => replacementExecutionMode(args)).toThrow();
  });
});
