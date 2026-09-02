/**
 * The V23 raise-response plan must never cross tables.
 *
 * `pendingRaisePlan` is MODULE-level state in HorseLogic, and one engine
 * process drives every table. Dan asked for horses to play up to four games at
 * once (2026-09-02), which multiplies how often two decisions interleave, so
 * the question "can one table consume another table's plan?" stops being
 * theoretical.
 *
 * IT CANNOT, and this test pins the two independent reasons why. Neither is
 * obvious from reading the variable, and either one being edited away would
 * reintroduce the leak silently - the plan would simply be recorded against
 * the wrong hand, which no assertion anywhere else would notice.
 *
 *   1. DOMINANCE. The assignment lives at the top level of decidePostflop's
 *      body, so every postflop path that puts a chip in has already re-set it.
 *      A stale plan from an earlier decision is overwritten before it can be
 *      read. If the assignment were ever moved inside a conditional, or a
 *      betSize/raiseTo call were added ABOVE it, that stops being true.
 *
 *   2. THE STAGE GUARD. Preflop also calls raiseTo (decidePreflop and
 *      decidePreflopV7Glue both do), and those paths never set the plan. They
 *      cannot consume one either, because both consume sites are guarded on
 *      `gs.stage !== 'preflop'` and decide() routes to the preflop branch on
 *      exactly `gs.stage === 'preflop'`. Drop the guard and a preflop raise at
 *      table B would record table A's leftover plan against B's hand.
 *
 * The in-code comment says module level is "safe for the same reason
 * difficultyHint is". That reason - set and consumed inside one call - is true
 * of difficultyHint and is NOT the reason this one is safe: this plan is set in
 * decidePostflop and consumed in a different method. It is safe for the two
 * structural reasons above instead, and they are what this test defends.
 *
 * Source assertions, deliberately: the property is structural (which code
 * dominates which), and a behavioural test would have to reproduce a precise
 * interleaving of two tables to catch a regression that a one-line edit can
 * introduce.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'HorseLogic.ts'), 'utf8');
const LINES = SRC.split('\n');

/** 1-based line of the first line matching `re`, or -1. */
function lineOf(re: RegExp, from = 0): number {
  for (let i = from; i < LINES.length; i++) if (re.test(LINES[i])) return i + 1;
  return -1;
}
/** Every 1-based line matching `re`. */
function linesOf(re: RegExp): number[] {
  const out: number[] = [];
  LINES.forEach((l, i) => {
    if (re.test(l)) out.push(i + 1);
  });
  return out;
}

const decidePostflopAt = lineOf(/^\s*private static decidePostflop\(/);
const betSizeDefAt = lineOf(/^\s*private static betSize\(/);
const assignAt = lineOf(/^\s*pendingRaisePlan = /);

describe('the V23 raise plan is per decision, not per process', () => {
  it('locates the pieces it is pinning', () => {
    expect(decidePostflopAt, 'decidePostflop not found').toBeGreaterThan(0);
    expect(betSizeDefAt, 'betSize definition not found').toBeGreaterThan(0);
    expect(assignAt, 'pendingRaisePlan assignment not found').toBeGreaterThan(0);
  });

  it('assigns the plan at the top level of decidePostflop, not inside a branch', () => {
    // decidePostflop's body sits at 4 spaces; anything deeper is conditional.
    const indent = LINES[assignAt - 1].match(/^ */)![0].length;
    expect(
      indent,
      'the assignment moved inside a conditional - a postflop path can now reach ' +
        "betSize with another decision's plan still set"
    ).toBe(4);
    expect(assignAt).toBeGreaterThan(decidePostflopAt);
    expect(assignAt).toBeLessThan(betSizeDefAt);
  });

  it('puts every postflop chip-in call AFTER the assignment', () => {
    // Calls inside decidePostflop only. Preflop's own raiseTo calls sit in
    // decidePreflop/decidePreflopV7Glue, above decidePostflop, and are covered
    // by the stage guard instead.
    const calls = linesOf(/this\.(betSize|raiseTo)\(/).filter(
      (n) => n > decidePostflopAt && n < betSizeDefAt
    );
    expect(
      calls.length,
      'no postflop chip-in calls found - test is not looking at the right code'
    ).toBeGreaterThan(0);
    const early = calls.filter((n) => n < assignAt);
    expect(
      early,
      'a postflop betSize/raiseTo call now runs BEFORE the plan is set, so it can ' +
        'consume a plan left behind by a different table'
    ).toEqual([]);
  });

  it('guards both consume sites on stage, so preflop can never consume a stale plan', () => {
    const consumes = linesOf(/if \(pendingRaisePlan && gs\.stage !== 'preflop'\)/);
    expect(
      consumes.length,
      'a consume site lost its stage guard, or there are more consume sites than expected'
    ).toBe(2);
    // Both live in the two sizing helpers, below decidePostflop.
    for (const n of consumes) expect(n).toBeGreaterThan(betSizeDefAt - 1);
  });

  it('routes preflop by stage, which is what makes the guard sufficient', () => {
    expect(SRC).toMatch(/if \(gs\.stage === 'preflop'\) \{/);
  });

  it('clears the plan when it consumes it, so it cannot be recorded twice', () => {
    const consumes = linesOf(/if \(pendingRaisePlan && gs\.stage !== 'preflop'\)/);
    for (const n of consumes) {
      const block = LINES.slice(n - 1, n + 10).join('\n');
      expect(block, 'a consume site no longer nulls the plan').toContain(
        'pendingRaisePlan = null;'
      );
    }
  });
});
