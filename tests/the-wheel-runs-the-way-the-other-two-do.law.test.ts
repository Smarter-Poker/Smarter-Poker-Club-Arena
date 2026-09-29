/**
 * THE WHEEL RUNS THE WAY THE OTHER TWO DO (2026-09-11, BINDING)
 *
 * Phase 5 of 6. Plinko has had Auto Drop and Crash Auto Play since 2026-09-10.
 * The wheel, which is the slowest of the three to press by hand because its
 * landing takes five seconds, had neither.
 *
 * The danger in adding one is that it becomes a SECOND runner: a loop with its
 * own idea of when to press, its own idea of when to stop, and its own bugs.
 * There is one runner in this codebase, `autoRunVerdict`, and it makes exactly
 * one decision - wait, press, finish, or stop because the page would refuse a
 * thumb. This law holds the wheel to it.
 *
 * And two rules that are the wheel's alone:
 *
 *   A WELCOME SPIN IS NEVER AUTO-PLAYED. It is once per member, ever, and it
 *   costs nothing. There is no run to make of it, so the size cannot be set and
 *   a run cannot be started while the wheel is on the house.
 *
 *   THE RUN NEVER PRESSES WHILE THE WHEEL IS TURNING. Plinko and Crash finish a
 *   round at the server; the wheel's result is decided at the server and then
 *   SPUN for five seconds before the player sees it. `busy` therefore covers
 *   the animation as well as the request, and the spin is counted when it
 *   lands, not when it is asked for.
 *
 * MOVED 2026-09-21 (owner ruling, R18): the wheel's run now ACCUMULATES. A
 * landed spin is tallied (`tallyWheelRun`) rather than merely counted, a
 * refusal ends the run with the server's reason rather than a bare "Stopped",
 * and the run is declared to and closed at the server (`runBegin`/`runEnd`).
 * The pins below on the counting line and the refusal text moved with it; the
 * runner itself, its four verdicts and its one press path are unchanged. The
 * wheel's plate offers 5, 10 and 25 (`WHEEL_RUN_SIZES`), R1's "5/10/25".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  AUTO_RUN_SIZES,
  WHEEL_RUN_SIZES,
  autoRunVerdict,
  cycleRunSize,
} from '../src/utils/autoRun';

const ROOT = resolve(__dirname, '..');
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const WHEEL = src('src/pages/DiamondWheelPage.tsx');
const CRASH = src('src/pages/DiamondCrashPage.tsx');

describe('the wheel and crash share their repeat-round runner', () => {
  it.each([
    ['wheel', WHEEL],
    ['crash', CRASH],
  ])('%s asks autoRunVerdict rather than deciding for itself', (_n, page) => {
    expect(page).toContain("from '../utils/autoRun'");
    expect(page).toContain('autoRunVerdict(');
    expect(page).toContain('cycleRunSize');
  });

  it('the wheel handles all four verdicts, and no fifth thing', () => {
    const effect = WHEEL.slice(WHEEL.indexOf('const verdict = autoRunVerdict('));
    const block = effect.slice(0, effect.indexOf('const handleVerify'));
    for (const k of ["'wait'", "'finished'", "'blocked'"]) expect(block).toContain(k);
    expect(block).toContain('setTimeout(() => void handleSpin(), verdict.delayMs)');
    // The runner presses the same function a thumb presses. A private spin path
    // would be a second implementation of the one thing that moves money.
    expect(block).not.toContain('DiamondWheelService.spin(');
    expect(block).not.toContain('DiamondWheelService.welcomeSpin(');
  });

  /**
   * THE RUNNER IS IMPORTED, NOT GREPPED (2026-09-11).
   *
   * The first cut of this read src/utils/autoRun.ts as TEXT and asserted the
   * words "outcome", "prize" and "payout" were absent from it. The repo's own
   * source-grep ratchet blocked that, and it was right to: autoRun is a pure,
   * importable module, and a test that greps a pure module cannot catch a line
   * that is present and wrong. It also could not tell the code from the doc
   * comment, which is how the first version of that assertion failed.
   *
   * So the claim is made by EXERCISING it. A runner that decided anything
   * about an outcome would have to be given one, and it is given nothing but
   * the page's own busy, blocker and ready.
   */
  const page = (over: Partial<{ busy: boolean; blocker: string | null; ready: boolean }> = {}) => ({
    busy: false,
    blocker: null as string | null,
    ready: true,
    ...over,
  });

  it('takes nothing but the page own readiness, and answers one of four things', () => {
    const run = { total: 5, done: 1 };
    expect(autoRunVerdict(run, page({ busy: true }), 700)).toEqual({ kind: 'wait' });
    expect(autoRunVerdict(run, page({ ready: false }), 700)).toEqual({ kind: 'wait' });
    expect(autoRunVerdict({ total: 5, done: 5 }, page(), 700)).toEqual({ kind: 'finished' });
    expect(autoRunVerdict(run, page({ blocker: 'Out Of Diamonds' }), 700)).toEqual({
      kind: 'blocked',
      why: 'Out Of Diamonds',
    });
    expect(autoRunVerdict(run, page(), 700)).toEqual({ kind: 'go', delayMs: 700 });
    // The first press is immediate; the pause exists to let a result be read.
    expect(autoRunVerdict({ total: 5, done: 0 }, page(), 700)).toEqual({ kind: 'go', delayMs: 0 });
  });

  it('and a verdict carries no prize, multiplier, slot or payout to carry', () => {
    const keys = new Set<string>();
    for (const v of [
      autoRunVerdict({ total: 2, done: 0 }, page(), 700),
      autoRunVerdict({ total: 2, done: 2 }, page(), 700),
      autoRunVerdict({ total: 2, done: 1 }, page({ blocker: 'Paused' }), 700),
      autoRunVerdict({ total: 2, done: 1 }, page({ busy: true }), 700),
    ]) {
      Object.keys(v).forEach((k) => keys.add(k));
    }
    expect([...keys].sort()).toEqual(['delayMs', 'kind', 'why']);
  });

  it('a run with no size never presses, and the sizes cycle back to Off', () => {
    expect(autoRunVerdict(null, page(), 700)).toEqual({ kind: 'wait' });
    let n: number = 0;
    const seen: number[] = [];
    for (let i = 0; i < AUTO_RUN_SIZES.length; i++) {
      n = cycleRunSize(n);
      seen.push(n);
    }
    expect(seen).toEqual([...AUTO_RUN_SIZES.slice(1), 0]);
  });

  it('the wheel offers 5, 10 and 25 spins, and cycles those back to Off (R1, R18)', () => {
    expect(WHEEL_RUN_SIZES).toEqual([0, 5, 10, 25]);
    expect(WHEEL).toContain('cycleRunSize(size, WHEEL_RUN_SIZES)');
    let n: number = 0;
    const seen: number[] = [];
    for (let i = 0; i < WHEEL_RUN_SIZES.length; i++) {
      n = cycleRunSize(n, WHEEL_RUN_SIZES);
      seen.push(n);
    }
    expect(seen).toEqual([5, 10, 25, 0]);
  });
});

