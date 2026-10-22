import { describe, expect, it } from 'vitest';
import {
  classifySynchronizedBreakHold,
  SYNCHRONIZED_BREAK_MS,
} from '../e2e/support/tournamentBoardEnding';

/*
 * Post-deploy run 39694814807 (MTT table 0260b54a, tournament 9e0e38c2): the
 * last live event was pot_distributed at 23:54:27Z, the tournament persisted
 * break_started_at 23:55:00.001Z for the hourly synchronized break, and the
 * case failed at 45027ms of silence. The engine now resets once a day, so the
 * hourly platform freeze no longer masks this break.
 */
const BREAK_STARTED = '2026-10-21T23:55:00.001Z';
const STARTED_AT = Date.parse(BREAK_STARTED);
const SILENCE_STARTED_AT = Date.parse('2026-10-21T23:54:27.000Z');
const FAILED_AT = SILENCE_STARTED_AT + 45_027;
const MAX_SILENCE = 45_000;

describe('a persisted synchronized tournament break is an authoritative hold', () => {
  it('names the production failure as a hold inside the break', () => {
    const hold = classifySynchronizedBreakHold({
      breakStartedAt: BREAK_STARTED,
      breakEndsAt: null,
      silenceStartedAt: SILENCE_STARTED_AT,
      observedAt: FAILED_AT,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held).toBe(true);
    if (hold.held) {
      expect(hold.breakStartedAt).toBe(STARTED_AT);
      expect(hold.breakEndsAt).toBe(STARTED_AT + SYNCHRONIZED_BREAK_MS);
    }
  });

  it('uses the persisted end when one is recorded', () => {
    const ends = new Date(STARTED_AT + 6 * 60_000).toISOString();
    const hold = classifySynchronizedBreakHold({
      breakStartedAt: BREAK_STARTED,
      breakEndsAt: ends,
      silenceStartedAt: SILENCE_STARTED_AT,
      observedAt: FAILED_AT,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held && hold.breakEndsAt).toBe(Date.parse(ends));
  });

  it('is not a hold without a persisted break', () => {
    for (const breakStartedAt of [null, undefined, '', 'not-a-date']) {
      expect(
        classifySynchronizedBreakHold({
          breakStartedAt,
          breakEndsAt: null,
          silenceStartedAt: SILENCE_STARTED_AT,
          observedAt: FAILED_AT,
          maxSilenceMs: MAX_SILENCE,
        }).held
      ).toBe(false);
    }
  });

  it('still fails a table that stalled long before the break began', () => {
    const hold = classifySynchronizedBreakHold({
      breakStartedAt: BREAK_STARTED,
      breakEndsAt: null,
      silenceStartedAt: STARTED_AT - MAX_SILENCE - 1,
      observedAt: STARTED_AT + 10_000,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held).toBe(false);
  });

  it('still fails a table that does not resume after the break', () => {
    const endsAt = STARTED_AT + SYNCHRONIZED_BREAK_MS;
    const hold = classifySynchronizedBreakHold({
      breakStartedAt: BREAK_STARTED,
      breakEndsAt: null,
      silenceStartedAt: SILENCE_STARTED_AT,
      observedAt: endsAt + MAX_SILENCE + 1,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held).toBe(false);
  });

  it('does not excuse silence that does not overlap the break', () => {
    expect(
      classifySynchronizedBreakHold({
        breakStartedAt: BREAK_STARTED,
        breakEndsAt: null,
        silenceStartedAt: SILENCE_STARTED_AT - 120_000,
        observedAt: STARTED_AT - 1,
        maxSilenceMs: MAX_SILENCE,
      }).held
    ).toBe(false);
  });
});
