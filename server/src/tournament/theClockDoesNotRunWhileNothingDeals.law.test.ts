/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLOCK DOES NOT RUN WHILE NOTHING DEALS (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `advanceBlindLevel` has held a level that came due with no hand dealt since
 * it began since 2026-09-23. That guard covers the level clock while a manager
 * is alive. It cannot cover the moment the clock is REARMED, and that is where
 * the 2026-09-22 recovery did its damage.
 *
 * resume() armed the timer from the persisted `tournaments.level_started_at`
 * under the rule "a persisted overdue level stays due, including after a long
 * outage", flooring the remainder at one second. After the 2026-09-18/19
 * lease-loss wave froze ~470 events for four days, every one of them resumed
 * with a level that was due immediately: measured medians of level 182 on
 * frozen Spins and 1,348 on one of them, and at 13:24 on 2026-09-22
 * twenty-two recovered multi-table events escalated straight past the end of
 * their structures - `Auto-escalated blinds (level 45, structure has 40):
 * 5000000/10000000 ante 4000000` on a $100 Freeroll whose players held
 * 3,000-15,000 chips.
 *
 * Measured again on 2026-09-27 while writing this: 126 of 441 RUNNING events
 * had a `level_started_at` later than their own last dealt hand, and DSS
 * Thursday bfcfaf17 sat at level 476 on a 24-row structure having dealt
 * nothing since 2026-09-18 05:17.
 *
 * These pins are the law: an ordinary restart still resumes mid-level
 * (TOURNEY-AUDIT 2026-07-24, which this must not undo), and an outage resumes
 * at the level play stopped at with a fresh full level.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import {
  LEVEL_OUTAGE_FLOOR_MS,
  levelResumeIsAfterAnOutage,
  levelResumeRemainingMs,
} from './levelClockOutage.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-22T13:24:00.000Z');

/** A ten-minute MTT level, the shape every $100 Freeroll in the incident ran. */
const TEN_MINUTES = 10 * MINUTE;

describe('an ordinary restart still resumes the level mid-flight', () => {
  it('credits the time a dealing event actually spent in this level', () => {
    // Level began four minutes ago and the event dealt ten seconds ago.
    const remaining = levelResumeRemainingMs({
      levelStartedAtMs: NOW - 4 * MINUTE,
      lastDealtAtMs: NOW - 10_000,
      nowMs: NOW,
      durationMs: TEN_MINUTES,
      pausedMs: 0,
    });
    expect(remaining).toBe(6 * MINUTE);
  });

  it('still floors an overdue level at one second while the event is dealing', () => {
    // The 2026-07-24 behaviour: a restart-heavy window must not keep granting
    // fresh levels to an event that is playing, or escalation freezes.
    const remaining = levelResumeRemainingMs({
      levelStartedAtMs: NOW - 12 * MINUTE,
      lastDealtAtMs: NOW - 30_000,
      nowMs: NOW,
      durationMs: TEN_MINUTES,
      pausedMs: 0,
    });
    expect(remaining).toBe(1000);
  });

  it('excludes the break overlap the caller measured, as it always did', () => {
    const remaining = levelResumeRemainingMs({
      levelStartedAtMs: NOW - 8 * MINUTE,
      lastDealtAtMs: NOW - MINUTE,
      nowMs: NOW,
      durationMs: TEN_MINUTES,
      pausedMs: 5 * MINUTE,
    });
    // 8 minutes elapsed, 5 of them on a break: 3 spent, 7 left.
    expect(remaining).toBe(7 * MINUTE);
  });
});

