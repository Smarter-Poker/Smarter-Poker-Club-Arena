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
      isPreflop: true, bigBlind: 2, currentBet: 0, callAmount: 0,
      pot: 3, minRaise: 4, maxRaise: BIG,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', '5X']);
    expect(p.map((x) => x.value)).toEqual([4, 6, 8, 10]);
  });

  it('uses the live bet as the baseline when hero is facing an open', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 5, currentBet: 15, callAmount: 15,
      pot: 200, minRaise: 30, maxRaise: BIG,
    });
    expect(p.map((x) => x.value)).toEqual([30, 45, 60, 75]);
  });

  it('gives four DIFFERENT numbers when facing a bet (the original symptom)', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 5, currentBet: 15, callAmount: 15,
      pot: 200, minRaise: 30, maxRaise: BIG,
    });
    expect(new Set(p.map((x) => x.value)).size).toBe(4);
  });

  it('does NOT collapse preflop opens onto the pot in no-limit', () => {
    // Regression guard: capping presets at the pot would make 2X..5X identical
    // preflop, which is the dead-buttons bug all over again.
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 2, callAmount: 2,
      pot: 3, minRaise: 4, maxRaise: BIG,
    });
    expect(new Set(p.map((x) => x.value)).size).toBe(4);
  });
});

/**
 * SUPERSEDED RULE, REWRITTEN RATHER THAN DELETED.
 *
 * This block used to assert that presets are always whole numbers, rounded UP.
 * Dan's item 9 (2026-08-21) replaced that: "if you are raising a bet you're
 * facing, it should purely 3X, 4X or 5X the bet you're facing EXACTLY."
 *
 * The two rules cannot both hold. On a 0.5/1 table, 3X of a 2.5 bet is 7.5;
 * rounding it up to 8 puts 3.2X behind a button that says 3X, which is the
 * exact complaint. So a multiple is now EXACT, and the only thing allowed to
 * move it is legality - the minimum raise below, the all-in ceiling above -
 * which the preset reports through cappedByMax rather than silently.
 *
 * The intent the old tests were protecting still stands and is asserted here:
 * a preset never quietly becomes a number the player did not ask for.
 */
describe('computeRaisePresets - a multiple is exact, and only legality moves it', () => {
  it('is an exact multiple of the bet, even when that is fractional', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 1, currentBet: 2.5, callAmount: 2.5,
      pot: 500, minRaise: 5, maxRaise: BIG,
    });
    // 2X..5X of a 2.5 bet.
    expect(p.map((x) => x.value)).toEqual([5, 7.5, 10, 12.5]);
    for (const x of p) expect(x.cappedByMax).toBe(false);
  });

  it('never rounds a multiple against the player', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 1, currentBet: 2.5, callAmount: 2.5,
      pot: 500, minRaise: 5, maxRaise: BIG,
    });
    // 3 x 2.5 is 7.5. Not 8, which would raise 3.2X behind a 3X button.
    expect(p[1].label).toBe('3X');
    expect(p[1].value).toBe(7.5);
  });

  it('clamps to the ceiling and SAYS SO, instead of moving the number quietly', () => {
    // A pot cap of 27.5 sits under 5X of a 6 bet (30).
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 6, callAmount: 6,
      pot: 9.5, minRaise: 12, maxRaise: 27.5,
    });
    const five = p[p.length - 1];
    expect(five.label).toBe('5X');
    expect(five.raw).toBe(30);
    expect(five.value).toBe(27.5);
    expect(five.cappedByMax).toBe(true);
    for (const x of p) expect(x.value).toBeLessThanOrEqual(27.5);
    // Everything under the ceiling is still exact.
    expect(p.slice(0, 3).map((x) => x.value)).toEqual([12, 18, 24]);
  });
});

