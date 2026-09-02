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
import { sliceBlockAfter } from '../testHelpers/sourceWindow.js';

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
  const resume = methodBody(BASE, 'async resumeFromBreak()');
  const pause = methodBody(BASE, 'async pauseForBreak(');

  it('DEFECT 1 - resumeFromBreak always re-arms a level timer, even with nothing saved', () => {
    // The old code was `if (this.savedBlindTimerRemaining > 0) { ...arm... }`
    // with no else, so a zero left the tournament with no clock at all.
    expect(resume).not.toMatch(
      /if\s*\(\s*this\.savedBlindTimerRemaining\s*>\s*0\s*\)\s*\{[^}]*setTimeout/
    );
    expect(resume).toMatch(/this\.startBlindTimer\(/);
  });

  it('DEFECT 2 - resumeFromBreak goes through startBlindTimer, not a hand-rolled setTimeout', () => {
    // startBlindTimer back-dates blindTimerStartedAt against the override so
    // the NEXT pauseForBreak measures the true remaining time.
    expect(resume).not.toMatch(/setTimeout\(/);
    // The saved remaining must reach startBlindTimer as its override argument,
    // whether passed directly or via a local captured before the reset below.
    expect(resume).toMatch(/this\.savedBlindTimerRemaining/);
    expect(resume).toMatch(/this\.startBlindTimer\([^)]+,[^)]+\)/);
  });

  it('DEFECT 3 - resumeFromBreak clears the saved remaining so it cannot be re-used', () => {
    expect(resume).toMatch(/this\.savedBlindTimerRemaining\s*=\s*0/);
  });

  it('DEFECT 1 (cause) - every entry into a break suspends the clock the same way', () => {
    // The measurement now lives in suspendLevelClock, shared by BOTH ways a
    // tournament enters a break: pauseForBreak (the :55 path) and resume()
    // restarting into a live break. They used to disagree — resume() left the
    // blind timer it had just armed running straight through the break, and
    // resumeFromBreak then handed out a fresh full level on top of that.
    expect(pause).toMatch(/this\.suspendLevelClock\(\)/);
    const suspend = methodBody(BASE, 'protected suspendLevelClock()');
    // Every path out of it must leave savedBlindTimerRemaining meaningful. The
    // old else-branch set it to 0, which resumeFromBreak read as "arm nothing".
    expect(suspend).not.toMatch(/else\s*\{\s*this\.savedBlindTimerRemaining\s*=\s*0;\s*\}/);
    expect(suspend).toMatch(/if\s*\(this\.blindTimer\)/);
    expect(suspend).toMatch(/else\s*\{/);
    expect(suspend).toMatch(/savedBlindTimerRemaining/);
  });

  it('DEFECT 6 - a restart INTO a live break suspends the level clock too', () => {
    // resume() arms the level timer, then discovers the tournament is on a
    // break. Without suspending, that timer ran for the whole break and
    // resumeFromBreak then granted a fresh full level on top.
    /**
     * UPDATED 2026-08-25. The anchor was the literal
     * `if (tournament.on_break && tournament.break_ends_at)`, and that second
     * condition was itself a defect: pauseForBreak writes break_ends_at as
     * NULL on purpose (at :55 only the LAST HAND is announced; the end time is
     * stamped up to LAST_HAND_GRACE_MS later, once every table has parked), so
     * a restart inside that window skipped the whole recovery — engines were
     * never re-paused, the level clock was never suspended, and resumeFromBreak
     * could never clear on_break again. The block is entered on `on_break`
     * ALONE now and reconstructs the end time when the row carries none.
     */
    expect(BASE).not.toMatch(/tournament\.on_break\s*&&\s*tournament\.break_ends_at/);
    const at = BASE.indexOf('if (tournament.on_break)');
    expect(at, 'resume() must react to on_break on its own').toBeGreaterThan(-1);
    const block = sliceBlockAfter(BASE, 'if (tournament.on_break)');
    expect(block).toMatch(/this\.suspendLevelClock\(\)/);
    // The missing end time is reconstructed from break_started_at, not treated
    // as "there is no break".
    expect(block).toMatch(/break_started_at/);
    expect(block).toMatch(/LAST_HAND_GRACE_MS/);
    expect(block).toMatch(/BREAK_DURATION_MS/);
  });
});

describe('levels advance past structure break rows without stalling', () => {
  const advance = methodBody(BASE, 'protected async advanceBlindLevel(');

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
    expect(advance).toMatch(/this\.currentLevel\s*>=\s*rebuyLevelCap/);
  });
});
