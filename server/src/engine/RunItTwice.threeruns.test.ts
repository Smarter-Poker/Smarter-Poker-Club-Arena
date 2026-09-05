/**
 * RUN IT TWICE — resolve() closes the offer and MOVES NO MONEY (2026-09-05).
 *
 * ── WHAT THIS FILE USED TO BE, AND WHY IT CHANGED ──
 *
 * It pinned the A9 fix (2026-08-20): `resolve()` returned a distribution Map
 * built by splitting `state.pot` evenly across the runs, and it had gated the
 * three-way split on `runs === 3 && board3Winner`, so a three-run hand whose
 * third winner was falsy paid two players a third of the pot each and the
 * board-three winner nothing.
 *
 * That was a real bug in real code — and the code was never reachable. The
 * only caller, `ServerTableEngineRunout.dealAndResolveRIT`, has always thrown
 * the return value away, because by the time it calls `resolve()` it has
 * already settled the hand properly: `determineWinners` per board against the
 * LIVE pot structure, rake and BBJ deducted once, cent-exact scaling. The
 * deleted math also said in its own comment that it treated `state.pot` as a
 * single number and therefore could not handle side pots at all.
 *
 * So eight tests guarded arithmetic that could not pay anyone. They are
 * replaced by the invariant that actually protects players: this function is
 * not a money path, and must never become one again. If someone reinstates a
 * distribution here, these fail.
 *
 * The pot-splitting laws that DO matter are pinned where the money really
 * moves — RunItTwice.money.test.ts (conservation, single rake/BBJ across runs)
 * and RunItTwice.parity.test.ts (per-(run, pot) shares summing to each
 * player's credited total).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunItTwiceEngine, type RITEvent } from './RunItTwiceEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';

const stubScheduler = {
  start() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

function armThreeRun(engine: RunItTwiceEngine, pot: number) {
  engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], pot);
  engine.chooserDecides('t1', 'A', 3);
  engine.accept('t1', 'B');
  engine.accept('t1', 'C');
}

describe('resolve() closes the offer', () => {
  let engine: RunItTwiceEngine;
  let events: RITEvent[];

  beforeEach(() => {
    events = [];
    engine = new RunItTwiceEngine((e) => events.push(e), stubScheduler);
    engine.configure('t1', { enabled: true, autoDeclineTimeout: 10, maxRuns: 3 });
  });

  it('records who took each run', () => {
    armThreeRun(engine, 300);
    engine.resolve('t1', 'A', 'B', 'C');
    const resolved = events.find((e) => e.type === 'RIT_RESOLVED');
    expect(resolved, 'resolving must announce RIT_RESOLVED').toBeTruthy();
    expect(resolved!.board1Winner).toBe('A');
    expect(resolved!.board2Winner).toBe('B');
    expect(resolved!.board3Winner).toBe('C');
  });

  it('releases the offer so it cannot outlive its hand', () => {
    armThreeRun(engine, 300);
    expect(engine.getState('t1'), 'the offer is live before resolving').toBeTruthy();
    engine.resolve('t1', 'A', 'B', 'C');
    expect(engine.getState('t1'), 'the offer must be cleared by resolve').toBeNull();
    // getChosenRuns falls back to 1 once there is no accepted offer, which is
    // what stops a stale offer from claiming consent it no longer has.
    expect(engine.getChosenRuns('t1')).toBe(1);
  });

  it('is safe on a table with no offer', () => {
    expect(() => engine.resolve('nope', 'A', 'B')).not.toThrow();
    expect(events.find((e) => e.type === 'RIT_RESOLVED')).toBeFalsy();
  });

  /**
   * THE LAW. Everything above is bookkeeping; this is the part that protects
   * players. `resolve()` returns nothing, hands out nothing, and knows nothing
   * about pots — because the settlement has already happened by the time it
   * runs, and a second opinion about who gets paid is not a safety net, it is
   * a disagreement waiting to be shipped.
   */
  it('returns nothing and pays nobody', () => {
    armThreeRun(engine, 300);
    const returned = engine.resolve('t1', 'A', 'B', 'C') as unknown;
    expect(returned, 'resolve must not hand back a distribution').toBeUndefined();

    const resolved = events.find((e) => e.type === 'RIT_RESOLVED')!;
    expect(
      Object.keys(resolved).some((k) => /distribution|payout|award|pot\d/i.test(k)),
      'RIT_RESOLVED must not carry money'
    ).toBe(false);
  });

  it('the engine holds no pot-splitting arithmetic at all', () => {
    /**
     * A source law, deliberately. The runtime assertions above pass just as
     * well against a function that computes a distribution and forgets to
     * return it — which is exactly the shape this file exists to keep out.
     * Money for a run-it-twice hand has ONE source (dealAndResolveRIT); this
     * file must not grow a second.
     */
    const src = readFileSync(join(__dirname, 'RunItTwiceEngine.ts'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/.*$/gm, ''); // line comments
    expect(code, 'no pot division in the offer engine').not.toMatch(/state\.pot\s*\//);
    expect(code, 'no per-board pot arithmetic in the offer engine').not.toMatch(
      /pot1|pot2|pot3|dealDualBoards/
    );
    expect(code, 'the offer engine builds no distribution').not.toMatch(/const\s+distribution\s*=/);
  });
});
