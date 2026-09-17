/**
 * The auto runner (Plinko's Auto Drop, Crash's Auto Play) decides one thing:
 * whether to press the plate a thumb would press. It waits while the page is
 * busy or not ready, presses after a pause once a result has landed, stops
 * on the page's own blocker, and finishes when the run is done. It never
 * presses on a spent commit (ready is false until a fresh one is in hand)
 * and never presses past a refusal.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_RUN_SIZES, autoRunVerdict, cycleRunSize } from '../../src/utils/autoRun';

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
