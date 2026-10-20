import { describe, expect, it } from 'vitest';
import { isRoutineMaintenanceUpcoming } from '../../src/utils/maintenanceSchedule';

describe('the lobby advertises only the daily Chicago maintenance window', () => {
  it.each([
    ['2026-10-20T08:54:59Z', false],
    ['2026-10-20T08:55:00Z', true],
    ['2026-10-20T08:57:59Z', true],
    ['2026-10-20T08:58:00Z', false],
    ['2026-11-01T09:55:00Z', true],
    ['2026-11-01T08:55:00Z', false],
    ['2026-03-08T08:55:00Z', true],
    ['2026-03-08T09:55:00Z', false],
  ])('uses IANA Chicago time at %s', (iso, expected) => {
    expect(isRoutineMaintenanceUpcoming(Date.parse(iso))).toBe(expected);
  });
  it('never advertises a cash freeze at ordinary hourly tournament breaks', () => {
    for (let hour = 0; hour < 24; hour++) {
      const at = Date.UTC(2026, 9, 20, hour, 50);
      expect(isRoutineMaintenanceUpcoming(at)).toBe(false);
    }
  });
});
