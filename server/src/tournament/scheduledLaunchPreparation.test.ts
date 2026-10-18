import { describe, expect, it } from 'vitest';
import { MaintenanceBreak } from '../maintenance/MaintenanceBreak.js';
import { launchSeatingBudgetMs, scheduledLaunchPreparationAt } from './launchBreakHold.js';

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

  it('finishes the noon field before the 11:53 entry freeze', () => {
    const admitted = prepare('2026-10-18T17:00:00Z', 483);
    expect(admitted + launchSeatingBudgetMs(483)).toBe(at('2026-10-18T16:52:00Z'));
  });

  it('moves a large :10 setup ahead of the previous freeze too', () => {
    const admitted = prepare('2026-10-18T18:10:00Z', 1000);
    expect(admitted + launchSeatingBudgetMs(1000)).toBe(at('2026-10-18T17:52:00Z'));
  });

  it('keeps a small :10 setup after the freeze and before the seated minute', () => {
    const admitted = prepare('2026-10-18T18:10:00Z', 34);
    expect(admitted).toBeGreaterThan(at('2026-10-18T18:00:00Z'));
    expect(admitted + launchSeatingBudgetMs(34)).toBe(at('2026-10-18T18:09:00Z'));
  });

  it('uses UTC across midnight and the Chicago daylight-saving transition', () => {
    for (const start of ['2026-10-19T00:00:00Z', '2026-11-01T07:00:00Z']) {
      expect(prepare(start, 483) + launchSeatingBudgetMs(483)).toBe(at(start) - 8 * 60_000);
    }
  });
});
