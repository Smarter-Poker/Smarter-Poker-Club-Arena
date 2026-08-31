/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PHASE 2.3 -- resume() READ THE BLIND LEVEL BY ARRAY INDEX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * resolveBlindLevel ends with an instruction to its callers, verbatim:
 *
 *   "Callers must therefore read levels through THIS function rather than
 *    indexing the array, or a tournament past the end reads the last
 *    persisted row instead of what it is actually playing."
 *
 * resume() was the one caller that ignored it. Every ladder on the platform is
 * 10-12 rows and both heads-up formats routinely run past the end (a measured
 * Spin reached level 158), so on a deep game the index is `undefined`, the
 * `|| blindStructure[0]` fallback takes over, and the level clock is armed
 * with the duration of LEVEL ONE. Engine restarts are frequent -- server/**
 * auto-deploys -- and this clock is what decides when the next escalation
 * lands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const BASE = readFileSync(join(__dirname, 'TournamentManagerBase.ts'), 'utf8');

describe('resume() arms the level clock through resolveBlindLevel', () => {
  it('the resumed level is resolved, not indexed', () => {
    const block = sliceEnclosingBlock(BASE, 'const levelData =');
    expect(block).toMatch(
      /this\.resolveBlindLevel\(tournament\.blind_structure \|\| \[\], this\.currentLevel\)/
    );
    expect(block).not.toMatch(/\[\]\)\[this\.currentLevel\]/);
  });

  it('no caller indexes the structure with currentLevel any more', () => {
    // The shape that was there: `(tournament.blind_structure || [])[this.currentLevel]`.
    expect(BASE).not.toMatch(/blind_structure \|\| \[\]\)\[this\.currentLevel\]/);
  });

  it('resolveBlindLevel is still the only derivation of a past-the-end level', () => {
    expect(BASE).toMatch(/protected resolveBlindLevel\(/);
    expect(BASE).toMatch(/escalatedBlindLevel\(/);
  });
});
