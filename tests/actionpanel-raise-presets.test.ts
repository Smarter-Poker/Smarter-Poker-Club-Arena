/**
 * Dan 2026-08-19, bug list items 7 and 14:
 *   (7)  "4X/3X/2X raises must be multiples of the last bet, or the BB if not
 *        facing action."
 *  (14)  "3X/4X/5X raises must round to the next whole number without
 *        exceeding the pot."
 *
 * The pot ceiling is `maxRaise`, which TablePage already sets game-correctly
 * (pot cap in pot-limit, all-in in no-limit). These tests pin both the sizing
 * rules and the invariant that a preset is never an illegal bet.
 */
import { describe, it, expect } from 'vitest';
import { computeRaisePresets, potSizedRaiseTo } from '../src/components/table/ActionPanel';

const BIG = 1_000_000; // a stack large enough that maxRaise never binds

describe('potSizedRaiseTo - the one definition of a pot-sized raise', () => {
  it('is a legal PLO opening raise preflop (1/2 game opens to 7)', () => {
    // Blinds 1/2. UTG faces the BB: currentBet 2, owes 2, pot 3.
    expect(potSizedRaiseTo(2, 3, 2)).toBe(7);
  });

  it('is correct facing an open when hero has nothing invested', () => {
    // 1/2, opener to 6. Pot 9 (1 + 2 + 6), hero owes 6.
    expect(potSizedRaiseTo(6, 9, 6)).toBe(21);
  });

  it('is correct facing an open when hero already posted the big blind', () => {
    // 1/2, opener to 6, hero is the BB with 2 in, so owes only 4.
    expect(potSizedRaiseTo(6, 9, 4)).toBe(19);
  });
});

describe('computeRaisePresets - rule 7: multiples of the bet being faced', () => {
  it('uses the big blind as the baseline when there is no action to face', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 0,
      callAmount: 0,
      pot: 3,
      minRaise: 4,
      maxRaise: BIG,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', '5X']);
    expect(p.map((x) => x.value)).toEqual([4, 6, 8, 10]);
  });

  it('uses the live bet as the baseline when hero is facing an open', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 5,
      currentBet: 15,
      callAmount: 15,
      pot: 200,
      minRaise: 30,
      maxRaise: BIG,
    });
    expect(p.map((x) => x.value)).toEqual([30, 45, 60, 75]);
  });

  it('gives four DIFFERENT numbers when facing a bet (the original symptom)', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 5,
      currentBet: 15,
      callAmount: 15,
      pot: 200,
      minRaise: 30,
      maxRaise: BIG,
    });
    expect(new Set(p.map((x) => x.value)).size).toBe(4);
  });

  it('does NOT collapse preflop opens onto the pot in no-limit', () => {
    // Regression guard: capping presets at the pot would make 2X..5X identical
    // preflop, which is the dead-buttons bug all over again.
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 2,
      callAmount: 2,
      pot: 3,
      minRaise: 4,
      maxRaise: BIG,
    });
    expect(new Set(p.map((x) => x.value)).size).toBe(4);
  });
});

/**
 * Dan 2026-08-21 (item 9) SUPERSEDES the old rule 14 ("presets round up to the
 * next whole number"): "if you are raising a bet you're facing, it should
 * purely 3X, 4X or 5X the bet you're facing EXACTLY."
 *
 * Whole-number rounding and exactness cannot both hold on a table whose chips
 * are not whole numbers, and the owner ruling is exactness — a button labelled
 * 3X that raises 3.2X is worse than one that shows a fraction. The old
 * assertions are rewritten here rather than deleted so the reason the rule
 * changed stays in the suite.
 */
