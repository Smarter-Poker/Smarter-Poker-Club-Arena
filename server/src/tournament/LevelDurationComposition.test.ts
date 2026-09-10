import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { acceleratedLevelMs } from './acceleratedLevels.js';
import { escalatedBlindLevel, lastPlayableIndex } from './blindEscalation.js';
import { observedStepRatio } from './blindLadder.js';
import { continueBookedSpinBlinds } from './SpinDrawReceipt.js';
import { spinBlindsForLevel } from '../config/spinSpec.js';

const source = readFileSync(
  path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const signatures = ['protected levelDurationMs(', 'protected resolveBlindLevel('];
if (source.includes('protected rawLevelDurationMs('))
  signatures.push('protected rawLevelDurationMs(');
const methods = signatures.map((signature) =>
  sliceMethod(source, signature).replace(/^protected\s+/, '')
);
const runtime = ts.transpileModule('return { ' + methods.join(',\n') + ' };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function manager(accelerated: boolean, closed: boolean, spin = false) {
  return {
    ...new Function(
      'acceleratedLevelMs',
      'escalatedBlindLevel',
      'lastPlayableIndex',
      'observedStepRatio',
      'continueBookedSpinBlinds',
      'spinBlindsForLevel',
      runtime
    )(
      acceleratedLevelMs,
      escalatedBlindLevel,
      lastPlayableIndex,
      observedStepRatio,
      continueBookedSpinBlinds,
      spinBlindsForLevel
    ),
    tournamentCache: { accelerated_mtt: accelerated, variant: spin ? 'spin' : 'mtt' },
    isLateRegClosed: () => closed,
    capLevelToTournamentChips: (level: unknown) => level,
  };
}

describe('the actual manager resolves raw level duration before applying acceleration once', () => {
  for (const alias of ['durationMinutes', 'duration_minutes', 'duration']) {
    for (const minutes of [0.5, 1, 5, 10, 15]) {
      for (const accelerated of [false, true]) {
        for (const closed of [false, true]) {
          it(`${alias} ${minutes} minutes, accelerated ${accelerated}, entry closed ${closed}`, () => {
            const state = manager(accelerated, closed);
            const duration = { [alias]: alias === 'duration' ? minutes * 60 : minutes };
            const structure = Object.freeze([
              Object.freeze({ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, ...duration }),
              Object.freeze({ level: 2, smallBlind: 50, bigBlind: 100, ante: 0, ...duration }),
              Object.freeze({
                level: 3,
                isBreak: true,
                smallBlind: 0,
                bigBlind: 0,
                durationMinutes: 5,
              }),
            ]);
            const expected = accelerated && closed ? Math.max(1, Math.ceil(minutes / 2)) : minutes;
            for (const index of [0, 1, 3, 9]) {
              const level = state.resolveBlindLevel(structure, index);
              expect(state.levelDurationMs(level)).toBe(expected * 60000);
            }
            expect(structure).toHaveLength(3);
          });
        }
      }
    }
  }

  it('keeps three-minute Spin seconds through overflow without a generic duration floor', () => {
    const state = manager(false, false, true);
    const structure = [{ level: 1, smallBlind: 5, bigBlind: 10, ante: 0, duration: 180 }];
    for (const index of [0, 1, 12, 25]) {
      expect(state.levelDurationMs(state.resolveBlindLevel(structure, index))).toBe(180000);
    }
  });
});
