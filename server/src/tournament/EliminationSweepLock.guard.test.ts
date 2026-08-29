/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ELIMINATION SWEEP LOCK MUST ALWAYS BE RELEASABLE (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `isProcessingEliminations` is a re-entrancy lock around the 5-second sweep,
 * and until this commit it was taken with no bound on how long it could be
 * held. The `finally` that releases it looks like a guarantee and is not:
 * `finally` runs when the try block SETTLES, so an await that never settles
 * holds the lock for the life of the process.
 *
 * The cost of that is not a slow tournament, it is a dead one. Every later
 * tick returns at the first line, so nobody is eliminated, `remainingCount`
 * never falls to 1, `finishTournament` is unreachable, and the entire field's
 * prize money — the champion's included — is stranded. That is the same
 * outcome as the 2026-08-28 ladder deadlock (Union PKO Afternoon 4f42d847),
 * reached by a different road, and it was equally silent: 4f42d847 sat for
 * over an hour and was found by a player rather than by us.
 *
 * Two kinds of test, matching the house style in
 * PayoutIntegrity.mttFinish.test.ts.
 *
 * BEHAVIOURAL, against `eliminationLockVerdict`. The decision the watchdog
 * makes is a pure function of one number, so it is pinned exactly rather than
 * inferred.
 *
 * SOURCE GUARDS for the parts that live inside a setInterval full of supabase
 * round-trips and cannot be reached without one. Each names the defect it
 * prevents. If one of these mechanisms is deliberately replaced by a better
 * one, move the guard to the new mechanism IN THE SAME COMMIT and say so —
 * do not weaken it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  ELIMINATION_SWEEP_STUCK_MS,
  ELIMINATION_SWEEP_FORCE_RELEASE_MS,
  eliminationLockVerdict,
} from './eliminationLock.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const ELIM = read('src/tournament/TournamentManagerEliminations.ts');

/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const STUCK = ELIMINATION_SWEEP_STUCK_MS;
const FORCE = ELIMINATION_SWEEP_FORCE_RELEASE_MS;
const verdict = (ms: number) => eliminationLockVerdict(ms);

/** The sweep interval, restated here so this file imports nothing that touches
 *  the network. It is pinned against the manager by the guard below. */
const SWEEP_MS = 5000;

describe('eliminationLockVerdict', () => {
  it('leaves a working sweep alone', () => {
    // Most ticks of a busy tournament land here. A sweep on the biggest field
    // on the platform finishes well inside one interval.
    expect(verdict(0)).toBe('wait');
    expect(verdict(SWEEP_MS)).toBe('wait');
    expect(verdict(STUCK - 1)).toBe('wait');
  });

  it('complains before it acts', () => {
    // The gap between complaining and forcing is the point: complaining is
    // free, forcing carries a real risk, so a merely slow sweep gets four more
    // minutes to finish on its own.
    expect(verdict(STUCK)).toBe('warn');
    expect(verdict(FORCE - 1)).toBe('warn');
    expect(STUCK).toBeLessThan(FORCE);
  });

  it('takes the lock back rather than let the field hang', () => {
    expect(verdict(FORCE)).toBe('force');
    expect(verdict(FORCE * 100)).toBe('force');
  });

  it('never forces on evidence it does not have', () => {
    // A clock that moved backwards, or a start time never stamped, is not a
    // stalled sweep. Forcing on no evidence is how you get two live sweeps.
    expect(verdict(NaN)).toBe('wait');
    expect(verdict(Infinity)).toBe('wait');
    expect(verdict(-1)).toBe('wait');
    expect(verdict(-FORCE)).toBe('wait');
  });

  it('still agrees with the sweep interval it is sized against', () => {
    // SWEEP_MS is restated in this file so the test imports nothing that opens
    // a socket. If the manager's interval changes, this is what notices.
    expect(read('src/tournament/TournamentManagerBase.ts')).toMatch(
      new RegExp(`ELIMINATION_SWEEP_MS\\s*=\\s*${SWEEP_MS}`)
    );
  });

  it('is bounded in minutes, not hours', () => {
    // A threshold nobody would ever hit is the same as no threshold. These
    // numbers are deliberately small enough to fire on a real incident.
    expect(STUCK).toBeLessThanOrEqual(120_000);
    expect(FORCE).toBeLessThanOrEqual(600_000);
  });
});

describe('the sweep lock, in TournamentManagerEliminations', () => {
  it('inspects a held lock instead of simply obeying it', () => {
    // The original line was `if (!this.running || this.isProcessingEliminations) return;`
    // — one early return, no way out, no alert. That single line is the whole
    // bug: it makes a permanently held lock indistinguishable from a busy one.
    expect(code(ELIM)).not.toMatch(
      /if\s*\(\s*!this\.running\s*\|\|\s*this\.isProcessingEliminations\s*\)\s*return;/
    );
    expect(code(ELIM)).toMatch(/eliminationLockVerdict/);
  });

  it('stamps when the lock was taken, or the watchdog has nothing to measure', () => {
    expect(code(ELIM)).toMatch(/this\.eliminationSweepStartedAt\s*=\s*Date\.now\(\)/);
  });

  it('says so out loud when a sweep overruns', () => {
    // Silence is what made this expensive. A stalled sweep that nobody hears
    // about is found by a player, hours later.
    expect(code(ELIM)).toMatch(/elimination_sweep_overrunning/);
    expect(code(ELIM)).toMatch(/elimination_sweep_lock_forced/);
  });

  it('rate-limits that alert to one per episode, not one per tick', () => {
    // At a 5s interval an unlimited alert is 720 reports an hour for one
    // tournament, which is how a channel stops being read.
    expect(code(ELIM)).toMatch(
      /this\.eliminationSweepStuckReportedAt\s*<\s*this\.eliminationSweepStartedAt/
    );
  });

  it('only lets the CURRENT holder release the lock', () => {
    // A sweep declared stuck, superseded, and then finally settling must not
    // free a lock the live sweep is now holding — that would let a third sweep
    // start alongside the second. An unconditional release in `finally` is the
    // defect; the generation check is the fix.
    expect(code(ELIM)).toMatch(
      /if\s*\(\s*sweepGeneration\s*===\s*this\.eliminationSweepGeneration\s*\)\s*\{[\s\S]{0,200}?this\.isProcessingEliminations\s*=\s*false;/
    );
  });

  it('stands a superseded sweep down BEFORE it writes a finishing place', () => {
    // `takenPositions` is a snapshot. A resurrected sweep continuing from it
    // would hand out a place the live sweep may already have paid — and the
    // wallet idempotency key `tourney:{id}:prize:{user}:{place}` dedupes a
    // repeated USER, not a repeated PLACE, so nothing downstream catches it.
    // The check must sit inside the elimination loop and ahead of
    // eliminatePlayer, not merely somewhere in the file.
    const loop = code(ELIM).slice(
      code(ELIM).indexOf('for (let i = 0; i < bustedOrdered.length; i++)')
    );
    const standDown = loop.indexOf('sweepGeneration !== this.eliminationSweepGeneration');
    const write = loop.indexOf('await this.eliminatePlayer(');
    expect(standDown).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(standDown).toBeLessThan(write);
    expect(code(ELIM)).toMatch(/elimination_sweep_superseded/);
  });
});
