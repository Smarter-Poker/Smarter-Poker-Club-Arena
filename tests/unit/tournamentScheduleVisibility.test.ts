import { describe, expect, it } from 'vitest';
import { isCurrentMttScheduleEvent as visible } from '../../src/utils/tournamentScheduleVisibility';
const now = Date.parse('2026-10-31T18:00:00Z');
describe('the active MTT schedule excludes missed starts and old unfinished events', () => {
  it('shows future events, hides unstarted events as soon as their start passes', () => {
    const row = { status: 'REGISTERING', start_time: '2026-10-31T18:00:00Z' };
    expect(visible(row, now - 1)).toBe(true);
    expect(visible(row, now + 1)).toBe(false);
    expect(visible({ ...row, start_time: '2026-11-01T18:00:00Z' }, now)).toBe(true);
  });
  it("keeps today's actual live event, regardless of its original scheduled date", () => {
    const row = {
      status: 'RUNNING',
      start_time: '2026-10-30T18:00:00Z',
      started_at: '2026-10-31T17:00:00Z',
    };
    expect(visible(row, now)).toBe(true);
    expect(visible({ ...row, started_at: '2026-10-30T18:00:00Z' }, now)).toBe(false);
  });
  it('uses the Chicago calendar, including DST, rather than the UTC day', () => {
    const row = { status: 'RUNNING', started_at: '2026-11-01T04:59:59Z' };
    expect(visible(row, Date.parse('2026-11-01T05:00:00Z'))).toBe(false);
    expect(
      visible({ ...row, started_at: '2026-11-01T05:00:00Z' }, Date.parse('2026-11-02T05:59:59Z'))
    ).toBe(true);
    expect(
      visible({ ...row, started_at: '2026-11-01T05:00:00Z' }, Date.parse('2026-11-02T06:00:00Z'))
    ).toBe(false);
  });
  it('hides terminal, malformed and future-started rows', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'COMPLETING'])
      expect(visible({ status, start_time: '2026-11-01T18:00:00Z' }, now)).toBe(false);
    expect(visible({ status: 'REGISTERING', start_time: '' }, now)).toBe(false);
    expect(visible({ status: 'RUNNING', started_at: '2026-10-31T19:00:00Z' }, now)).toBe(false);
  });
});