describe('computeRaisePresets - never exceeds the pot in a pot-limit game', () => {
  it('caps 4X and 5X at the PLO pot cap', () => {
    // 1/2 PLO, opener to 6, hero owes 6, pot 9 -> pot cap 21.
    const cap = potSizedRaiseTo(6, 9, 6);
    expect(cap).toBe(21);
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 6, callAmount: 6,
      pot: 9, minRaise: 12, maxRaise: cap,
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
      isPreflop: false, bigBlind: 2, currentBet: 10, callAmount: 10,
      pot: 40, minRaise: 20, maxRaise: BIG,
    });
    expect(p.find((x) => x.label === 'POT')!.value).toBe(60);
    expect(potSizedRaiseTo(10, 40, 10)).toBe(60);
  });

  it('an unopened street bets a plain fraction of the pot', () => {
    const p = computeRaisePresets({
      isPreflop: false, bigBlind: 2, currentBet: 0, callAmount: 0,
      pot: 100, minRaise: 2, maxRaise: BIG,
    });
    expect(p.map((x) => x.value)).toEqual([33, 50, 75, 100]);
  });

  it('fractions stay ordered and whole', () => {
    const p = computeRaisePresets({
      isPreflop: false, bigBlind: 2, currentBet: 10, callAmount: 10,
      pot: 40, minRaise: 20, maxRaise: BIG,
    });
    const vals = p.map((x) => x.value);
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
    for (const v of vals) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('computeRaisePresets - legality still wins', () => {
  it('never returns below the minimum legal raise', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 0, callAmount: 0,
      pot: 1, minRaise: 40, maxRaise: BIG,
    });
    for (const x of p) expect(x.value).toBeGreaterThanOrEqual(40);
  });

  it('never returns above the ceiling', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 5, currentBet: 15, callAmount: 15,
      pot: 2000, minRaise: 30, maxRaise: 50,
    });
    for (const x of p) expect(x.value).toBeLessThanOrEqual(50);
  });

  it('falls back to the ceiling when the min raise already exceeds it', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 6, callAmount: 6,
      pot: 9, minRaise: 40, maxRaise: 21,
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
      isPreflop: true, bigBlind: 2, currentBet: 2, callAmount: 2,
      pot: 3, minRaise: 4, maxRaise: 7, isPotLimit: true,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', 'POT']);
    expect(p[3].value).toBe(7);
    expect(p[3].value).toBe(Math.floor(potSizedRaiseTo(2, 3, 2)));
  });

  it('offers POT preflop when facing a raise too', () => {
    // 1/2 PLO, opener to 6, hero owes 6, pot 9 -> pot raise TO 21.
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 6, callAmount: 6,
      pot: 9, minRaise: 12, maxRaise: 21, isPotLimit: true,
    });
    expect(p[3].label).toBe('POT');
    expect(p[3].value).toBe(21);
  });

  it('keeps 5X preflop in no-limit, where POT is not the defining sizing', () => {
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 2, callAmount: 2,
      pot: 3, minRaise: 4, maxRaise: BIG, isPotLimit: false,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', '5X']);
  });

  it('replaces a button that was already a silent POT', () => {
    // With maxRaise at the pot cap, 4X and 5X used to clamp to the same
    // number - 5X was an unlabelled POT. Now the fourth button says so.
    const p = computeRaisePresets({
      isPreflop: true, bigBlind: 2, currentBet: 2, callAmount: 2,
      pot: 3, minRaise: 4, maxRaise: 7, isPotLimit: true,
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
      isPreflop: false, bigBlind: 2, currentBet: 10, callAmount: 10,
      pot: 40, minRaise: 20, maxRaise: 60, isPotLimit: true,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', 'POT']);
    expect(p[2].value).toBe(60); // POT = 10 + (40 + 10)
  });

  it('postflop FACING A BET offers 2X/3X/4X/5X of the bet plus POT (no-limit)', () => {
    // 5X joined the ladder with Dan's item 9; POT stays last.
    const p = computeRaisePresets({
      isPreflop: false, bigBlind: 2, currentBet: 10, callAmount: 10,
      pot: 40, minRaise: 20, maxRaise: BIG,
    });
    expect(p.map((x) => x.label)).toEqual(['2X', '3X', '4X', '5X', 'POT']);
    expect(p.map((x) => x.value)).toEqual([20, 30, 40, 50, 60]);
  });
});
