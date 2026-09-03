/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SPIN THAT IS OVER MUST END (round 18, 2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found by sweeping production, not by reading code. Every RUNNING spin on
 * the live board older than five minutes was stuck — nine of nine:
 *
 *     live stacks <= 1 on all nine        (a winner IS determinable)
 *     no hand dealt for 17 to 450 minutes
 *     1,093 chips of prize_pool unpaid
 *     average 147 minutes stuck, worst 7.7 hours
 *
 * A healthy spin never appears in that query — it finishes in minutes — so
 * the shape had zero false positives across the entire live board.
 *
 * THE CAUSE. Players LEAVE the felt (`table_seats.left_at` is set) while
 * `tournament_players.status` stays `playing`. The engine counts someone who
 * is gone as still in the game, waits for an action that is never coming, and
 * never reaches the "one player left" that finishes it. The chips sit on the
 * table and the prize sits unpaid.
 *
 * WHY THE EXISTING SWEEP MISSED IT. There is one, and it is startup-only with
 * a TWELVE HOUR threshold. Twelve hours is a fair floor for an MTT and
 * meaningless for a format built to last minutes.
 *
 * These pins hold the three conditions. Each is deliberately wide of a
 * healthy game, and it is their CONJUNCTION that makes the detector safe —
 * any one alone would be a guess.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinRevealToDealMs } from '../config/spinSpec.js';

const here = new URL('.', import.meta.url).pathname;
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');
/** Executable code only — never let a pin pass on the prose above it. */
const CODE = SERVER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** From `anchor` through the balanced block that follows it. */
function blockAfter(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`blockAfter: "${anchor}" not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const SWEEP = blockAfter(CODE, 'private async finishSeatFirstGamesThatAreOver(');

describe('all three conditions must hold', () => {
  it('the game is old enough that a start cannot be in progress', () => {
    expect(SWEEP).toContain('const STUCK_MIN_AGE_MS = 5 * 60 * 1000;');
    expect(SWEEP).toMatch(/\.lt\('started_at', new Date\(now - STUCK_MIN_AGE_MS\)/);
  });

  it('nothing has been dealt for minutes', () => {
    expect(SWEEP).toContain('const STUCK_NO_HAND_MS = 3 * 60 * 1000;');
    expect(SWEEP).toMatch(/if \(recentHand && recentHand\.length > 0\) continue;/);
  });

  it('at most one seat still holds chips', () => {
    expect(SWEEP).toContain(".is('left_at', null)");
    expect(SWEEP).toContain(".gt('stack', 0)");
    expect(SWEEP).toMatch(/if \(liveStacks > 1\) continue;/);
  });

  it('the age threshold clears the reveal hold by a wide margin', () => {
    /* If this ever inverted, the sweep could fire on a game that is still
       showing its wheel. Five minutes against a 16.6s hold. */
    expect(5 * 60 * 1000).toBeGreaterThan(spinRevealToDealMs() * 10);
  });
});

describe('it settles, and never cancels', () => {
  it('claims the row with a CAS so a live engine always wins', () => {
    expect(SWEEP).toMatch(/\.update\(\{ status: 'COMPLETING' \}\)/);
    expect(SWEEP).toMatch(/\.eq\('status', 'RUNNING'\)/);
    expect(SWEEP).toMatch(/if \(!claim \|\| claim\.length === 0\) continue;/);
  });

  it('hands off to the recovery that ranks by chips and pays the places', () => {
    expect(SWEEP).toContain("recoverStuckCompletingTournaments('seat-first-finish-sweep', id)");
  });

  it('never writes CANCELLED - tournaments run, they do not cancel', () => {
    expect(SWEEP).not.toMatch(/CANCELLED/);
  });
});

describe('it is scoped and bounded', () => {
  it('only seat-first games: spins, and heads-up SNGs', () => {
    expect(SWEEP).toMatch(/\.in\('variant', \['spin', 'sng'\]\)/);
    expect(SWEEP).toMatch(
      /t\.variant === 'spin' \|\| \(t\.variant === 'sng' && Number\(t\.max_players\) <= 2\)/
    );
  });

  it('runs once a minute, not on every discovery pass', () => {
    expect(CODE).toContain('private lastSeatFirstFinishSweepAt = 0;');
    expect(CODE).toMatch(/Date\.now\(\) - this\.lastSeatFirstFinishSweepAt > 60 \* 1000/);
  });

  it('every read is error-bound, and a failure reports rather than settling blind', () => {
    for (const bound of ['runningErr', 'tablesErr', 'handErr', 'seatsErr', 'claimErr']) {
      expect(SWEEP, `${bound} must be bound`).toContain(bound);
    }
    expect(SWEEP).toContain('GameServer.seat_first_finish_sweep_failed');
  });
});
