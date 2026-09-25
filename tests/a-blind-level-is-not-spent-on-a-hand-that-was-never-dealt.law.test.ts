/**
 * LAW: a blind level is not spent on a hand that was never dealt.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A blind level is a wall-clock deadline a PLAYER loses to, and CLAUDE.md
 * section 13 invariant 4 is explicit that such a deadline is thawed, never
 * burned. `advanceBlindLevel` had carried that rule twice for years - a level
 * that comes due during a BREAK is owed rather than spent, and so is one that
 * comes due inside the MAINTENANCE FREEZE - and it is the same rule both
 * times: the field could not play, so the level was not played.
 *
 * It did not carry the rule for the third way a field cannot play: the
 * tournament's own tables stop dealing. The level clock is a local setTimeout
 * chain and keeps its own time perfectly well while every table under it is
 * dead, so the blinds climb against stacks that cannot act.
 *
 * Measured on production 2026-09-23, on an engine that had been unable to
 * restart since 2026-09-18. Twelve RUNNING events had run their clock on past
 * their own last dealt hand:
 *
 *   Evening Mystery Bounty (PLO5) 95a31bb1 - last hand 09-22 13:28:45 at
 *     2,000/4,000 with two players holding 30,000 apiece (7.5 big blinds).
 *     The clock ran on unattended and left them at 500,000/1,000,000 with a
 *     150,000 ante: 0.03 big blinds each, less than a quarter of one ante.
 *   $100 Freeroll 12:00 AM 37f7d04b - 111 hours of unattended levels, level 9
 *     to 141, 30 big blinds average down to 2.86.
 *   $100 Freeroll 6:00 AM 6915596c - 12.83 big blinds down to 0.16.
 *   Breakfast Turbo 019b6263 - 5.80 down to 0.15.
 *
 * Resuming any of those is not the game those players were playing: the first
 * hand posts every chip they own before a card is read, and the finishing
 * order is decided by our outage rather than by poker.
 *
 * THE FIX THIS PINS is the guard itself, not a detector and not a repair
 * (CLAUDE.md 10.11, 10.12). If your change turns this red you are
 * re-shipping the stack annihilation above.
 *
 * WHY THIS READS SOURCE. TournamentManagerBase is the engine's tournament
 * god-object; constructing one in the client vitest project would pull the
 * whole server runtime in. What has to survive is small and exact, so it is
 * asserted exactly - and COMMENTS ARE STRIPPED BEFORE EVERY MATCH, because a
 * law that can be satisfied by the prose describing it is not a law (this
 * repo has lost hours to that four times this week).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MANAGER = join(ROOT, 'server', 'src', 'tournament', 'TournamentManagerBase.ts');

/** Block and line comments removed, so nothing below can match documentation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Just the stalled-level guard's own `if` block, ending at its closing brace.
 * A fixed character window reached into the `blindClockNeedsThawResync`
 * branch below, which legitimately queries Supabase - and a test that fails
 * on its neighbour's correct code teaches the next agent to weaken it.
 */
function stalledGuardBlock(code: string): string {
  const body = code.slice(code.indexOf('protected async advanceBlindLevel('));
  const start = body.indexOf('this.lastObservedHandCompletedAtMs < this.blindTimerStartedAt');
  expect(start, 'the stalled-level guard must exist in advanceBlindLevel').toBeGreaterThan(-1);
  const end = body.indexOf('\n      }', start);
  expect(end, 'the guard must be a closed block').toBeGreaterThan(start);
  return body.slice(start, end);
}

describe('a blind level is not spent on a hand that was never dealt', () => {
  const source = readFileSync(MANAGER, 'utf8');
  const code = codeOnly(source);

  it('the manager records every completed hand as the blind clock witness', () => {
    // The assignment lives in the onHandComplete callback that already fires
    // on every hand. It must NOT be moved inside the zero-stack branch: a
    // level is spent by play, and most hands eliminate nobody.
    expect(code).toMatch(/lastObservedHandCompletedAtMs\s*=\s*Date\.now\(\)/);
    const callback = code.slice(code.indexOf('engine.onHandComplete('));
    const assignment = callback.indexOf('lastObservedHandCompletedAtMs = Date.now()');
    const zeroStackBranch = callback.indexOf('finalStacks.some');
    expect(assignment, 'the witness assignment must be in onHandComplete').toBeGreaterThan(-1);
    expect(
      assignment < zeroStackBranch,
      'the witness must be recorded for EVERY hand, before the zero-stack gate'
    ).toBe(true);
  });

  it('the witness starts at zero, so an adopted manager cannot inherit a clean one', () => {
    // Seeding to Date.now() is the trap one level up (CLAUDE.md 10.86 rule 4):
    // a replacement manager adopting a stalled event would find its overdue
    // level due at once and spend it on a table that has still dealt nothing.
    expect(code).toMatch(/lastObservedHandCompletedAtMs\s*=\s*0\s*;/);
    expect(code).not.toMatch(/lastObservedHandCompletedAtMs\s*:\s*number\s*=\s*Date\.now\(\)/);
  });

  it('advanceBlindLevel refuses to spend a level with no hand dealt since it began', () => {
    const body = code.slice(code.indexOf('protected async advanceBlindLevel('));
    expect(body).toMatch(
      /if\s*\(\s*this\.lastObservedHandCompletedAtMs\s*<\s*this\.blindTimerStartedAt\s*\)/
    );
  });

  it('the refusal owes the level rather than dropping it, and asks again', () => {
    const block = stalledGuardBlock(code);
    // Same shape as the two guards beside it: a deferred local wake, so the
    // level goes up the instant this tournament deals again. Never a silent
    // return that leaves the clock unarmed, and never a database write.
    expect(block).toMatch(/deferredWakeMs\s*=\s*TournamentManagerBase\.STALLED_LEVEL_RECHECK_MS/);
    expect(block).toMatch(/return;/);
    expect(block).not.toMatch(/supabase/);
  });

  it('it sits with the break and maintenance guards, after both', () => {
    const body = code.slice(code.indexOf('protected async advanceBlindLevel('));
    const breakGuard = body.indexOf('if (this.isOnBreak())');
    const frozenGuard = body.indexOf('if (isMaintenanceFrozen())');
    const stallGuard = body.indexOf(
      'this.lastObservedHandCompletedAtMs < this.blindTimerStartedAt'
    );
    expect(breakGuard, 'the break guard must still exist').toBeGreaterThan(-1);
    expect(frozenGuard, 'the maintenance-freeze guard must still exist').toBeGreaterThan(-1);
    expect(
      stallGuard > frozenGuard && stallGuard > breakGuard,
      'a break and the platform freeze are decided first; this is the third case'
    ).toBe(true);
  });

  it('the recheck interval is a bounded local wake, not a per-second one', () => {
    const match = code.match(/STALLED_LEVEL_RECHECK_MS\s*=\s*([^;]+);/);
    expect(match, 'STALLED_LEVEL_RECHECK_MS must be declared').not.toBeNull();
     
    const ms = Number(eval(match![1]));
    expect(Number.isFinite(ms)).toBe(true);
    // A multi-day stall must not become a per-second wake, and a resumed
    // tournament must not wait long for its owed level.
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('a held level is announced once, so a hold that never ends has a reader', () => {
    // CLAUDE.md 10.83: a guard nobody can see is not a guard. A tournament
    // whose blinds simply stopped must be a line somebody can read.
    const block = stalledGuardBlock(code);
    expect(block).toMatch(/console\.log\(/);
    expect(block).toMatch(/stalledLevelHoldAnnouncedFor/);
  });
});
