import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import { SPIN_TIERS, spinBlindsForLevel } from '../config/spinSpec.js';
import { continueBookedSpinBlinds, spinRuleManifest } from './SpinDrawReceipt.js';

const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const method = sliceMethod(source, 'protected resolveBlindLevel(');
const compiled = ts.transpileModule(
  'class Probe { ' + method + ' }\nreturn Probe.prototype.resolveBlindLevel;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

describe('the complete Spin rules survive a newer engine', () => {
  it.each([300, 1000])('preserves the approved ladder, rake and board stack %s', (stack) => {
    const manifest = spinRuleManifest(10, stack);
    expect(manifest.seats).toBe(3);
    expect(manifest.rake_rate).toBe(0.08);
    expect(manifest.buy_in).toBe(10);
    expect(manifest.starting_chips).toBe(stack);
    for (const [i, original] of SPIN_TIERS.entries()) {
      const stored = manifest.tiers[i];
      expect(stored).toMatchObject(original);
      expect(stored.payout_structure).toEqual(
        original.payouts.map((p, place) => ({
          place: place + 1,
          percentage: Math.round(p * 10000) / 100,
        }))
      );
      for (let level = 13; level <= 64; level++) {
        expect(continueBookedSpinBlinds(stored.blind_structure[11], level)).toEqual(
          spinBlindsForLevel(level)
        );
      }
    }
  });

  it('the production manager uses the stored overflow formula instead of newer local rules', () => {
    const futureLocalRule = vi.fn(() => ({ small: 123456, big: 246912 }));
    const resolve = new Function('continueBookedSpinBlinds', 'spinBlindsForLevel', compiled)(
      continueBookedSpinBlinds,
      futureLocalRule
    );
    const stored = spinRuleManifest(1, 300).tiers[0].blind_structure;
    const restarted = JSON.parse(JSON.stringify(stored));
    const actual = resolve.call({ tournamentCache: { variant: 'spin' } }, restarted, 20);
    const expected = spinBlindsForLevel(21);
    expect(actual).toMatchObject({
      level: 21,
      smallBlind: expected.small,
      bigBlind: expected.big,
      duration: 180,
    });
    expect(futureLocalRule).not.toHaveBeenCalled();
  });

  it('unknown stored formula versions fail explicitly instead of falling back', () => {
    const row = spinRuleManifest(1, 300).tiers[0].blind_structure[11];
    expect(() =>
      continueBookedSpinBlinds(
        { ...row, spinContinuation: { ...row.spinContinuation, version: 99 } },
        13
      )
    ).toThrow('frozen formula');
  });
});
