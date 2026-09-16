/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SCHEDULE CANNOT CREATE A GAME THAT HAS NO SCHEDULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-01, verbatim: "SPINS AND HEADS UP DO NOT HAVE SCHEDULED TIMES
 * THEY START WHEN 3 PLAYERS HAVE BOUGHT IN AND PAID FOR SPINS, AND WHEN TWO
 * PLAYERS FOR HEADS UP."
 *
 * The START decision already obeyed this and still does: GameServer gates a
 * seat-first game on paid seats and excludes it from the clock sweep. What did
 * not obey it was CREATION. ScheduledTournamentService could spawn a row typed
 * SPIN, or a two-seat SNG, with a cron-derived start_time -- and it never
 * creates the open-seat table the seat gate counts seats on. The live example
 * ran for ten days: "Spin Royale", every 30 minutes, 253 games, exactly one
 * human entry, every other seat filled by the past-start horse top-up the
 * moment the scheduled instant passed.
 *
 * Every pin below is that incident. None of them is a style preference.
 *
 * SCOPE. This file guards CREATION only. The START decision is already owned by
 * server/src/tournament/seatFirstStartsOnSeatsNotClocks.law.test.ts on
 * origin/main, and two law tests pinning one line of code is what the LAWS.md
 * registry exists to prevent - so the start-gate pins that were drafted here
 * were deleted rather than duplicated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const SERVER_SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SERVER_SRC, rel), 'utf8');

const SCHEDULED = read('services/ScheduledTournamentService.ts');
const SPIN_METRICS = read('services/SpinMetrics.ts');

describe('a schedule cannot produce a game that has no schedule', () => {
  it('buildInsertRow refuses a spin and a two-seat sng, before it builds anything', () => {
    const body = blankNonCode(sliceMethod(SCHEDULED, 'private async buildInsertRow('));
    expect(body).toContain('isHeadsUpShape');
    expect(body).toMatch(/if\s*\(\s*isSpin\s*\|\|\s*isHeadsUpShape\s*\)/);
    // The refusal must RETURN, not merely report. A row that is reported and
    // then inserted anyway is the same 253 games with a louder log.
    const refusal = body.slice(body.indexOf('isHeadsUpShape'));
    expect(refusal).toContain('return null');
  });

  it('names the format by its seat count, not by a label a config can lie about', () => {
    const body = sliceMethod(SCHEDULED, 'private async buildInsertRow(');
    expect(body).toContain('HEADS_UP_SEATS');
  });

  it('reports the refusal once per schedule rather than on every poll', () => {
    expect(blankNonCode(SCHEDULED)).toContain('refusedSeatFirstSchedules');
    const body = blankNonCode(sliceMethod(SCHEDULED, 'private async buildInsertRow('));
    expect(body).toContain('refusedSeatFirstSchedules.has');
    expect(body).toContain('refusedSeatFirstSchedules.add');
  });

  it('the restart clone refuses them too, for the same reason', () => {
    const body = blankNonCode(sliceMethod(SCHEDULED, 'private async maybeRestartTournament('));
    // ended_at + restart_every_minutes is a scheduled time by construction.
    expect(body).toContain('clonedVariant');
    expect(body).toContain('clonedSeats');
    expect(body).toContain('HEADS_UP_SEATS');
    // It must bail out, not merely notice.
    expect(body).toMatch(/if\s*\(\s*!isUnlimitedMtt\(old\)\s*&&[\s\S]{0,160}clonedVariant[\s\S]{0,120}\)\s*return;/);
  });
});

describe('a spin that never touched the reserve pool is counted', () => {
  it('SpinMetrics exposes the unbooked gauge', () => {
    expect(SPIN_METRICS).toContain('poker_spin_draw_unbooked');
    expect(SPIN_METRICS).toContain('unbookedSpins');
    expect(SPIN_METRICS).toContain('row.unbooked_spins');
  });

  it('the gauge is separate from booking_gaps, which cannot see it', () => {
    // Folding the two together would lose the distinction between "paid more
    // than it drew" and "never touched the pool" - different incidents, and
    // only the second means the backstop has stopped.
    expect(SPIN_METRICS).toContain('poker_spin_draw_booking_gaps');
    expect(SPIN_METRICS).toContain('poker_spin_draw_unbooked');
  });
});
