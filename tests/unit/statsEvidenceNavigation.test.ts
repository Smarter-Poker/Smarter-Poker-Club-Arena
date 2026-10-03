import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStatsHandEvidencePath,
  buildStatsCashEvidencePath,
  buildStatsTournamentEvidencePath,
  rememberStatsEvidenceOrigin,
  restoreStatsEvidenceScroll,
} from '../../src/lib/statsEvidenceNavigation';
import {
  readStatsDrilldown,
  statsEvidenceQueryFromDrilldown,
} from '../../src/lib/handHistoryDrilldown';

describe('Stats evidence navigation', () => {
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('builds exact encoded evidence destinations without inventing ids', () => {
    expect(buildStatsHandEvidencePath('hand/7', 'club-1')).toBe(
      '/hand-history?hand=hand%2F7&source=stats&statsClub=club-1'
    );
    expect(buildStatsTournamentEvidencePath('event/9')).toBe('/tournaments/event%2F9?source=stats');
    expect(
      buildStatsCashEvidencePath('barrel_turn', {
        clubId: 'club-1',
        asset: 'chips',
        from: '2026-10-01',
        to: '2026-10-03',
      })
    ).toBe(
      '/hand-history?source=stats&statsMetric=barrel_turn&statsClub=club-1&statsAsset=chips&from=2026-10-01&to=2026-10-03'
    );
  });

  it('restores scroll only for the exact Back or Forward Stats URL', () => {
    vi.useFakeTimers();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const location = {
      pathname: '/stats',
      search: '?tab=hands&statsClub=club-1',
      hash: '',
    } as never;
    rememberStatsEvidenceOrigin(location, 732);

    restoreStatsEvidenceScroll({ pathname: '/stats', search: '?tab=analysis', hash: '' } as never);
    vi.runAllTimers();
    expect(scrollTo).not.toHaveBeenCalled();

    restoreStatsEvidenceScroll(location);
    vi.runAllTimers();
    expect(scrollTo).toHaveBeenCalledWith({ top: 732, behavior: 'auto' });
  });

  it('accepts only canonical cash metrics and converts an inclusive date to an exclusive bound', () => {
    const drilldown = readStatsDrilldown(
      new URLSearchParams('statsMetric=three_bet&from=2026-10-01&to=2026-10-03')
    );
    expect(drilldown.statsMetric).toBe('three_bet');
    expect(statsEvidenceQueryFromDrilldown(drilldown)).toMatchObject({
      cashMetric: 'three_bet',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-04T00:00:00.000Z',
    });
    expect(
      readStatsDrilldown(new URLSearchParams('statsMetric=not_a_real_metric')).statsMetric
    ).toBeUndefined();
    expect(
      readStatsDrilldown(new URLSearchParams('statsSession=11111111-1111-4111-8111-111111111111'))
        .statsSession
    ).toBe('11111111-1111-4111-8111-111111111111');
    expect(
      readStatsDrilldown(new URLSearchParams('statsSession=not-a-uuid')).statsSession
    ).toBeUndefined();
  });
});
