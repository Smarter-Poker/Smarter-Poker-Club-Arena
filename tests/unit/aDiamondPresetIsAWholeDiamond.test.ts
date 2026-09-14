/**
 * A DIAMOND PRESET IS A WHOLE DIAMOND.
 *
 * `HandController.performAction` refuses a non-integer amount outright when
 * the table's asset is diamonds - it returns `false`, with no error and no
 * toast - so a preset button whose value is a half Diamond is a button that
 * does nothing at all when you press it. Two separate things were producing
 * exactly that, and both had been live on Diamond NLH since the arena opened.
 *
 *   THE MULTIPLES ROW carries 2.5X and 3.5X, and two and a half times an odd
 *   bet is a half. `finalizeExact` preserved it deliberately, on the reasoning
 *   that "N times a legal bet is already a legal amount by construction" -
 *   which is true for whole N and false for these two.
 *
 *   THE GRID ITSELF. The fallback is `bigBlind / 2`, the small blind for every
 *   standard structure. Three rungs of Dan's Diamond stake ladder are not
 *   standard - 10/25, 200/500 and 1000/2500 - and 25/2 is 12.5. POT and every
 *   postflop fraction snapped onto a grid the table cannot pay.
 *
 * The fix is one idea in two places: the table's indivisible unit is a
 * parameter, the grid is rounded onto it, and the cleaner lands every value on
 * it. For chips the unit is a cent, which is what the cleaner already did, so
 * the chip path is unchanged by construction - and that is asserted here too,
 * because a fix that silently moves chip amounts is a worse bug than the one
 * it repairs.
 */
import { describe, expect, it } from 'vitest';
import { computeRaisePresets } from '../../src/components/table/ActionPanel';

/** Dan's Diamond stake ladder, all seventeen rungs, as live in production. */
const LADDER: Array<[number, number]> = [
  [1, 2],
  [2, 5],
  [5, 10],
  [10, 20],
  [10, 25],
  [25, 50],
  [50, 100],
  [100, 200],
  [200, 400],
  [200, 500],
  [300, 600],
  [400, 800],
  [500, 1000],
  [1000, 2000],
  [1000, 2500],
  [2500, 5000],
  [5000, 10000],
];

const diamond = (over: Partial<Parameters<typeof computeRaisePresets>[0]>) =>
  computeRaisePresets({
    isPreflop: true,
    bigBlind: 2,
    currentBet: 2,
    callAmount: 2,
    pot: 3,
    minRaise: 4,
    maxRaise: 100000,
    unit: 1,
    ...over,
  });

describe('every Diamond preset is a whole Diamond', () => {
  it.each(LADDER)('on the %s/%s rung, preflop and postflop', (sb, bb) => {
    for (const isPreflop of [true, false]) {
      /* An ODD bet faced is the case that matters: 2.5X and 3.5X of an even
         number are whole by luck, and luck is not a guarantee. */
      for (const faced of [bb, bb + 1, bb * 3 + 1]) {
        const presets = diamond({
          isPreflop,
          bigBlind: bb,
          smallestChip: sb,
          currentBet: faced,
          callAmount: faced,
          pot: faced * 3 + 1,
          minRaise: faced * 2,
          maxRaise: faced * 400,
        });
        expect(presets.length, 'a row with no buttons proves nothing').toBeGreaterThan(0);
        for (const preset of presets) {
          expect(
            Number.isSafeInteger(preset.value),
            `${preset.label} at ${sb}/${bb} facing ${faced} is ${preset.value}, which the engine refuses`
          ).toBe(true);
        }
      }
    }
  });

  it('including the three rungs whose small blind is not half the big blind', () => {
    /* These are the ones the `bigBlind / 2` fallback got wrong: 12.5, 250 and
       1250. The first and last are half a Diamond. Asserted with NO
       `smallestChip`, so the fallback itself is what is under test. */
    for (const [, bb] of [
      [10, 25],
      [200, 500],
      [1000, 2500],
    ] as Array<[number, number]>) {
      const presets = diamond({
        isPreflop: false,
        bigBlind: bb,
        currentBet: 0,
        callAmount: 0,
        pot: bb * 7,
        minRaise: bb,
        maxRaise: bb * 500,
      });
      for (const preset of presets) {
        expect(
          Number.isSafeInteger(preset.value),
          `${preset.label} fell off the grid at a ${bb} big blind: ${preset.value}`
        ).toBe(true);
      }
    }
  });

  it('and a chip table is not moved by any of it', () => {
    /* The same inputs with the chip unit. Cents are still reachable, the
       exact multiples are still exact, and nothing here rounds to a whole
       chip - which is the half of this change that must NOT happen. */
    const chips = computeRaisePresets({
      isPreflop: true,
      bigBlind: 2,
      smallestChip: 1,
      currentBet: 3,
      callAmount: 3,
      pot: 7,
      minRaise: 6,
      maxRaise: 1000,
    });
    const byLabel = Object.fromEntries(chips.map((p) => [p.label, p.value]));
    expect(byLabel['2.5X'], 'the exact multiple is still exact for chips').toBe(7.5);
    expect(byLabel['3.5X']).toBe(10.5);
    expect(byLabel['3X']).toBe(9);
    expect(byLabel['4X']).toBe(12);
  });

  it('a Diamond table rounds those same multiples rather than dropping them', () => {
    /* The row keeps all four buttons. A 2.5X that cannot be paid is not
       replaced by nothing; it is replaced by the nearest amount that can. */
    const presets = diamond({
      bigBlind: 2,
      smallestChip: 1,
      currentBet: 3,
      callAmount: 3,
      pot: 7,
      minRaise: 6,
      maxRaise: 1000,
    });
    const byLabel = Object.fromEntries(presets.map((p) => [p.label, p.value]));
    expect(byLabel['2.5X']).toBe(8);
    expect(byLabel['3X']).toBe(9);
    expect(byLabel['3.5X']).toBe(11);
    expect(byLabel['4X']).toBe(12);
  });
});
