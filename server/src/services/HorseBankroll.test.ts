/**
 * BANKROLL MANAGEMENT (Dan 2026-08-31).
 *
 * Every horse resets to 10,000 chips, and from then on the roll is a real
 * constraint. Each block below pins one of the seven fundamentals the module
 * encodes, at the fleet's actual stakes (1/2 with an 80-400 buy-in, and the
 * 2/5 game with 200-1000).
 */
import { describe, it, expect } from 'vitest';
import {
  bankrollPolicyFor,
  bankrollTemperamentFor,
  referenceBuyIn,
  canSit,
  canMoveUp,
  shouldMoveDown,
  bankrollBuyIn,
  isBroke,
  sessionVerdict,
  bestAffordableGame,
  topUpAllowance,
  canOpenAnotherTable,
} from './HorseBankroll.js';

const G_1_2 = { bigBlind: 2, minBuyIn: 80, maxBuyIn: 400 };
const G_2_5 = { bigBlind: 5, minBuyIn: 200, maxBuyIn: 1000 };
const LADDER = [G_1_2, G_2_5];
const START = 10_000; // the reset bankroll

describe('temperament is stable, and the fleet is not uniform', () => {
  it('the same horse always gets the same policy', () => {
    for (const id of ['a1', 'b2', 'c3']) {
      expect(bankrollTemperamentFor(id)).toBe(bankrollTemperamentFor(id));
    }
  });

  it('all three temperaments appear across a realistic fleet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 584; i++) seen.add(bankrollTemperamentFor(`horse-${i}`));
    expect(seen.size).toBe(3);
  });

  it('every temperament keeps the discipline: move-up is stricter than sit, which is stricter than move-down', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const p = bankrollPolicyFor(id);
      expect(p.buyInsToMoveUp).toBeGreaterThan(p.buyInsToSit);
      expect(p.moveDownAt).toBeLessThan(p.buyInsToSit);
      expect(p.maxBankrollFraction).toBeLessThanOrEqual(0.1);
      expect(p.stopWinBuyIns).toBeGreaterThan(0);
      expect(p.stopLossBuyIns).toBeGreaterThan(0);
    }
  });
});

describe('the reference buy-in is a normal stack, not the table minimum', () => {
  it('1/2 with an 80-400 spread prices at 100bb, not 80', () => {
    expect(referenceBuyIn(2, 80, 400)).toBe(200);
  });
  it('is clamped by a table that will not take 100bb', () => {
    expect(referenceBuyIn(2, 80, 150)).toBe(150);
  });
  it('respects a minimum above 100bb', () => {
    expect(referenceBuyIn(2, 300, 400)).toBe(300);
  });
});

describe('RULE 1+2+3 - sitting, moving up, moving down', () => {
  const std = bankrollPolicyFor(
    ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
  );

  it('the 10,000 reset roll covers 1/2 for a standard horse', () => {
    // 200 ref buy-in x 25 = 5,000
    expect(canSit(START, referenceBuyIn(2, 80, 400), std)).toBe(true);
  });

  it('but it may NOT move up to 2/5 on it', () => {
    // 500 ref x 35 to move up = 17,500 > 10,000
    expect(canMoveUp(START, referenceBuyIn(5, 200, 1000), std)).toBe(false);
  });

  it('moving up needs a strictly bigger roll than staying - no promotion on one heater', () => {
    const ref = referenceBuyIn(5, 200, 1000);
    const justEnoughToSit = ref * std.buyInsToSit;
    expect(canSit(justEnoughToSit, ref, std)).toBe(true);
    expect(canMoveUp(justEnoughToSit, ref, std)).toBe(false);
  });

  it('it drops down BEFORE it is broke - that is the point of moving down', () => {
    const ref = referenceBuyIn(2, 80, 400);
    const thin = ref * (std.moveDownAt - 1);
    expect(shouldMoveDown(thin, ref, std)).toBe(true);
    expect(isBroke(thin, 80)).toBe(false); // still has chips; it moves down anyway
  });
});

describe('RULE 4 - never bring too much of the roll to one table', () => {
  const std = bankrollPolicyFor(
    ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
  );

  it('a 400 max buy-in is not an instruction to bring 400 on a 3,000 roll', () => {
    const got = bankrollBuyIn({ bankroll: 3000, desired: 400, ...G_1_2, policy: std });
    expect(got).toBeLessThanOrEqual(3000 * std.maxBankrollFraction);
    expect(got).toBeGreaterThanOrEqual(G_1_2.minBuyIn);
  });

  it('when the share cannot even reach the table minimum, the answer is zero', () => {
    // 5% of 1,000 = 50, under the 80 minimum
    expect(bankrollBuyIn({ bankroll: 1000, desired: 200, ...G_1_2, policy: std })).toBe(0);
  });

  it('a healthy roll still brings a normal stack', () => {
    const got = bankrollBuyIn({ bankroll: 20_000, desired: 200, ...G_1_2, policy: std });
    expect(got).toBe(200);
  });

  it('never exceeds the table maximum however big the roll', () => {
    const got = bankrollBuyIn({ bankroll: 1_000_000, desired: 999_999, ...G_1_2, policy: std });
    expect(got).toBe(G_1_2.maxBuyIn);
  });
});

