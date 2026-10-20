import { describe, expect, it } from 'vitest';
import { MaintenanceBreak } from '../maintenance/MaintenanceBreak.js';
import {
  LAUNCH_BREAK_PASS_MARGIN_MS,
  launchSeatingBudgetMs,
  launchWouldCrossLastHand,
  scheduledLaunchPreparationAt,
} from './launchBreakHold.js';

const at = (iso: string) => Date.parse(iso);
const maintenance = {
  startMinute: MaintenanceBreak.BREAK_START_MINUTE,
  lastHandLeadMs: MaintenanceBreak.LAST_HAND_LEAD_MS,
  durationMs: MaintenanceBreak.BREAK_DURATION_MS,
};
const prepare = (start: string, field: number) =>
  scheduledLaunchPreparationAt(at(start), field, 60_000, maintenance);

describe('scheduled launch preparation owns the setup time', () => {
  it('finishes the observed 483-player setup before the seated minute', () => {
    const admitted = prepare('2026-10-18T16:45:00Z', 483);
    expect(admitted + 120_000).toBeLessThanOrEqual(at('2026-10-18T16:44:00Z'));
    expect(admitted + launchSeatingBudgetMs(483)).toBe(at('2026-10-18T16:44:00Z'));
  });

  it('finishes the noon field before the 11:53 entry freeze, with the pass margin', () => {
    const admitted = prepare('2026-10-18T17:00:00Z', 483);
    expect(admitted + launchSeatingBudgetMs(483)).toBe(at('2026-10-18T16:49:00Z'));
  });

  it('moves a large :10 setup ahead of the previous freeze too', () => {
    const admitted = prepare('2026-10-18T18:10:00Z', 1000);
    expect(admitted + launchSeatingBudgetMs(1000)).toBe(at('2026-10-18T17:49:00Z'));
  });

  it('keeps a small :10 setup after the freeze and before the seated minute', () => {
    const admitted = prepare('2026-10-18T18:10:00Z', 34);
    expect(admitted).toBeGreaterThan(at('2026-10-18T18:00:00Z'));
    expect(admitted + launchSeatingBudgetMs(34)).toBe(at('2026-10-18T18:09:00Z'));
  });

  it('uses UTC across midnight and the Chicago daylight-saving transition', () => {
    for (const start of ['2026-10-19T00:00:00Z', '2026-11-01T07:00:00Z']) {
      expect(prepare(start, 483) + launchSeatingBudgetMs(483)).toBe(at(start) - 11 * 60_000);
    }
  });

  /** ms from `now` to the next :53 last-hand door, as MaintenanceBreak reports it. */
  const untilLastHand = (now: number) => {
    const hour = 60 * 60_000;
    let door = Math.floor(now / hour) * hour + 53 * 60_000;
    if (door <= now) door += hour;
    return door - now;
  };
  /** How long after preparation opens the start gate would first hold the field. */
  const windowMs = (start: string, field: number) => {
    const opened = prepare(start, field);
    let t = opened;
    while (!launchWouldCrossLastHand(field, untilLastHand(t))) t += 1_000;
    return t - opened;
  };

  it('gives the 2026-10-19 17:00 freerolls a window a slow pass still hits', () => {
    // Production: opened 16:47:27, the pass came at 16:48:37 (70 s), held to the thaw.
    for (const field of [337, 341, 342, 348]) {
      expect(windowMs('2026-10-19T17:00:00Z', field)).toBeGreaterThanOrEqual(
        60_000 + LAUNCH_BREAK_PASS_MARGIN_MS
      );
    }
    expect(prepare('2026-10-19T17:00:00Z', 337)).toBeLessThan(at('2026-10-19T16:47:27Z') - 150_000);
  });

  it('prepares :53 and :54 starts against the coming break, not the previous one', () => {
    for (const start of ['2026-10-19T16:53:00Z', '2026-10-19T16:53:30Z', '2026-10-19T16:54:59Z']) {
      expect(prepare(start, 40) + launchSeatingBudgetMs(40)).toBe(at('2026-10-19T16:49:00Z'));
      expect(windowMs(start, 40)).toBeGreaterThanOrEqual(60_000 + LAUNCH_BREAK_PASS_MARGIN_MS);
    }
  });

  it('every start from :45 to :05 opens at least the seated minute plus the margin before its hold', () => {
    for (let minute = -15; minute <= 5; minute++) {
      const start = new Date(at('2026-10-19T17:00:00Z') + minute * 60_000).toISOString();
      for (const field of [6, 40, 342, 483]) {
        expect(windowMs(start, field), `${start} x${field}`).toBeGreaterThanOrEqual(
          60_000 + LAUNCH_BREAK_PASS_MARGIN_MS
        );
        expect(prepare(start, field) + launchSeatingBudgetMs(field)).toBeLessThanOrEqual(
          at(start) - 60_000
        );
      }
    }
  });

  it('leaves mid-hour starts exactly where they were', () => {
    for (const start of [
      '2026-10-19T17:10:00Z',
      '2026-10-19T17:15:00Z',
      '2026-10-19T17:30:00Z',
      '2026-10-19T17:45:00Z',
    ]) {
      for (const field of [6, 40, 342]) {
        expect(prepare(start, field)).toBe(at(start) - 60_000 - launchSeatingBudgetMs(field));
      }
    }
  });
});
