import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { spinTier, spinBlindsForLevel } from '../config/spinSpec.js';

// Execute the real presentation transformation after the atomic receipt has
// already supplied its committed multiplier. Money fields never enter this
// patch; they reach memory separately from the validated receipt.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const begin = source.indexOf('const tier = spinTier(spinMultiplier);');
const end = source.indexOf('let spinPresentationWritten = false;', begin);
if (begin < 0 || end <= begin) throw new Error('Spin start fragment could not be located');
const compiled = ts.transpileModule(
  'function run() { ' +
    source.slice(begin, end) +
    '\nreturn spinPresentationPatch; }\nreturn run.call(this);',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
const execute = new Function(
  'spinMultiplier',
  'spinTier',
  'spinBlindsForLevel',
  'playedSpinRecovery',
  'tournament',
  compiled
);

describe('the committed Spin tier determines the presentation patch', () => {
  it.each([
    [10, [80, 20]],
    [2, [100]],
    [25, [80, 12, 8]],
  ])('%sx produces its canonical payout display', (committed, percentages) => {
    const patch = execute.call(
      { spinRevealLagMs: 12, spinRevealAt: 0 },
      committed,
      spinTier,
      spinBlindsForLevel,
      null,
      {}
    );
    expect(patch.payout_structure).toEqual(
      (percentages as number[]).map((percentage, i) => ({ place: i + 1, percentage }))
    );
    expect(patch.blind_structure).toHaveLength(12);
    expect(
      patch.blind_structure.every((level: { duration: number }) => level.duration === 180)
    ).toBe(true);
    expect(patch).not.toHaveProperty('spin_multiplier');
    expect(patch).not.toHaveProperty('prize_pool');
    expect(patch).not.toHaveProperty('starting_chips');
  });

  it('preserves the historical reveal timestamps when recovering an already-played Spin', () => {
    const historical = {
      spin_reveal_lag_ms: 741,
      spin_reveal_at: '2026-09-09T12:34:56.789Z',
    };
    const patch = execute.call(
      { spinRevealLagMs: 99_999, spinRevealAt: Date.parse('2026-09-09T23:59:59.999Z') },
      10,
      spinTier,
      spinBlindsForLevel,
      { recovery: true },
      historical
    );

    expect(patch.spin_reveal_lag_ms).toBe(historical.spin_reveal_lag_ms);
    expect(patch.spin_reveal_at).toBe(historical.spin_reveal_at);
  });
});
