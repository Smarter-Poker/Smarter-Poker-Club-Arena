/**
 * A TOURNAMENT CHIP DOES NOT DIVIDE (2026-09-08).
 *
 * distributePot split every pot into CENTS. That is right for cash, where a
 * chip is two decimal places, and wrong for a tournament, where a chip is the
 * indivisible unit: a 959-chip pot chopped two ways paid 479.50 each.
 *
 * The damage was not the fraction itself. It was what stood downstream of it:
 *
 *   - services/supabase/tables.ts floors the stack on sync, so the .50 was
 *     destroyed - the same loss ServerTableEngineRunout.ts:2046 recorded on
 *     2026-08-26 for hand 41627f9a, and wrote a whole-chip backstop for. That
 *     backstop lives in the run-it-twice path, which is cash-only by Dan's
 *     ruling, so it guarded a branch its own comment calls "UNREACHABLE".
 *   - the settlement contract refuses a tournament hand that writes a
 *     fractional stack. The refusal is deterministic, so all five retries were
 *     identical, the engine generation died, and the table stalled for good.
 *
 * Measured on production 2026-09-08 17:35 UTC: 7 tournaments carried a
 * fractional seat and exactly those 7 were stalled; 12 seats held 6.00 chips
 * of fraction. No chips were missing - every affected tournament had an EVEN
 * number of fractional seats and a whole chips_in_play, because each .50 is
 * one half of a single chip split two ways.
 *
 * These pin the property, not the phrasing: cash still divides to the cent,
 * a tournament divides to the chip, the odd unit goes clockwise from the
 * button, and the awards always re-sum to the pot exactly.
 */
import { describe, it, expect } from 'vitest';
import { determineWinners } from './PokerEngine.js';

/** Two players who tie exactly, so the pot must be chopped. */
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

// No flush, no straight - both players play A-K high and tie exactly.
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

const sum = (ws: { amount: number }[]) =>
  Math.round(ws.reduce((s, w) => s + w.amount, 0) * 100) / 100;

describe('cash is unchanged - a chip is still two decimal places', () => {
  it('splits an odd cent to the cent, exactly as before', () => {
    const ws = chop(9.59);
    expect(ws).toHaveLength(2);
    expect(ws.map((w) => w.amount).sort((a, b) => a - b)).toEqual([4.79, 4.8]);
    expect(sum(ws)).toBe(9.59);
  });

  it('an even pot chops evenly', () => {
    expect(chop(10).map((w) => w.amount)).toEqual([5, 5]);
  });

  it('the default unit is a cent, so an unpassed chipUnit changes nothing', () => {
    expect(
      chop(9.59, undefined)
        .map((w) => w.amount)
        .sort()
    ).toEqual(
      chop(9.59, 0.01)
        .map((w) => w.amount)
        .sort()
    );
  });
});

describe('a tournament divides to the chip, never below it', () => {
  it('959 chips two ways pays whole chips, never 479.50', () => {
    const ws = chop(959, 1);
    const amounts = ws.map((w) => w.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([479, 480]);
    for (const w of ws) expect(w.amount).toBe(Math.trunc(w.amount));
    expect(sum(ws)).toBe(959);
  });

  it('never produces a fractional stack for any odd pot size', () => {
    for (let pot = 1; pot <= 400; pot++) {
      const ws = chop(pot, 1);
      for (const w of ws) {
        expect(Number.isInteger(w.amount)).toBe(true);
      }
      expect(sum(ws)).toBe(pot);
    }
  });

  it('conserves a pot that arrived fractional from a legacy stack', () => {
    // Nothing is created and nothing is destroyed: the sub-chip residue rides
    // with the first winner clockwise rather than being rounded away.
    expect(sum(chop(959.5, 1))).toBe(959.5);
    expect(sum(chop(1760.88, 1))).toBe(1760.88);
  });
});

describe('the odd unit goes clockwise from the button, as it always did', () => {
  it('the seat left of the dealer takes the odd chip, not the dealer', () => {
    // Dealer on seat 1, so seat 2 is first clockwise and takes the extra chip.
    const ws = chop(959, 1, 1);
    const bySeat = Object.fromEntries(ws.map((w) => [w.userId, w.amount]));
    expect(bySeat.seat2).toBe(480);
    expect(bySeat.seat1).toBe(479);
  });

  it('holds for cash too', () => {
    const ws = chop(9.59, 0.01, 1);
    const bySeat = Object.fromEntries(ws.map((w) => [w.userId, w.amount]));
    expect(bySeat.seat2).toBe(4.8);
    expect(bySeat.seat1).toBe(4.79);
  });
});
