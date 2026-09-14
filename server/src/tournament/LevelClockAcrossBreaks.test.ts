/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LEVEL CLOCK MUST SURVIVE A BREAK (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "MAKE SURE ALL LEVELS GO UP AS THEY SHOULD."
 *
 * Three independent ways the blind clock died or drifted across the :55 break,
 * all of them in the pauseForBreak / resumeFromBreak pair:
 *
 * 1. DEAD CLOCK. pauseForBreak only wrote `savedBlindTimerRemaining` INSIDE
 *    `if (this.blindTimer)`. advanceBlindLevel consumes the timer on fire and
 *    does not re-arm it until it has awaited a table blind write per table, a
 *    level persist, a broadcast, and possibly a prize-pool finalization — a
 *    window of seconds in which `blindTimer` is null. A :55 break landing in
 *    that window left `savedBlindTimerRemaining` at its initial 0, and
 *    resumeFromBreak's `if (this.savedBlindTimerRemaining > 0)` then armed
 *    NOTHING. The tournament played out the rest of its life at one level.
 *
 * 2. DRIFTING CLOCK. resumeFromBreak hand-rolled its own setTimeout and set
 *    `blindTimerStartedAt = Date.now()` while the level's nominal duration
 *    stayed the FULL level. A second break in the same level therefore
 *    computed `remaining = fullDuration - timeSinceResume` instead of
 *    `remaining - timeSinceResume`, handing the level back every minute it had
 *    already played. startBlindTimer has always done this correctly, by
 *    back-dating blindTimerStartedAt against the override; resumeFromBreak
 *    simply did not use it.
 *
 * 3. STALE CARRY-OVER. `savedBlindTimerRemaining` was never cleared after a
 *    resume, so a later break that could not measure the clock re-used a value
 *    from a previous level.
 *
 * These are source guards rather than a live harness because TournamentManager
 * reaches Supabase throughout; the invariants below are the exact lines whose
 * absence caused each defect. Same technique, and same reason, as the sibling
 * levelDurationGuard.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const BASE = strip(
  readFileSync(path.join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8')
);

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

describe('the blind clock survives a synchronized break', () => {
  const resume = methodBody(BASE, 'private async commitOwnBreakResume()');
  const pause = methodBody(BASE, 'private async pauseForBreakOnce(');

  it('DEFECT 1 - resumeFromBreak always re-arms a level timer, even with nothing saved', () => {
    // The old code was `if (this.savedBlindTimerRemaining > 0) { ...arm... }`
    // with no else, so a zero left the tournament with no clock at all.
    expect(resume).not.toMatch(
      /if\s*\(\s*this\.savedBlindTimerRemaining\s*>\s*0\s*\)\s*\{[^}]*setTimeout/
    );
    expect(resume).toMatch(/this\.armBlindTimerFromAnchor\(/);
  });

  it('DEFECT 2 - resume persists one exact anchor then arms it without a second write', () => {
    // The atomic persisted anchor uses the saved remainder. The no-write armer
    // consumes response latency, so the next pause measures true remaining time.
    expect(resume).not.toMatch(/setTimeout\(/);
    // Both the durable state and timer use the same immutable resumed anchor.
    expect(resume).toMatch(/this\.savedBlindTimerRemaining/);
    expect(resume).toContain('this.clearPersistedBreak(anchor, true)');
    expect(resume).toContain(
      'this.armBlindTimerFromAnchor(blindStructure, anchor, this.tournamentClockNow())'
    );
    expect(resume.indexOf('this.clearPersistedBreak(anchor, true)')).toBeLessThan(
      resume.indexOf('this.armBlindTimerFromAnchor(')
    );
  });

  it('DEFECT 3 - resumeFromBreak clears the saved remaining so it cannot be re-used', () => {
    expect(resume).toMatch(/this\.savedBlindTimerRemaining\s*=\s*0/);
  });

  it('DEFECT 1 (cause) - beginning a live break always saves a usable clock', () => {
    // The live :55 path measures the running timer. Engine restart recovery
    // instead restores the persisted remainder without arming during a break.
    expect(pause).toMatch(/this\.suspendLevelClock\(\)/);
    const suspend = methodBody(BASE, 'protected suspendLevelClock()');
    // Every path out of it must leave savedBlindTimerRemaining meaningful. The
    // old else-branch set it to 0, which resumeFromBreak read as "arm nothing".
    expect(suspend).not.toMatch(/else\s*\{\s*this\.savedBlindTimerRemaining\s*=\s*0;\s*\}/);
    expect(suspend).toMatch(/if\s*\(this\.blindTimer\)/);
    expect(suspend).toMatch(/else\s*\{/);
    expect(suspend).toMatch(/savedBlindTimerRemaining/);
  });

  // Restart recovery is exercised against the production methods in
  // ResumeBlindClockBehavior.test.ts, including durable-anchor preservation.
});

describe('levels advance past structure break rows without stalling', () => {
  const advance = methodBody(BASE, 'private async advanceBlindLevelOnce(');

  it('DEFECT 4 - an isBreak row no longer early-returns before the level bookkeeping', () => {
    // Every default structure carries isBreak rows (hyperTurbo indices 7, 13,
    // 19, 25). The old branch was:
    //     if (level.isBreak) { this.startBlindTimer(blindStructure); return; }
    // which burned the row's five minutes with tables still dealing at the old
    // blinds, never persisted current_level (so the SQL late-reg gate read a
    // stale level for the whole window), and skipped the late-reg and add-on
    // checks entirely.
    expect(advance).not.toMatch(
      /if\s*\(\s*level\.isBreak\s*\)\s*\{\s*this\.startBlindTimer\([^)]*\);\s*return;/
    );
    // It must instead step PAST break rows and carry on with the transition.
    expect(advance).toMatch(/while\s*\([\s\S]{0,160}isBreak/);
  });

  it('DEFECT 5 - the add-on window opens on reaching the cutoff, not on crossing it', () => {
    // `prevLevel < cap && currentLevel >= cap` is an edge, and an edge is lost
    // by a restart (resume() restores currentLevel from the database already
    // past the cap) or by any transition that skipped the check. The add-on
    // then never opened for the life of the tournament. Idempotency is already
    // guaranteed by addOnPeriodTriggered.
    expect(advance).not.toMatch(/prevLevel\s*<\s*rebuyLevelCap\s*&&/);
    const persisted = advance.search(/\.update\(\{\s*current_level: this\.currentLevel\b/);
    const reconciled = advance.indexOf("reconcileTournamentEntryWindow('engine.level_change')");
    expect(persisted).toBeGreaterThan(-1);
    expect(reconciled).toBeGreaterThan(persisted);
  });
});