describe('the run stops wherever a thumb would be stopped', () => {
  it('on any blocker the page would print', () => {
    expect(WHEEL).toContain(
      '{ busy: spinning || pending !== null || preparing, blocker, ready: canSpin }'
    );
  });

  it('on a refusal from the server', () => {
    const spin = WHEEL.slice(WHEEL.indexOf('const handleSpin'), WHEEL.indexOf('const playAward'));
    // Once in the refusal branch, with the server's own reason, and once in
    // the catch: a request that never answered must not leave a run pressing
    // into the dark. (Moved 2026-09-21, R18: the reason reaches the summary.)
    expect(spin).toContain("endAuto(result.error || 'The Spin Was Refused')");
    expect(spin).toContain("endAuto('The Spin Is Not Confirmed')");
    expect(spin.match(/endAuto\(/g)?.length).toBe(2);
  });

  it('and the stop plate is the run plate, in red, while it runs', () => {
    expect(WHEEL).toContain(
      "const autoLabel = running ? 'Stop' : autoSize ? `Run ${autoSize}` : 'Run Off';"
    );
    expect(WHEEL).toContain("{ label: autoLabel, ink: 'red', onClick: stopAuto }");
  });
});

describe('a welcome spin is never auto-played', () => {
  it('the size cannot be cycled while the wheel is on the house', () => {
    const cycle = WHEEL.slice(WHEEL.indexOf('const cycleAuto'), WHEEL.indexOf('const endAuto'));
    expect(cycle).toContain('if (running || spinning || freeMode || recovery) return;');
  });

  it('and a run cannot be started', () => {
    const start = WHEEL.slice(WHEEL.indexOf('const startAuto'), WHEEL.indexOf('const stopAuto'));
    expect(start).toContain(
      'if (!autoSize || running || spinning || freeMode || recovery) return;'
    );
  });

  it('the primary plate stays the single welcome spin, never an auto run', () => {
    expect(WHEEL).toContain('autoSize && !freeMode && !recovery');
  });

  it('and the Prizes plate is what the welcome spin keeps in the run plate seat', () => {
    // Nothing is lost on the one screen where a run is meaningless.
    const sec = WHEEL.slice(
      WHEEL.indexOf('        secondary={'),
      WHEEL.indexOf('        primary={')
    );
    expect(sec).toContain('freeMode');
    expect(sec).toContain("label: 'Prizes'");
  });
});

describe('the wheel turns before the spin is counted', () => {
  it('busy covers the landing animation, not just the request', () => {
    expect(WHEEL).toContain('busy: spinning || pending !== null');
  });

  it('the count moves on landing, where the result finally belongs to the player', () => {
    const landed = WHEEL.slice(WHEEL.indexOf('const handleLanded'));
    const block = landed.slice(0, landed.indexOf('const handleVerify'));
    // Moved 2026-09-21 (R18): the landing tallies the spin, which is the count
    // plus the prize or game it won. tallyWheelRun is exercised in
    // tests/unit/autoRun.test.ts; this pins where it is called.
    expect(block).toContain('setAutoRun((r) => (r ? tallyWheelRun(r, result, prizeLabel) : r));');
    expect(block).not.toContain('done: r.done + 1');
  });

  it('the wheel pause remains shorter than Crash', () => {
    expect(WHEEL).toContain('const AUTO_PAUSE_MS = 1200;');
    expect(CRASH).toContain('const AUTO_PAUSE_MS = 1500;');
  });
});
