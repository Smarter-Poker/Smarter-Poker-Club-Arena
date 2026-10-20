import { describe, expect, it } from 'vitest';
import {
  nearbyMaintenanceWindows,
  nextMaintenanceAnnouncement,
} from '../maintenance/maintenanceSchedule.js';
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
  scheduledLaunchPreparationAt(at(start), field, 60_000, {
    ...maintenance,
    freezeStartsAt: nearbyMaintenanceWindows(at(start))
      .map((w) => w.startsAt)
      .reverse(),
  });

describe('scheduled launch preparation owns the setup time', () => {
  it('finishes the observed 483-player setup before the seated minute', () => {
    const admitted = prepare('2026-10-18T16:45:00Z', 483);
    expect(admitted + 120_000).toBeLessThanOrEqual(at('2026-10-18T16:44:00Z'));
    expect(admitted + launchSeatingBudgetMs(483)).toBe(at('2026-10-18T16:44:00Z'));
  });

  it('moves a daily-break-adjacent setup ahead of 03:58 Chicago with the pass margin', () => {
    expect(prepare('2026-10-20T09:05:00Z', 483) + launchSeatingBudgetMs(483)).toBe(
      at('2026-10-20T08:54:00Z')
    );
    expect(prepare('2026-10-20T09:15:00Z', 1000) + launchSeatingBudgetMs(1000)).toBe(
      at('2026-10-20T08:54:00Z')
    );
  });

  it('keeps a small setup after the daily thaw when its full budget fits', () => {
    expect(prepare('2026-10-20T09:15:00Z', 34) + launchSeatingBudgetMs(34)).toBe(
      at('2026-10-20T09:14:00Z')
    );
  });

  it.each([
    ['2026-03-08T09:05:00Z', '2026-03-08T08:54:00Z'],
    ['2026-11-01T10:05:00Z', '2026-11-01T09:54:00Z'],
  ])('uses the actual Chicago daily freeze across DST for %s', (start, ready) => {
    expect(prepare(start, 483) + launchSeatingBudgetMs(483)).toBe(at(ready));
  });

  it('ordinary hourly starts have their full setup budget and no global break hold', () => {
    for (let hour = 11; hour < 24; hour++) {
      for (const minute of [0, 10, 30, 53, 55]) {
        const start = new Date(Date.UTC(2026, 9, 20, hour, minute)).toISOString();
        for (const field of [6, 40, 342, 483]) {
          expect(prepare(start, field)).toBe(at(start) - 60_000 - launchSeatingBudgetMs(field));
        }
      }
    }
  });

  it('leaves a slow discovery pass its full seated minute and pass margin before the daily door', () => {
    for (let minute = -10; minute <= 10; minute++) {
      const start = new Date(at('2026-10-20T09:00:00Z') + minute * 60_000).toISOString();
      for (const field of [6, 40, 342, 483]) {
        const opened = prepare(start, field);
        expect(
          launchWouldCrossLastHand(
            field,
            nextMaintenanceAnnouncement(opened + 60_000 + LAUNCH_BREAK_PASS_MARGIN_MS) -
              opened -
              60_000 -
              LAUNCH_BREAK_PASS_MARGIN_MS
          )
        ).toBe(false);
        expect(opened + launchSeatingBudgetMs(field)).toBeLessThanOrEqual(at(start) - 60_000);
      }
    }
  });
});
