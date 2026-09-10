import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { HEADS_UP_BLIND_STRUCTURE, headsUpBlindsForLevel } from '../config/headsUpSpec.js';
import { continueBookedSpinBlinds } from './SpinDrawReceipt.js';
import { spinBlindsForLevel } from '../config/spinSpec.js';
import { escalatedBlindLevel, lastPlayableIndex } from './blindEscalation.js';
import { observedStepRatio } from './blindLadder.js';

const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const compiled = ts.transpileModule(
  'class Probe { ' +
    sliceMethod(source, 'protected resolveBlindLevel(') +
    ' } return Probe.prototype.resolveBlindLevel;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
const dependencies = {
  headsUpBlindsForLevel,
  continueBookedSpinBlinds,
  spinBlindsForLevel,
  escalatedBlindLevel,
  lastPlayableIndex,
  observedStepRatio,
};
const resolve = new Function(...Object.keys(dependencies), compiled)(
  ...Object.values(dependencies)
);

describe('the manager continues the approved Heads-Up ladder', () => {
  it.each([300, 1000])('keeps the level 12 to 13 progression at starting stack %s', (stack) => {
    const cap = vi.fn((level) => ({ ...level, smallBlind: stack / 20, bigBlind: stack / 10 }));
    const manager = {
      tournamentCache: { variant: 'sng', tournament_type: 'SNG' },
      capLevelToTournamentChips: cap,
      levelDurationMs: () => 180000,
    };
    for (const level of [12, 13, 14, 20, 32]) {
      const blinds = headsUpBlindsForLevel(level);
      expect(resolve.call(manager, HEADS_UP_BLIND_STRUCTURE, level - 1)).toMatchObject({
        level,
        smallBlind: blinds.small,
        bigBlind: blinds.big,
        ante: 0,
        durationMinutes: 3,
      });
    }
    expect(cap).not.toHaveBeenCalled();
  });

  it.each([{ variant: 'sng' }, { tournament_type: 'SNG' }])(
    'recognizes the persisted Heads-Up format %j',
    (row) => {
      expect(resolve.call({ tournamentCache: row }, HEADS_UP_BLIND_STRUCTURE, 12)).toMatchObject({
        level: 13,
        smallBlind: 280,
        bigBlind: 560,
        ante: 0,
      });
    }
  );

  it('preserves a persisted level rather than replacing it with a current preset', () => {
    const row = { level: 1, smallBlind: 3, bigBlind: 6, ante: 1, durationMinutes: 4 };
    expect(resolve.call({ tournamentCache: { variant: 'sng' } }, [row], 0)).toBe(row);
  });

  it('keeps generic MTT continuation on its existing cap and observed ladder', () => {
    const cap = vi.fn((level) => level);
    const manager = {
      tournamentCache: { variant: 'standard', tournament_type: 'MTT' },
      capLevelToTournamentChips: cap,
      levelDurationMs: () => 180000,
    };
    const actual = resolve.call(manager, HEADS_UP_BLIND_STRUCTURE, 12);
    expect(cap).toHaveBeenCalledOnce();
    expect(actual.autoEscalated).toBe(true);
    expect(actual.bigBlind).not.toBe(560);
  });
});