describe('computeRaisePresets - item 9: NX is the exact multiple', () => {
  it('emits the exact multiple even when it is fractional', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 1,
      currentBet: 2.5,
      callAmount: 2.5,
      pot: 500,
      minRaise: 5,
      maxRaise: BIG,
    });
    expect(p.map((x) => x.value)).toEqual([5, 7.5, 10, 12.5]);
  });

  it('3X of a 2.5 bet is 7.5, not 8', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 1,
      currentBet: 2.5,
      callAmount: 2.5,
      pot: 500,
      minRaise: 5,
      maxRaise: BIG,
    });
    expect(p[1].value).toBe(7.5);
  });

  it('a multiple is only moved by legality, and then it says so', () => {
    // PLO pot cap of 27.5. 2X/3X/4X of a 6 bet are 12/18/24 — all exact and
    // all legal. Nothing may be rounded away from those.
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 6,
      callAmount: 6,
      pot: 9.5,
      minRaise: 12,
      maxRaise: 27.5,
    });
    expect(p.slice(0, 3).map((x) => x.value)).toEqual([12, 18, 24]);
    for (const x of p) expect(x.value).toBeLessThanOrEqual(27.5);
    // Anything the ceiling had to move is flagged, so the UI can mark it.
    for (const x of p) {
      if (x.value !== x.raw) expect(x.cappedByMax || x.raw < 12).toBe(true);
    }
  });

  it('snaps the derived POT sizing to the table chip grid, not to 1', () => {
    // 1.5K/3K: the chip grid is the small blind, so POT lands on a multiple
    // of 1500 rather than on some neighbouring whole number.
    const p = computeRaisePresets({
      isPreflop: false,
      bigBlind: 3000,
      currentBet: 3000,
      callAmount: 3000,
      pot: 10500,
      minRaise: 6000,
      maxRaise: BIG,
      smallestChip: 1500,
    });
    const potPreset = p.find((x) => x.label === 'POT')!;
    expect(potPreset.value % 1500).toBe(0);
  });
});

describe('computeRaisePresets - never exceeds the pot in a pot-limit game', () => {
  it('caps 4X and 5X at the PLO pot cap', () => {
    // 1/2 PLO, opener to 6, hero owes 6, pot 9 -> pot cap 21.
    const cap = potSizedRaiseTo(6, 9, 6);
    expect(cap).toBe(21);
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 6,
      callAmount: 6,
      pot: 9,
      minRaise: 12,
      maxRaise: cap,
    });
    expect(p.map((x) => x.value)).toEqual([12, 18, 21, 21]);
    expect(p[2].cappedByMax).toBe(true);
    expect(p[3].cappedByMax).toBe(true);
    for (const x of p) expect(x.value).toBeLessThanOrEqual(cap);
  });
});

describe('computeRaisePresets - postflop sizing', () => {
  it('POT equals a pot-sized raise exactly, with no double-counted call', () => {
    // Facing a bet of 10 into a pot of 40; hero owes 10.
    // Correct: 10 + (40 + 10) = 60. The old formula produced 70.
    const p = computeRaisePresets({
      isPreflop: false,
      bigBlind: 2,
      currentBet: 10,
      callAmount: 10,
      pot: 40,
      minRaise: 20,
      maxRaise: BIG,
    });
    expect(p.find((x) => x.label === 'POT')!.value).toBe(60);
    expect(potSizedRaiseTo(10, 40, 10)).toBe(60);
  });

  it('an unopened street bets a plain fraction of the pot', () => {
    const p = computeRaisePresets({
      isPreflop: false,
      bigBlind: 2,
      currentBet: 0,
      callAmount: 0,
      pot: 100,
      minRaise: 2,
      maxRaise: BIG,
    });
    expect(p.map((x) => x.value)).toEqual([33, 50, 75, 100]);
  });

  it('fractions stay ordered and whole', () => {
    const p = computeRaisePresets({
      isPreflop: false,
      bigBlind: 2,
      currentBet: 10,
      callAmount: 10,
      pot: 40,
      minRaise: 20,
      maxRaise: BIG,
    });
    const vals = p.map((x) => x.value);
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
    for (const v of vals) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('computeRaisePresets - legality still wins', () => {
  it('never returns below the minimum legal raise', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 0,
      callAmount: 0,
      pot: 1,
      minRaise: 40,
      maxRaise: BIG,
    });
    for (const x of p) expect(x.value).toBeGreaterThanOrEqual(40);
  });

  it('never returns above the ceiling', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 5,
      currentBet: 15,
      callAmount: 15,
      pot: 2000,
      minRaise: 30,
      maxRaise: 50,
    });
    for (const x of p) expect(x.value).toBeLessThanOrEqual(50);
  });

  it('falls back to the ceiling when the min raise already exceeds it', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 6,
      callAmount: 6,
      pot: 9,
      minRaise: 40,
      maxRaise: 21,
    });
    for (const x of p) {
      expect(x.value).toBe(21);
      expect(x.cappedByMax).toBe(true);
    }
  });
});

