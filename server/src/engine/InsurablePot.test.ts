/**
 * INSURABLE POT — side-pot cap + net-of-rake pricing (2026-08-28).
 *
 * The dialog's "Pot" must be what the LEADER collects by winning:
 *   - only the side pots their chips are in,
 *   - net of rake + BBJ drop (winners are scaled proportionally at
 *     settlement, so the leader's net = eligible x (total - rake - bbj)/total).
 *
 * computeInsurablePot only touches `this.handController`, so these tests call
 * it on the prototype with a stub controller — the same shape the live engine
 * exposes (computeLivePots / computeRakeAndBBJ / getPot).
 */
import { describe, it, expect } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import type { Pot } from '../types.js';

function insurablePot(
  pots: Pot[],
  rake: number,
  bbjFee: number,
  leaderId: string,
  grossPot: number
): number {
  const fake = {
    handController: {
      computeLivePots: () => pots,
      computeRakeAndBBJ: () => ({ rake, bbjFee }),
    },
  };
  return (
    ServerTableEngine.prototype as unknown as {
      computeInsurablePot(l: string, g: number): number;
    }
  ).computeInsurablePot.call(fake, leaderId, grossPot);
}

describe('computeInsurablePot', () => {
  it('heads-up, no rake: the contested pot, unchanged', () => {
    const pots: Pot[] = [{ amount: 62, eligiblePlayers: ['L', 'O'] }];
    expect(insurablePot(pots, 0, 0, 'L', 62)).toBe(62);
  });

  it('rake + BBJ come off the top: 5% + 1 on a 62 pot', () => {
    const pots: Pot[] = [{ amount: 62, eligiblePlayers: ['L', 'O'] }];
    // net = 62 x (62 - 3.1 - 1) / 62 = 57.9
    expect(insurablePot(pots, 3.1, 1, 'L', 62)).toBe(57.9);
  });

  it('SIDE POTS: a short leader insures only the pots they are in', () => {
    // Leader all-in short: main pot 90 (3-way), side pot 200 (two big stacks).
    const pots: Pot[] = [
      { amount: 90, eligiblePlayers: ['L', 'B1', 'B2'] },
      { amount: 200, eligiblePlayers: ['B1', 'B2'] },
    ];
    // eligible 90 of 290 total, no rake: exactly the main pot.
    expect(insurablePot(pots, 0, 0, 'L', 290)).toBe(90);
  });

  it('SIDE POTS + rake: the eligible share is scaled by the net fraction', () => {
    const pots: Pot[] = [
      { amount: 90, eligiblePlayers: ['L', 'B1', 'B2'] },
      { amount: 200, eligiblePlayers: ['B1', 'B2'] },
    ];
    // net fraction = (290 - 14.5 - 0)/290 = 0.95 → 90 x 0.95 = 85.5
    expect(insurablePot(pots, 14.5, 0, 'L', 290)).toBe(85.5);
  });

  it('a big-stack leader eligible everywhere insures the whole net pot', () => {
    const pots: Pot[] = [
      { amount: 90, eligiblePlayers: ['S', 'L', 'B2'] },
      { amount: 200, eligiblePlayers: ['L', 'B2'] },
    ];
    expect(insurablePot(pots, 0, 0, 'L', 290)).toBe(290);
  });

  it('falls back to the gross pot when the controller cannot answer', () => {
    const fake = { handController: null };
    const v = (
      ServerTableEngine.prototype as unknown as {
        computeInsurablePot(l: string, g: number): number;
      }
    ).computeInsurablePot.call(fake, 'L', 123.45);
    expect(v).toBe(123.45);
  });

  it('leader in no pot (defensive): falls back to gross rather than refusing', () => {
    const pots: Pot[] = [{ amount: 100, eligiblePlayers: ['A', 'B'] }];
    expect(insurablePot(pots, 0, 0, 'L', 100)).toBe(100);
  });
});
