import { describe, expect, it } from 'vitest';
import {
  dailyMissionRevisionFromPayload,
  isCurrentDailyMissionDashboardReceipt,
  shouldRefreshQueuedDailyMissionRealtime,
} from '../../src/utils/dailyMissionReceipt';

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

describe('Daily Mission pre-settlement Realtime ordering', () => {
  it('does not replace a one-shot freeze receipt with its own matching broadcast echo', () => {
    expect(shouldRefreshQueuedDailyMissionRealtime(18, false, 18)).toBe(false);
    expect(shouldRefreshQueuedDailyMissionRealtime(17, false, 18)).toBe(false);
  });

  it('reconciles a genuinely newer or unversioned event after the receipt settles', () => {
    expect(shouldRefreshQueuedDailyMissionRealtime(19, false, 18)).toBe(true);
    expect(shouldRefreshQueuedDailyMissionRealtime(null, true, 18)).toBe(true);
  });

  it('accepts only a positive safe-integer broadcast cursor', () => {
    expect(dailyMissionRevisionFromPayload({ revision: 9 })).toBe(9);
    expect(dailyMissionRevisionFromPayload({ payload: { data: { revision: 11 } } })).toBe(11);
    expect(dailyMissionRevisionFromPayload({ revision: '9' })).toBeNull();
    expect(dailyMissionRevisionFromPayload({ revision: 9.5 })).toBeNull();
    expect(dailyMissionRevisionFromPayload({ revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });
});
