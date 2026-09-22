/**
 * The auto runner (Plinko's Auto Drop, Crash's Auto Play) decides one thing:
 * whether to press the plate a thumb would press. It waits while the page is
 * busy or not ready, presses after a pause once a result has landed, stops
 * on the page's own blocker, and finishes when the run is done. It never
 * presses on a spent commit (ready is false until a fresh one is in hand)
 * and never presses past a refusal.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_RUN_SIZES,
  WHEEL_RUN_SIZES,
  autoRunVerdict,
  cycleRunSize,
  tallyWheelRun,
  wheelRunSoFar,
  type WheelRun,
} from '../../src/utils/autoRun';
import type { WheelSpinResult } from '../../src/services/DiamondWheelService';

const ready = { busy: false, blocker: null, ready: true };

describe('the runner presses only when a thumb could', () => {
  it('does nothing without a run', () => {
    expect(autoRunVerdict(null, ready, 700)).toEqual({ kind: 'wait' });
  });

  it('presses the first ball at once and every later one after the pause', () => {
    expect(autoRunVerdict({ total: 5, done: 0 }, ready, 700)).toEqual({ kind: 'go', delayMs: 0 });
    expect(autoRunVerdict({ total: 5, done: 3 }, ready, 700)).toEqual({ kind: 'go', delayMs: 700 });
  });

  it('waits while a round is in flight, and while the page has no fresh commit', () => {
    expect(autoRunVerdict({ total: 5, done: 1 }, { ...ready, busy: true }, 700)).toEqual({
      kind: 'wait',
    });
    expect(autoRunVerdict({ total: 5, done: 1 }, { ...ready, ready: false }, 700)).toEqual({
      kind: 'wait',
    });
  });

  it('stops on the page’s own blocker, with the reason', () => {
    expect(
      autoRunVerdict(
        { total: 5, done: 1 },
        { ...ready, blocker: 'Not Enough Diamonds For That Bet' },
        700
      )
    ).toEqual({ kind: 'blocked', why: 'Not Enough Diamonds For That Bet' });
  });

  it('finishes when every round has landed, even if the page is ready for more', () => {
    expect(autoRunVerdict({ total: 5, done: 5 }, ready, 700)).toEqual({ kind: 'finished' });
  });

  it('a run that is done but still busy waits for the landing before finishing', () => {
    expect(autoRunVerdict({ total: 5, done: 5 }, { ...ready, busy: true }, 700)).toEqual({
      kind: 'wait',
    });
  });
});

describe('the plate cycles Off, 5, 10, 25, 50, Off', () => {
  it('walks the sizes and wraps', () => {
    expect(AUTO_RUN_SIZES).toEqual([0, 5, 10, 25, 50]);
    expect(cycleRunSize(0)).toBe(5);
    expect(cycleRunSize(5)).toBe(10);
    expect(cycleRunSize(50)).toBe(0);
  });

  it('an unknown size goes back to the first run', () => {
    expect(cycleRunSize(7)).toBe(0);
  });
});

/**
 * THE WHEEL'S RUN ACCUMULATES (owner ruling 2026-09-21, R18). A landed spin is
 * counted and its prize or game recorded on the run; nothing is awarded here,
 * the receipt already carries the server's settlement.
 */
