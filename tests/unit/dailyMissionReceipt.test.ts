import { describe, expect, it } from 'vitest';
import { isCurrentDailyMissionDashboardReceipt } from '../../src/utils/dailyMissionReceipt';

describe('Daily Mission dashboard receipt ordering', () => {
  it('accepts the latest read when no newer mutation has settled', () => {
    expect(isCurrentDailyMissionDashboardReceipt(7, 7, 3, 3)).toBe(true);
  });

  it('rejects a superseded dashboard request', () => {
    expect(isCurrentDailyMissionDashboardReceipt(6, 7, 3, 3)).toBe(false);
  });

  it('rejects a pre-action read after a claim, reroll, or freeze receipt settles', () => {
    expect(isCurrentDailyMissionDashboardReceipt(7, 7, 3, 4)).toBe(false);
  });
});
