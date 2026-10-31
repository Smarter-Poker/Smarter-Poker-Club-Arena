import { describe, expect, it } from 'vitest';
import { classifyAddOnBreakHold } from '../e2e/support/tournamentBoardEnding';

/*
 * Post-deploy run 39022068317 (MTT a42f5d39): pot_distributed at
 * 1792231402373, level_up 3s later, then the 1-minute add-on break, and the
 * case failed at 45078ms of silence while the table was held. Gameplay
 * resumed with hand_started at 1792231472355, right after the break.
 */
const SILENCE_STARTED_AT = 1_792_231_402_373;
const FAILED_AT = SILENCE_STARTED_AT + 45_078;
const BREAK_ENDS_AT = 1_792_231_470_000;
const ENDS_ISO = new Date(BREAK_ENDS_AT).toISOString();
const MAX_SILENCE = 45_000;

describe('a persisted add-on break is an authoritative hold', () => {
  it('names the production failure as a hold inside the break', () => {
    const hold = classifyAddOnBreakHold({
      addonPeriodEndsAt: ENDS_ISO,
      addonBreakMinutes: 1,
      silenceStartedAt: SILENCE_STARTED_AT,
      observedAt: FAILED_AT,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held).toBe(true);
    if (hold.held) {
      expect(hold.breakStartedAt).toBe(BREAK_ENDS_AT - 60_000);
      expect(hold.breakEndsAt).toBe(BREAK_ENDS_AT);
    }
  });

  it('is not a hold without a persisted window', () => {
    for (const addonPeriodEndsAt of [null, undefined, '', 'not-a-date']) {
      expect(
        classifyAddOnBreakHold({
          addonPeriodEndsAt,
          addonBreakMinutes: 1,
          silenceStartedAt: SILENCE_STARTED_AT,
          observedAt: FAILED_AT,
          maxSilenceMs: MAX_SILENCE,
        }).held
      ).toBe(false);
    }
  });

  it('does not excuse a table that stalled before the break began', () => {
    const hold = classifyAddOnBreakHold({
      addonPeriodEndsAt: ENDS_ISO,
      addonBreakMinutes: 1,
      silenceStartedAt: BREAK_ENDS_AT - 60_000 - MAX_SILENCE - 1,
      observedAt: FAILED_AT,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held).toBe(false);
  });

  it('does not excuse a table that failed to resume after the break', () => {
    const hold = classifyAddOnBreakHold({
      addonPeriodEndsAt: ENDS_ISO,
      addonBreakMinutes: 1,
      silenceStartedAt: SILENCE_STARTED_AT,
      observedAt: BREAK_ENDS_AT + MAX_SILENCE + 1,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(hold.held).toBe(false);
  });

  it('does not excuse silence that never overlaps the break', () => {
    expect(
      classifyAddOnBreakHold({
        addonPeriodEndsAt: ENDS_ISO,
        addonBreakMinutes: 1,
        silenceStartedAt: BREAK_ENDS_AT + 1_000,
        observedAt: BREAK_ENDS_AT + 46_000,
        maxSilenceMs: MAX_SILENCE,
      }).held
    ).toBe(false);
    expect(
      classifyAddOnBreakHold({
        addonPeriodEndsAt: ENDS_ISO,
        addonBreakMinutes: 1,
        silenceStartedAt: BREAK_ENDS_AT - 200_000,
        observedAt: BREAK_ENDS_AT - 60_000,
        maxSilenceMs: MAX_SILENCE,
      }).held
    ).toBe(false);
  });

  it('never excuses a longer hold from a legacy break setting', () => {
    const long = classifyAddOnBreakHold({
      addonPeriodEndsAt: ENDS_ISO,
      addonBreakMinutes: 60,
      silenceStartedAt: BREAK_ENDS_AT - 600_000,
      observedAt: BREAK_ENDS_AT - 500_000,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(long.held).toBe(false);
    const missing = classifyAddOnBreakHold({
      addonPeriodEndsAt: ENDS_ISO,
      addonBreakMinutes: null,
      silenceStartedAt: SILENCE_STARTED_AT,
      observedAt: FAILED_AT,
      maxSilenceMs: MAX_SILENCE,
    });
    expect(missing.held && missing.breakStartedAt).toBe(BREAK_ENDS_AT - 60_000);
  });

  it('refuses an unmeasurable silence', () => {
    expect(
      classifyAddOnBreakHold({
        addonPeriodEndsAt: ENDS_ISO,
        addonBreakMinutes: 1,
        silenceStartedAt: Number.NaN,
        observedAt: FAILED_AT,
        maxSilenceMs: MAX_SILENCE,
      }).held
    ).toBe(false);
  });
});
