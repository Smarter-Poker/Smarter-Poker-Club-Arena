/**
 * SPIN LEVELS 2026-08-21: the spin spec stores level length as `duration` in
 * SECONDS; MTT/SNG configs store `durationMinutes`. The blind timer used to
 * read only `durationMinutes || 10`, so every spin level silently ran 10
 * minutes against Dan's 3-minute spec (observed live: level-ups at exactly
 * +10:00). All arm sites must go through the format-normalizing helper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const BASE = strip(
  readFileSync(path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8')
);

describe('blind level duration is format-normalized', () => {
  it('the helper exists and understands all three formats', () => {
    expect(BASE).toMatch(/levelDurationMs\(levelData: any\): number/);
    expect(BASE).toMatch(/durationMinutes \?\? levelData\?\.duration_minutes/);
    expect(BASE).toMatch(/Number\(levelData\?\.duration\)/);
  });

  it('no timer arm reads durationMinutes with the raw 10-minute fallback', () => {
    expect(BASE).not.toMatch(/durationMinutes \|\| 10/);
  });

  it('all three arm sites use the helper', () => {
    const uses = BASE.match(/this\.levelDurationMs\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });
});