describe('computeRaisePresets - rule 4b: PLO always offers RAISE POT', () => {
  it('offers a POT button PREFLOP in a pot-limit game', () => {
    // 1/2 PLO, hero UTG facing the big blind: pot 3, currentBet 2, owes 2.
    // The legal max open is 7, and that is what POT must read.
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 2,
      callAmount: 2,
      pot: 3,
      minRaise: 4,
      maxRaise: 7,
      isPotLimit: true,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', 'POT']);
    expect(p[3].value).toBe(7);
    expect(p[3].value).toBe(Math.floor(potSizedRaiseTo(2, 3, 2)));
  });

  it('offers POT preflop when facing a raise too', () => {
    // 1/2 PLO, opener to 6, hero owes 6, pot 9 -> pot raise TO 21.
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 6,
      callAmount: 6,
      pot: 9,
      minRaise: 12,
      maxRaise: 21,
      isPotLimit: true,
    });
    expect(p[3].label).toBe('POT');
    expect(p[3].value).toBe(21);
  });

  it('keeps 5X preflop in no-limit, where POT is not the defining sizing', () => {
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 2,
      callAmount: 2,
      pot: 3,
      minRaise: 4,
      maxRaise: BIG,
      isPotLimit: false,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', '5X']);
  });

  it('replaces a button that was already a silent POT', () => {
    // With maxRaise at the pot cap, 4X and 5X used to clamp to the same
    // number - 5X was an unlabelled POT. Now the fourth button says so.
    const p = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      currentBet: 2,
      callAmount: 2,
      pot: 3,
      minRaise: 4,
      maxRaise: 7,
      isPotLimit: true,
    });
    expect(p[2].value).toBe(7); // 4X = 8, capped to the pot
    expect(p[3].label).toBe('POT');
  });

  // Dan 2026-08-21: "when you are facing a bet, 3X and 4X must be clickable."
  // Postflop facing a bet now uses bet-multiples (2X/3X[/4X]) + POT; the
  // fraction row is reserved for unopened streets. In pot-limit 4X is dropped
  // (it would clamp onto POT — the dead-button rule).
  it('postflop FACING A BET offers bet multiples plus POT (pot-limit)', () => {
    const p = computeRaisePresets({
      isPreflop: false,
      bigBlind: 2,
      currentBet: 10,
      callAmount: 10,
      pot: 40,
      minRaise: 20,
      maxRaise: 60,
      isPotLimit: true,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', 'POT']);
    expect(p[2].value).toBe(60); // POT = 10 + (40 + 10)
  });

  // Dan 2026-08-21 (item 9) named 3X/4X/5X explicitly, so 5X joins the row
  // postflop in no-limit. Pot-limit still stops at 3X — see the test above:
  // with maxRaise pinned to the pot cap, every higher multiple clamps onto the
  // same number and the extra buttons would all do the same thing.
  it('postflop FACING A BET offers 2X/3X/4X/5X of the bet plus POT (no-limit)', () => {
    const p = computeRaisePresets({
      isPreflop: false,
      bigBlind: 2,
      currentBet: 10,
      callAmount: 10,
      pot: 40,
      minRaise: 20,
      maxRaise: BIG,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', '5X', 'POT']);
    // Exactly N x the bet faced (10), then the pot-sized raise.
    expect(p.map((x) => x.value)).toEqual([20, 30, 40, 50, 60]);
  });
});
