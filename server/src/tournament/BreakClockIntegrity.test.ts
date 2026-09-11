/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BREAK MUST START, END, AND STOP THE CLOCK (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five defects found auditing TournamentManagerBase / TournamentManager line by
 * line. LevelClockAcrossBreaks.test.ts already pins the pause/resume PAIR; this
 * file pins the paths that reach that pair from outside it, which is where all
 * five lived.
 *
 * 1. A LEVEL COULD ADVANCE DURING A BREAK, AND TWICE. Nothing in
 *    advanceBlindLevel ever looked at `onBreak`. The only thing stopping the
 *    level clock was pauseForBreak clearing `blindTimer` — which covers a timer
 *    already armed, and not one armed afterwards. The tail of advanceBlindLevel
 *    armed one unconditionally, and suspendLevelClock's own comment records the
 *    window: `blindTimer is legitimately null for seconds at a time` while a
 *    transition awaits its table writes, its level persist and its broadcast.
 *    A break is 5 minutes plus up to 2 minutes of last-hand grace; every turbo,
 *    hyper-turbo and Spin level is shorter than that, so the armed timer fired
 *    mid-break, the blinds jumped behind the break overlay, and another timer
 *    was armed on top.
 *
 * 2. A RESTART BETWEEN :55 AND THE COUNTDOWN LOST THE BREAK ENTIRELY. resume()
 *    required `break_ends_at` to be non-null before re-entering a break, and
 *    pauseForBreak writes it as NULL on purpose. Inside that window a restart
 *    left `onBreak` false against a row saying true: tables were never
 *    re-paused (the tournament dealt through its own break),
 *    reviveDeadTableEngines lost its onBreak skip, and resumeFromBreak
 *    early-returns on !onBreak so `on_break` was never cleared again.
 *
 * 3. A TOURNAMENT THAT ENDED ON A BREAK NEVER CAME OFF IT. resumeFromBreak's
 *    guard was `if (!this.running || !this.onBreak) return` — running is false
 *    after stop(), so the persisted flags were skipped.
 *
 *    Measured 2026-08-25 against production: 7 tournaments carry
 *    `on_break = true` with no live break, 5 of them with `break_ends_at` NULL.
 *    Daily Freeroll, Sunday Freeroll Special, Sunday Kickoff and Blitz Bounty
 *    were all stamped inside 2026-08-23 14:55:00-14:56:39 and were still true
 *    41 hours later; the oldest dates to 2026-08-22 09:55.
 *
 * 4. beginBreakCountdown COULD EXTEND A LIVE BREAK. GameServer calls it once
 *    per break and again from holdIfBreakIsRunning for any tournament that
 *    starts mid-break. pauseForBreak defends itself with `if (this.onBreak)
 *    return`; this had no guard, so a second call re-stamped break_ends_at
 *    further out than the end time players had already been shown.
 *
 * 5. A SEAT COULD BE WRITTEN PAST THE TABLE'S OWN CAPACITY. Covered by the
 *    seating guards in TournamentFixes.guard.test.ts, which this file leaves
 *    alone.
 *
 * Source guards, for the same reason the two sibling files give: these classes
 * reach Supabase in almost every method, and the invariants below are the exact
 * lines whose absence caused each defect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sliceBetween } from '../testHelpers/sourceWindow.js';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const BASE = strip(read('src/tournament/TournamentManagerBase.ts'));
const GAME_SERVER = strip(read('src/GameServer.ts'));