describe('an event that dealt nothing resumes at a fresh full level', () => {
  it('credits nothing after the four-day freeze that caused the incident', () => {
    const fourDays = 4 * 24 * 60 * MINUTE;
    const reading = {
      levelStartedAtMs: NOW - fourDays,
      lastDealtAtMs: NOW - fourDays,
      nowMs: NOW,
      durationMs: TEN_MINUTES,
      pausedMs: 0,
    };
    expect(levelResumeIsAfterAnOutage(reading)).toBe(true);
    // undefined is startBlindTimer's own "no override": a fresh full level.
    expect(levelResumeRemainingMs(reading)).toBeUndefined();
  });

  it('is an outage even when the clock ran on past the last dealt hand', () => {
    // The live 2026-09-27 shape: the clock kept moving while nothing dealt, so
    // level_started_at is NEWER than the last hand. Neither anchor may credit.
    const reading = {
      levelStartedAtMs: NOW - 30 * MINUTE,
      lastDealtAtMs: NOW - 9 * 24 * 60 * MINUTE,
      nowMs: NOW,
      durationMs: TEN_MINUTES,
      pausedMs: 0,
    };
    expect(levelResumeIsAfterAnOutage(reading)).toBe(true);
    expect(levelResumeRemainingMs(reading)).toBeUndefined();
  });

  it('treats an event that never dealt a hand the same way', () => {
    const reading = {
      levelStartedAtMs: NOW - 2 * 60 * MINUTE,
      lastDealtAtMs: null,
      nowMs: NOW,
      durationMs: TEN_MINUTES,
      pausedMs: 0,
    };
    expect(levelResumeIsAfterAnOutage(reading)).toBe(true);
    expect(levelResumeRemainingMs(reading)).toBeUndefined();
  });

  it('never calls a short quiet spell an outage, whatever the level length', () => {
    // A one-minute Spin level with a hand ninety seconds ago is a slow hand,
    // not a freeze: the floor, not the duration, decides.
    const reading = {
      levelStartedAtMs: NOW - 3 * MINUTE,
      lastDealtAtMs: NOW - 90_000,
      nowMs: NOW,
      durationMs: MINUTE,
      pausedMs: 0,
    };
    expect(LEVEL_OUTAGE_FLOOR_MS).toBeGreaterThan(90_000);
    expect(levelResumeIsAfterAnOutage(reading)).toBe(false);
    expect(levelResumeRemainingMs(reading)).toBe(1000);
  });

  it('a break is not an outage, however long it keeps the field off the felt', () => {
    // The CA-03-09 restart shape: a 10-minute level with 30 s left, restarted
    // two minutes into the :55 break. The raw gap is 690,000 ms and the level
    // is nominally overdue, but every second past 12:55 was a break the
    // caller already measured. Crediting a fresh level here is precisely the
    // 2026-07-24 defect - a restart-heavy window that never escalates.
    const levelStartedAtMs = Date.parse('2026-09-11T12:45:30.000Z');
    const nowMs = Date.parse('2026-09-11T12:57:00.000Z');
    const reading = {
      levelStartedAtMs,
      lastDealtAtMs: null,
      nowMs,
      durationMs: TEN_MINUTES,
      pausedMs: 2 * MINUTE,
    };
    expect(nowMs - levelStartedAtMs).toBe(690_000);
    expect(levelResumeIsAfterAnOutage(reading)).toBe(false);
    expect(levelResumeRemainingMs(reading)).toBe(30_000);
  });

  it('a break that ran longer than the level is still not an outage', () => {
    expect(
      levelResumeIsAfterAnOutage({
        levelStartedAtMs: NOW - 40 * MINUTE,
        lastDealtAtMs: null,
        nowMs: NOW,
        durationMs: TEN_MINUTES,
        pausedMs: 39 * MINUTE,
      })
    ).toBe(false);
  });

  it('a clock that has not moved yet is not an outage', () => {
    expect(
      levelResumeIsAfterAnOutage({
        levelStartedAtMs: NOW,
        lastDealtAtMs: NOW,
        nowMs: NOW,
        durationMs: TEN_MINUTES,
        pausedMs: 0,
      })
    ).toBe(false);
  });

  it('an unreadable anchor grants a fresh level rather than inventing elapsed time', () => {
    expect(
      levelResumeRemainingMs({
        levelStartedAtMs: Number.NaN,
        lastDealtAtMs: NOW,
        nowMs: NOW,
        durationMs: TEN_MINUTES,
        pausedMs: 0,
      })
    ).toBeUndefined();
  });
});

describe('the resumed clock is wired to this law, not to the wall clock', () => {
  const MANAGER = readFileSync(resolve(import.meta.dirname, 'TournamentManagerBase.ts'), 'utf8');
  const WITNESS = sliceMethod(MANAGER, 'protected async seedDealingWitnessFromRows(');

  it('resume() decides the remainder through levelResumeRemainingMs', () => {
    expect(MANAGER).toContain("from './levelClockOutage.js'");
    expect(MANAGER).toContain('remainingMs = levelResumeRemainingMs({');
    // The exact line the incident was written by is gone for good.
    expect(MANAGER).not.toContain('remainingMs = Math.max(1000, durationMs - elapsed);');
  });

  it('the witness the clock reads is fetched from rows, high-water only', () => {
    // A brand-new manager knows nothing about when its event last dealt, and
    // a frozen event can never tell it by dealing.
    expect(MANAGER).toContain('await this.seedDealingWitnessFromRows();');
    expect(WITNESS).toContain("from('hand_history')");
    // A slower read never un-sees a hand this manager already watched land.
    expect(WITNESS).toContain('dealtAt > this.lastObservedHandCompletedAtMs');
  });

  it('only an already-overdue level pays for that read', () => {
    // A level still inside its own duration cannot be an outage under this
    // law, so the ordinary mid-level restart must cost the adoption nothing.
    expect(MANAGER).toContain(
      'if (Date.now() - levelStartedAt - pausedMs >= durationMs) {\n            await this.seedDealingWitnessFromRows();'
    );
  });

  it('the witness is a read, not a sweep or a repair job', () => {
    expect(WITNESS).not.toContain('setInterval');
    expect(WITNESS).not.toMatch(/fn_[a-z0-9_]*(?:repair|sweep|healer|backfill)/i);
    // It never writes anything, anywhere.
    expect(WITNESS).not.toContain('.update(');
    expect(WITNESS).not.toContain('.insert(');
  });
});
