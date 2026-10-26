import { afterEach, describe, expect, it } from 'vitest';
import {
  WINNER_BLUFF_MOD,
  WINNER_VALUE_THIN_MOD,
  isProvenWinner,
  observeHandResults,
  resetWinnerReads,
  respectWinner,
  winnerReadout,
} from './HorseWinnerRead.js';
import { HorseMind } from './HorseMind.js';
import { encodeHorseDecisionReads, decodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import { handNetResults } from '../services/supabase/handHistory.js';
import { mulberry32 } from './HandFuzzer.js';

const P = '50000000-0000-4000-8000-000000000001';
const Q = '50000000-0000-4000-8000-000000000002';
function gaussian(seed: number) {
  const u = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
}
function play(id: string, hands: number, meanBB: number, sdBB: number, seed: number, bb = 2) {
  const g = gaussian(seed);
  for (let h = 0; h < hands; h++)
    observeHandResults(
      `${id}:${seed}:${h}`,
      [{ user_id: id, net: (meanBB + sdBB * g()) * bb }],
      bb
    );
}
afterEach(() => {
  resetWinnerReads();
  HorseMind.reset();
});

describe('a proven winner is respected', () => {
  it('an isolated mind never inherits the live winner read', () => {
    play(P, 400, 1, 0, 101);
    expect(isProvenWinner(P)).toBe(true);
    HorseMind.runInSandbox(HorseMind.createSandbox(), () => {
      expect(isProvenWinner(P)).toBe(false);
    });
    expect(isProvenWinner(P)).toBe(true);
  });

  it('observations inside an isolated mind never alter live winner history', () => {
    const sandbox = HorseMind.createSandbox();
    HorseMind.runInSandbox(sandbox, () => {
      play(Q, 400, 1, 0, 102);
      expect(isProvenWinner(Q)).toBe(true);
    });
    expect(winnerReadout(Q)).toBeNull();
    HorseMind.runInSandbox(sandbox, () => expect(isProvenWinner(Q)).toBe(true));
  });

  it('a frozen decision restores its winner evidence after live history changes', () => {
    play(P, 400, 1, 0, 103);
    const players = [{ user_id: P }, { user_id: Q }];
    const view = HorseMind.snapshotDecisionReads(players as never, null);
    const frame = encodeHorseDecisionReads(view, players, null);
    resetWinnerReads();
    const restored = decodeHorseDecisionReads(frame, players, null);
    HorseMind.runInSandbox(restored, () => expect(isProvenWinner(P)).toBe(true));
    expect(winnerReadout(P)).toBeNull();
  });

  it('restores live reads when an isolated decision throws', () => {
    play(P, 400, 1, 0, 104);
    const sandbox = HorseMind.createSandbox();
    expect(() =>
      HorseMind.runInSandbox(sandbox, () => {
        observeHandResults('isolated', [{ user_id: Q, net: -2 }], 2);
        throw Error('decision failed');
      })
    ).toThrow('decision failed');
    expect(isProvenWinner(P)).toBe(true);
    expect(winnerReadout(Q)).toBeNull();
    HorseMind.runInSandbox(sandbox, () => expect(winnerReadout(Q)?.meanBB).toBe(-1));
  });

  it('clearing an isolated mind clears its winner state without clearing live history', () => {
    play(P, 400, 1, 0, 105);
    const sandbox = HorseMind.createSandbox();
    HorseMind.runInSandbox(sandbox, () => {
      play(Q, 400, 1, 0, 106);
      HorseMind.reset();
      expect(winnerReadout(Q)).toBeNull();
    });
    expect(isProvenWinner(P)).toBe(true);
  });

  it('a break-even player on a heater is never read as a winner', () => {
    for (let seed = 1; seed <= 20; seed++) {
      resetWinnerReads();
      play(P, 3000, 0, 9, seed);
      expect(isProvenWinner(P)).toBe(false);
    }
  });

  it('a real 70bb/100 winner is read as one once the sample is there, and not before', () => {
    play(P, 200, 0.7, 9, 7);
    expect(isProvenWinner(P)).toBe(false); // under WINNER_MIN_HANDS
    play(P, 5800, 0.7, 9, 8);
    const r = winnerReadout(P)!;
    expect(r.effectiveHands).toBeGreaterThan(1000);
    expect(r.proven).toBe(true);
  });

  it('a winner who stops winning stops being read as one', () => {
    play(P, 6000, 0.7, 9, 9);
    expect(isProvenWinner(P)).toBe(true);
    play(P, 5000, -0.2, 9, 10);
    expect(isProvenWinner(P)).toBe(false);
  });

  it('one cooler cannot make a winner, and a hand is learned once', () => {
    expect(observeHandResults('h1', [{ user_id: Q, net: 1_000_000 }], 2)).toBe(true);
    expect(observeHandResults('h1', [{ user_id: Q, net: 1_000_000 }], 2)).toBe(false);
    expect(winnerReadout(Q)!.meanBB).toBe(100);
    expect(isProvenWinner(Q)).toBe(false);
  });

  it('the counter: fewer bluffs, no thin value, call-down untouched', () => {
    const base = { bluffMod: 1.2, callDownMod: 1.4, valueThinMod: 1.3 };
    expect(respectWinner(base, P)).toEqual(base);
    play(P, 6000, 0.7, 9, 11);
    expect(respectWinner(base, P)).toEqual({
      bluffMod: 1.2 * WINNER_BLUFF_MOD,
      callDownMod: 1.4,
      valueThinMod: WINNER_VALUE_THIN_MOD,
    });
    // ...and it is what the brain's exploit profile returns.
    const ex = HorseMind.exploit(P);
    expect(ex.bluffMod).toBeCloseTo(WINNER_BLUFF_MOD, 9);
    expect(ex.valueThinMod).toBeLessThanOrEqual(WINNER_VALUE_THIN_MOD);
  });

  it('nets are chips out less chips in for every contributor', () => {
    const out = handNetResults(
      new Map([
        [P, 10],
        [Q, 4],
      ]),
      [{ userId: P, amount: 13.5 }]
    );
    expect(out).toEqual([
      { user_id: P, net: 3.5 },
      { user_id: Q, net: -4 },
    ]);
  });
});