/** Body of a named method, from its signature to its matching close brace. */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const from = src.slice(start);
  const open = from.indexOf('{');
  let depth = 0;
  for (let i = open; i < from.length; i++) {
    if (from[i] === '{') depth++;
    else if (from[i] === '}') {
      depth--;
      if (depth === 0) return from.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${signature}`);
}

describe('DEFECT 1 - the level clock neither ticks nor advances during a break', () => {
  const advance = methodBody(BASE, 'protected async advanceBlindLevel(');

  it('refuses to advance a level while the tournament is on break', () => {
    // The guard must sit BEFORE the increment, or the level is already gone.
    const guardAt = advance.indexOf('if (this.isOnBreak())');
    const bumpAt = advance.indexOf('this.currentLevel++');
    expect(guardAt, 'advanceBlindLevel must check isOnBreak()').toBeGreaterThan(-1);
    expect(bumpAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(bumpAt);
  });

  it('owes the level to the resume rather than dropping it', () => {
    // A level that came due during the break is not lost: resumeFromBreak arms
    // the saved remaining, and startBlindTimer clamps it to at least 1000ms.
    const guard = advance.slice(advance.indexOf('if (this.isOnBreak())'));
    const body = guard.slice(0, guard.indexOf('return;') + 'return;'.length);
    expect(body).toMatch(/this\.savedBlindTimerRemaining\s*=\s*1000/);
  });

  it('does not arm a live level timer when a break began mid-transition', () => {
    // The tail used to be a bare `this.startBlindTimer(blindStructure);`.
    const tail = advance.slice(advance.lastIndexOf('if (this.isOnBreak())'));
    const breakBranch = methodBody(tail, 'if (this.isOnBreak())');
    expect(breakBranch).toMatch(/this\.savedBlindTimerRemaining\s*=\s*this\.levelDurationMs\(/);
    expect(breakBranch).not.toContain('this.startBlindTimer(');
    const liveBranch = methodBody(tail, 'else');
    expect(liveBranch).toMatch(
      /this\.startBlindTimer\(\s*blindStructure,\s*this\.levelDurationMs\(level\)\s*-\s*\(Date\.now\(\)\s*-\s*levelStartedAt\)\s*\);/
    );
  });
});

describe('DEFECT 2 - a break with no end time yet is still a break', () => {
  it('resume() reacts to on_break without requiring break_ends_at', () => {
    expect(BASE).not.toMatch(/tournament\.on_break\s*&&\s*tournament\.break_ends_at/);
    expect(BASE).toMatch(/if\s*\(tournament\.on_break\)\s*\{/);
  });

  it('reconstructs the end time from break_started_at plus grace plus break', () => {
    const at = BASE.indexOf('if (tournament.on_break)');
    const block = sliceBetween(
      BASE,
      'const breakStartedAt = tournament.break_started_at',
      'this.startEliminationChecker();'
    );
    expect(block).toMatch(/break_started_at/);
    expect(block).toMatch(/LAST_HAND_GRACE_MS/);
    expect(block).toMatch(/BREAK_DURATION_MS/);
  });

  it('mirrors GameServer.BREAK_DURATION_MS exactly', () => {
    /**
     * A value import would close a module cycle (GameServer imports
     * TournamentManager; this file's GameServer import is type-only), so the
     * constant is mirrored. This is the guard that keeps the mirror honest —
     * a break length that disagrees between the two would make every
     * reconstructed resume either cut a break short or overrun it.
     */
    const ours = /BREAK_DURATION_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/.exec(BASE);
    const theirs = /BREAK_DURATION_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/.exec(GAME_SERVER);
    expect(ours, 'TournamentManagerBase.BREAK_DURATION_MS not found').not.toBeNull();
    expect(theirs, 'GameServer.BREAK_DURATION_MS not found').not.toBeNull();
    const ms = (m: RegExpExecArray) => Number(m[1]) * Number(m[2]) * Number(m[3]);
    expect(ms(ours!)).toBe(ms(theirs!));
    expect(ms(ours!)).toBe(5 * 60 * 1000);
  });
});

describe('DEFECT 3 - a tournament that ends on a break still comes off it', () => {
  const resume = methodBody(BASE, 'async resumeFromBreak()');

  it('does not skip the persisted clear when the tournament has stopped', () => {
    expect(resume).not.toMatch(/if\s*\(\s*!this\.running\s*\|\|\s*!this\.onBreak\s*\)\s*return/);
    // The clear happens BEFORE the running check, so stop() cannot strand it.
    const clearAt = resume.indexOf('clearPersistedBreak');
    const runAt = resume.indexOf('if (!this.running) return;');
    expect(clearAt, 'resumeFromBreak must clear the persisted break').toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(runAt);
  });

  it('still clears both columns', () => {
    const clear = methodBody(BASE, 'protected async clearPersistedBreak()');
    expect(clear).toMatch(/on_break:\s*false/);
    expect(clear).toMatch(/break_ends_at:\s*null/);
  });
});

describe('DEFECT 4 - a break countdown is started once, never restarted', () => {
  const countdown = methodBody(BASE, 'async beginBreakCountdown(');
  const pause = methodBody(BASE, 'async pauseForBreak(');

  it('refuses a second countdown for the same break', () => {
    expect(countdown).toMatch(/if\s*\(this\.breakCountdownStarted\)\s*return;/);
    expect(countdown).toMatch(/this\.breakCountdownStarted\s*=\s*true/);
    // The refusal must precede the write, or the extension still lands.
    expect(countdown.indexOf('breakCountdownStarted')).toBeLessThan(
      countdown.indexOf('break_ends_at')
    );
  });

  it('re-opens the door for the NEXT break', () => {
    expect(pause).toMatch(/this\.breakCountdownStarted\s*=\s*false/);
    expect(methodBody(BASE, 'async resumeFromBreak()')).toMatch(
      /this\.breakCountdownStarted\s*=\s*false/
    );
  });
});
