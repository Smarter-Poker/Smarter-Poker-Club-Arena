import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { horsePhase8PolicyDigest } from './HorseQualifiedAuthority.js';
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)));
describe('Phase 8 qualification includes independent public-read behavior', () => {
  it.each([
    'HorseMind.ts',
    'HorseTournamentFutureGame.ts',
    'horseDecision/observerReads.ts',
    'horseDecision/workerRuntime.ts',
  ])('refuses unchanged qualification identity after changing %s', (file) => {
    const digest = horsePhase8PolicyDigest as unknown as (reader?: typeof read) => string;
    const baseline = digest(read);
    expect(
      digest((p) =>
        p === `src/engine/${file}` ? Buffer.concat([read(p), Buffer.from('\n')]) : read(p)
      )
    ).not.toBe(baseline);
  });
});