describe('RULE 5+6 - book the win, stop the loss', () => {
  const std = bankrollPolicyFor(
    ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
  );
  const ref = 200;

  it('up three buy-ins, it racks up and leaves', () => {
    expect(sessionVerdict(ref * std.stopWinBuyIns, ref, std)).toBe('book_win');
  });

  it('down three buy-ins, the session is over', () => {
    expect(sessionVerdict(-ref * std.stopLossBuyIns, ref, std)).toBe('stop_loss');
  });

  it('in between it keeps playing', () => {
    expect(sessionVerdict(ref * 1.5, ref, std)).toBe('play_on');
    expect(sessionVerdict(-ref * 1.5, ref, std)).toBe('play_on');
    expect(sessionVerdict(0, ref, std)).toBe('play_on');
  });

  /** The verdict reads the session's P&L, not the stack in front of it. */
  it('a deep stack that is STUCK is not mistaken for a winner', () => {
    // sat with 400, now has 300: stack is big, session is -100
    expect(sessionVerdict(-100, ref, std)).toBe('play_on');
    expect(sessionVerdict(-ref * 4, ref, std)).toBe('stop_loss');
  });
});

describe('RULE 7 - broke means freerolls', () => {
  it('under one buy-in of the cheapest game there is no cash play', () => {
    expect(isBroke(50, 80)).toBe(true);
    expect(isBroke(80, 80)).toBe(false);
  });

  it('bestAffordableGame returns null when nothing is covered - the freeroll path', () => {
    const std = bankrollPolicyFor(
      ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
    );
    expect(bestAffordableGame(120, LADDER, std)).toBeNull();
  });
});

describe('the ladder as a whole', () => {
  const std = bankrollPolicyFor(
    ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
  );

  it('the 10,000 reset roll picks 1/2, not the 2/5 it cannot sustain', () => {
    const g = bestAffordableGame(START, LADDER, std);
    expect(g?.bigBlind).toBe(2);
  });

  it('a big roll takes the biggest game it genuinely covers', () => {
    const g = bestAffordableGame(50_000, LADDER, std);
    expect(g?.bigBlind).toBe(5);
  });

  it('MOVING UP is held to the stricter bar than already being there', () => {
    const ref5 = referenceBuyIn(5, 200, 1000); // 500
    const roll = ref5 * std.buyInsToSit + 1; // enough to SIT at 2/5, not to move up
    expect(bestAffordableGame(roll, LADDER, std, 5)?.bigBlind).toBe(5); // already there: stays
    expect(bestAffordableGame(roll, LADDER, std, 2)?.bigBlind).toBe(2); // coming from 1/2: does not jump
  });

  it('as the roll shrinks the horse walks back DOWN the ladder', () => {
    const seq = [50_000, 10_000, 3_000, 120].map(
      (b) => bestAffordableGame(b, LADDER, std)?.bigBlind ?? null
    );
    expect(seq).toEqual([5, 2, null, null]);
  });
});

describe('TOP-UP DISCIPLINE - the reload was the leak', () => {
  const std = bankrollPolicyFor(
    ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
  );
  const base = { refBuyIn: 200, minBuyIn: 80, maxBuyIn: 400, policy: std };

  it('a healthy roll reloads normally', () => {
    const got = topUpAllowance({ bankroll: 20_000, investedThisTable: 200, desired: 120, ...base });
    expect(got).toBe(120);
  });

  it('a horse already down its stop-loss does NOT reload - it leaves', () => {
    const got = topUpAllowance({
      bankroll: 20_000,
      investedThisTable: 200 * std.stopLossBuyIns,
      desired: 120,
      ...base,
    });
    expect(got).toBe(0);
  });

  it('reloads cannot walk past the single-buy-in share one step at a time', () => {
    // 5% of 10,000 = 500 exposure cap; 450 already sunk leaves 50 of headroom
    const got = topUpAllowance({ bankroll: 10_000, investedThisTable: 450, desired: 200, ...base });
    expect(got).toBeLessThanOrEqual(50);
  });

  it('a reload that would drop the horse under its own sit bar is refused', () => {
    // 5,100 covers 1/2 at 25 buy-ins (5,000) with 100 to spare. A 200 reload
    // would leave 4,900 — under the bar — so it must not happen.
    const got = topUpAllowance({ bankroll: 5100, investedThisTable: 100, desired: 200, ...base });
    expect(got).toBe(0);
  });

  it('never reloads on an empty roll', () => {
    expect(topUpAllowance({ bankroll: 0, investedThisTable: 0, desired: 100, ...base })).toBe(0);
  });
});

describe('AGGREGATE EXPOSURE - four tables is not four independent decisions', () => {
  const std = bankrollPolicyFor(
    ['x1', 'x2', 'x3', 'x4', 'x5'].find((i) => bankrollTemperamentFor(i) === 'standard')!
  );

  it('the first table opens', () => {
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 0, nextBuyIn: 200, policy: std })
    ).toBe(true);
  });

  it('a fifth share is refused once the ceiling is reached', () => {
    // ceiling = 10,000 * 5% * 4 = 2,000 (2026-09-06: four shares, Dan's four
    // tables; it was three, which made the fourth full buy-in impossible)
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 1900, nextBuyIn: 200, policy: std })
    ).toBe(false);
    expect(
      canOpenAnotherTable({ bankroll: 10_000, liveExposure: 1500, nextBuyIn: 500, policy: std })
    ).toBe(true);
  });

  it('the ceiling scales with the roll - a big bankroll multi-tables freely', () => {
    expect(
      canOpenAnotherTable({ bankroll: 100_000, liveExposure: 1400, nextBuyIn: 200, policy: std })
    ).toBe(true);
  });
});
