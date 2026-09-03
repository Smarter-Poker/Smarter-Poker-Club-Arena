/**
 * RUN IT TWICE — three-run pot splitting (A9, 2026-08-20).
 *
 * resolve() used to gate the three-way split on `runs === 3 && board3Winner`.
 * A three-run hand whose third winner was falsy fell into the TWO-way branch
 * and divided the WHOLE pot between boards 1 and 2 — the board-three winner got
 * nothing and the other two shared a third that was never theirs. It was
 * reachable by design, not just by accident: the offer path initialises
 * `board3Winner = ''`, which is falsy.
 *
 * The invariant these pin: however many boards resolve, the distributed parts
 * sum to the pot EXACTLY, and they go to the players who actually won a board.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';

const stubScheduler = {
  start() {},
  schedule() {},
  cancel() {},
} as unknown as DeadlineScheduler;

function mkEngine(maxRuns: 2 | 3 = 3) {
  const engine = new RunItTwiceEngine(undefined, stubScheduler);
  engine.configure('t1', { enabled: true, autoDeclineTimeout: 10, maxRuns });
  return engine;
}

function total(d: Map<string, number>): number {
  return Math.round([...d.values()].reduce((a, b) => a + b, 0) * 100) / 100;
}

function armThreeRun(engine: RunItTwiceEngine, pot: number) {
  engine.offer('t1', 't1:1', 'A', ['A', 'B', 'C'], pot);
  engine.chooserDecides('t1', 'A', 3);
  engine.accept('t1', 'B');
  engine.accept('t1', 'C');
}

describe('RIT three-run split (A9)', () => {
  let engine: RunItTwiceEngine;
  beforeEach(() => {
    engine = mkEngine(3);
  });

  it('splits three ways when all three boards resolve', () => {
    armThreeRun(engine, 300);
    const d = engine.resolve('t1', 'A', 'B', 'C');
    expect(d.get('A')).toBe(100);
    expect(d.get('B')).toBe(100);
    expect(d.get('C')).toBe(100);
    expect(total(d)).toBe(300);
  });

  it('THE A9 BUG: a missing third winner no longer becomes a two-way split', () => {
    armThreeRun(engine, 300);
    // board3Winner falsy — the old code silently paid A and B 150 each, handing
    // them a third of the pot they had not won. Each board is now worth its own
    // third, and the undecidable third is chopped among the contenders instead.
    const d = engine.resolve('t1', 'A', 'B', '');
    expect(d.get('A')).not.toBe(150);
    expect(d.get('B')).not.toBe(150);
    expect(total(d)).toBe(300);
    // A and B keep their own board's third, plus an equal chop of board 3's.
    // C contested board 3 and so shares that chop — but wins nothing else.
    expect(d.get('A')).toBeCloseTo(100 + 100 / 3, 1);
    expect(d.get('C')).toBeCloseTo(100 / 3, 1);
  });

  it('conserves the pot exactly when it does not divide evenly', () => {
    armThreeRun(engine, 100);
    const d = engine.resolve('t1', 'A', 'B', 'C');
    expect(total(d)).toBe(100);
    // 100/3 = 33.33 each, remainder rides on the last share.
    expect(d.get('A')).toBe(33.33);
    expect(d.get('B')).toBe(33.33);
    expect(d.get('C')).toBe(33.34);
  });

  it('accumulates when one player wins more than one board', () => {
    armThreeRun(engine, 300);
    const d = engine.resolve('t1', 'A', 'A', 'C');
    expect(d.get('A')).toBe(200);
    expect(d.get('C')).toBe(100);
    expect(total(d)).toBe(300);
  });

  it('gives the whole pot to a player who wins all three', () => {
    armThreeRun(engine, 300);
    const d = engine.resolve('t1', 'A', 'A', 'A');
    expect(d.get('A')).toBe(300);
    expect(total(d)).toBe(300);
  });

  it('chops the whole pot among contenders when NO board resolves', () => {
    armThreeRun(engine, 300);
    const d = engine.resolve('t1', '', '', '');
    // Nobody won a board, so nobody is paid for one — but the chips still
    // belong to the three players who were all-in for them.
    expect(total(d)).toBe(300);
    expect(d.get('A')).toBe(100);
    expect(d.get('B')).toBe(100);
    expect(d.get('C')).toBe(100);
  });
});

describe('RIT two-run split is unchanged', () => {
  it('halves the pot between two different winners', () => {
    const engine = mkEngine(2);
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 101);
    engine.chooserDecides('t1', 'A', 2);
    engine.accept('t1', 'B');
    const d = engine.resolve('t1', 'A', 'B');
    expect(total(d)).toBe(101);
    expect(d.get('A')).toBe(50.5);
    expect(d.get('B')).toBe(50.5);
  });

  it('gives the whole pot to a player who wins both boards', () => {
    const engine = mkEngine(2);
    engine.offer('t1', 't1:1', 'A', ['A', 'B'], 300);
    engine.chooserDecides('t1', 'A', 2);
    engine.accept('t1', 'B');
    const d = engine.resolve('t1', 'A', 'A');
    expect(d.get('A')).toBe(300);
    expect(total(d)).toBe(300);
  });
});