describe('the wheel run tallies what each spin landed on', () => {
  const run: WheelRun = { runId: 'run', total: 5, done: 0, prizes: [], games: [], cards: [] };
  const title = (o: WheelSpinResult['outcome']) => `${o.amount} ${o.kind}`;
  const spin = (over: Record<string, unknown>) =>
    ({
      spin_id: `spin-${Math.random()}`,
      outcome: { ord: 1, kind: 'chips', amount: 2, value_chips: 2, label: 'x' },
      ...over,
    }) as unknown as WheelSpinResult;

  it('offers the wheel 5, 10 and 25, never 50', () => {
    expect(WHEEL_RUN_SIZES).toEqual([0, 5, 10, 25]);
    expect(cycleRunSize(25, WHEEL_RUN_SIZES)).toBe(0);
    expect(cycleRunSize(0, WHEEL_RUN_SIZES)).toBe(5);
  });

  it('records an instant prize, counts a spin that won nothing, and queues a game', () => {
    let r = tallyWheelRun(run, spin({}), title);
    expect(r.done).toBe(1);
    expect(r.prizes).toEqual([
      {
        spinId: expect.any(String),
        kind: 'chips',
        title: '2 chips',
        valueChips: 2,
        upgraded: false,
      },
    ]);
    r = tallyWheelRun(
      r,
      spin({ outcome: { ord: 2, kind: 'nothing', amount: 0, value_chips: 0, label: 'n' } }),
      title
    );
    expect(r.done).toBe(2);
    expect(r.prizes).toHaveLength(1);
    const award = {
      id: 'a',
      game: 'mines',
      base_diamonds: 100,
      boost_multiplier: 1,
      entry_diamonds: 100,
    };
    r = tallyWheelRun(
      r,
      spin({
        outcome: { ord: 3, kind: 'bonus', game: 'mines', amount: 100, value_chips: 1, label: 'm' },
        bonus: award,
      }),
      title
    );
    expect(r.done).toBe(3);
    expect(r.prizes).toHaveLength(1);
    expect(r.games).toEqual([award]);
    expect(run.done).toBe(0); // never mutated
  });

  it('an upgrade records what the ring landed on, marked as upgraded', () => {
    const chips = tallyWheelRun(
      run,
      spin({
        outcome: { ord: 12, kind: 'upgrade', amount: 200, value_chips: 2, label: 'u' },
        secondary: { outcome: { ord: 5, kind: 'chips', amount: 25, value_chips: 25, label: 'c' } },
      }),
      title
    );
    expect(chips.prizes).toEqual([
      {
        spinId: expect.any(String),
        kind: 'chips',
        title: '25 chips',
        valueChips: 25,
        upgraded: true,
      },
    ]);
    const award = {
      id: 'b',
      game: 'plinko',
      base_diamonds: 200,
      boost_multiplier: 2,
      entry_diamonds: 100,
    };
    const game = tallyWheelRun(
      run,
      spin({
        outcome: { ord: 12, kind: 'upgrade', amount: 200, value_chips: 2, label: 'u' },
        secondary: {
          outcome: {
            ord: 1,
            kind: 'bonus',
            game: 'plinko',
            amount: 200,
            value_chips: 2,
            label: 'p',
          },
        },
        bonus: award,
      }),
      title
    );
    expect(game.prizes).toEqual([]);
    expect(game.games).toEqual([award]);
  });

  it('prints the running total in one line', () => {
    expect(wheelRunSoFar(run)).toBe('Nothing Yet');
    let r = tallyWheelRun(run, spin({}), title);
    r = tallyWheelRun(
      r,
      spin({ outcome: { ord: 1, kind: 'chips', amount: 0.5, value_chips: 0.5, label: 'x' } }),
      title
    );
    r = tallyWheelRun(
      r,
      spin({ outcome: { ord: 5, kind: 'diamonds', amount: 50, value_chips: 0.5, label: 'd' } }),
      title
    );
    r = tallyWheelRun(
      r,
      spin({ outcome: { ord: 9, kind: 'throwables', amount: 3, value_chips: 1, label: 't' } }),
      title
    );
    r = tallyWheelRun(
      r,
      spin({
        outcome: { ord: 3, kind: 'bonus', game: 'crash', amount: 100, value_chips: 1, label: 'c' },
        bonus: {
          id: 'c',
          game: 'crash',
          base_diamonds: 100,
          boost_multiplier: 1,
          entry_diamonds: 100,
        },
      }),
      title
    );
    expect(wheelRunSoFar(r)).toBe('2.5 Chips, 1 Diamond Prize, 1 Reward, 1 Bonus Game');
  });
});
