/**
 * A DIAMOND DOES NOT DIVIDE (2026-09-12, Phase 7 line seven).
 *
 * A chip is two decimal places. A tournament chip is one whole unit. A DIAMOND
 * is one whole unit too, and every guard on the Diamond path refuses a fraction
 * outright rather than flooring it - so a divide that lands on half a Diamond
 * does not lose money quietly, it stops the hand, and every retry stops it
 * again. That is how run it twice was closed for Diamond: the per-board slice
 * was cut in cents, a five Diamond pot over two runs paid 2.5 a board, and the
 * table would have dealt a hand it could never settle.
 *
 * A pot can meet FOUR dividers on the way to a stack, and this pins all four to
 * the same rule rather than to the same spelling:
 *
 *   1. the run-it-twice per-board slice        ServerTableEngineRunout
 *   2. the multi-board bomb/RIT settlement     HandController
 *   3. the tie chop inside one board           PokerEngine.determineWinners
 *   4. the payout unit at the end of a hand    HandController
 *
 * The arithmetic cases below are the property. The source pins after them are
 * the regression: each divider must READ the asset rather than assume a cent,
 * so a fifth divider cannot be added in cents without this going red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { determineWinners } from './PokerEngine.js';

function twoTiedPlayers() {
  return [
    {
      user_id: 'seat1',
      seat: 1,
      is_folded: false,
      is_sitting_out: false,
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ],
    },
    {
      user_id: 'seat2',
      seat: 2,
      is_folded: false,
      is_sitting_out: false,
      cards: [
        { rank: 'A', suit: 'clubs' },
        { rank: 'K', suit: 'diamonds' },
      ],
    },
  ] as never[];
}

const BOARD = [
  { rank: '2', suit: 'clubs' },
  { rank: '7', suit: 'diamonds' },
  { rank: '9', suit: 'hearts' },
  { rank: 'J', suit: 'spades' },
  { rank: '3', suit: 'spades' },
] as never[];

const chop = (amount: number, chipUnit?: number, dealerSeat = 0) =>
  determineWinners(
    twoTiedPlayers(),
    BOARD,
    [{ amount, eligiblePlayers: ['seat1', 'seat2'] }] as never[],
    'nlh',
    dealerSeat,
    undefined,
    undefined,
    chipUnit
  );

/** The slice rule, in whichever unit the table plays in. */
const slice = (potUnits: number, runs: number) => {
  const base = Math.floor(potUnits / runs);
  const rem = potUnits - base * runs;
  return Array.from({ length: runs }, (_, b) => base + (b < rem ? 1 : 0));
};

describe('every divider a Diamond pot can meet lands on a whole Diamond', () => {
  it('the tie chop inside one board never pays half a Diamond', () => {
    for (let pot = 1; pot <= 300; pot++) {
      const ws = chop(pot, 1);
      for (const w of ws)
        expect(Number.isInteger(w.amount), `${pot} chopped to ${w.amount}`).toBe(true);
      expect(ws.reduce((s, w) => s + w.amount, 0)).toBe(pot);
    }
  });

  it('the per-board slice partitions the pot exactly for two and three runs', () => {
    for (const units of [1, 2, 3, 5, 7, 101, 999, 2227]) {
      for (const runs of [2, 3]) {
        const parts = slice(units, runs);
        expect(parts.every((p) => Number.isInteger(p))).toBe(true);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(units);
        /* The odd unit goes to the EARLIEST board. Stated, not emergent. */
        for (let i = 1; i < parts.length; i++)
          expect(parts[i - 1]).toBeGreaterThanOrEqual(parts[i]);
      }
    }
  });

  it('a pot too small to reach every board pays the earliest rather than nobody', () => {
    expect(slice(1, 3)).toEqual([1, 0, 0]);
    expect(slice(2, 3)).toEqual([1, 1, 0]);
  });

  it('the odd Diamond inside a chop goes to the first seat clockwise of the button', () => {
    const ws = chop(9, 1, 1);
    const bySeat = Object.fromEntries(ws.map((w) => [w.userId, w.amount]));
    expect(bySeat.seat2).toBe(5);
    expect(bySeat.seat1).toBe(4);
  });

  it('leaves the cash rule exactly where it was', () => {
    expect(
      chop(9.59)
        .map((w) => w.amount)
        .sort((a, b) => a - b)
    ).toEqual([4.79, 4.8]);
    expect(slice(101, 2)).toEqual([51, 50]);
  });
});

/**
 * THE REGRESSION. Each divider has to READ the asset. A new one written in
 * cents would pass every case above - they call the arithmetic directly - and
 * still deal a Diamond hand that cannot settle, which is exactly how the run
 * it twice gap survived from Phase 6 to Phase 7.
 */
describe('every divider reads the asset rather than assuming a cent', () => {
  const read = (f: string) =>
    readFileSync(join(__dirname, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  it('the run-it-twice per-board slice reads it', () => {
    const src = read('ServerTableEngineRunout.ts');
    expect(src, 'the runout must derive its unit from the table').toMatch(
      /unitCents\s*=\s*this\.tableInfo\?\.arena\?\.asset === 'diamonds' \? 100 : 1/
    );
    expect(src, 'and must not slice a pot in bare cents').not.toMatch(
      /const base = Math\.floor\(cents \/ runs\)/
    );
  });

  it('the multi-board settlement reads it', () => {
    const src = read('HandController.ts');
    expect(src).toMatch(
      /unitCents\s*=\s*this\.config\.isTournament \|\| this\.config\.asset === 'diamonds' \? 100 : 1/
    );
  });

  it('the tie chop is told it, on every board of a multi-board hand', () => {
    const src = read('HandController.ts');
    expect(src).toMatch(
      /this\.config\.isTournament \|\| this\.config\.asset === 'diamonds' \? 1 : 0\.01/
    );
  });

  it('the whole-unit backstop covers a Diamond, not only a tournament chip', () => {
    const src = read('ServerTableEngineRunout.ts');
    expect(src).toMatch(/ritNeedsWholeUnits/);
    expect(src).toMatch(
      /ritIsTournamentHand \|\|\s*this\.tableInfo\?\.arena\?\.asset === 'diamonds'/
    );
  });

  it('and the hand refuses a fraction rather than rounding one away', () => {
    const src = read('HandController.ts');
    expect(src).toMatch(/Diamond Hands Require Nonnegative Whole Units/);
  });
});
