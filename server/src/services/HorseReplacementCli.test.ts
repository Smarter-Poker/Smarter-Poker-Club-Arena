import { describe, expect, it, vi } from 'vitest';
vi.mock('./HorseReplacementBatch.js', () => ({ replacePatternedHorses: vi.fn() }));
import { replacementExecutionMode } from '../scripts/replaceRetiredHorses.js';
describe('finite replacement CLI modes', () => {
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
