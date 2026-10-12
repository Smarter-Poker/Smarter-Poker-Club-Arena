import { describe, expect, it } from 'vitest';
import {
  STATS_CONTRACT_VERSION,
  STATS_METRIC_DEFINITIONS,
  normalizeStatsContractMetadata,
  statsContractMatchesRequest,
  canonicalCashPerformanceOverlay,
} from '../../src/services/statsContract';

describe('normalizeStatsContractMetadata', () => {
  it('preserves a valid v2 owner scope and exact quality', () => {
    const result = normalizeStatsContractMetadata({
      contract_version: 2,
      generated_at: '2026-08-31T12:00:00.000Z',
      scope: {
        target_user_id: 'player-1',
        club_id: 'club-1',
        asset: 'chips',
        range_days: 30,
        range_tz: 'America/Chicago',
        visibility: 'owner',
      },
      quality: {
        cash_money_source: 'exact_settlement',
        cash_money_exact: true,
        historical_club_breakdown_available: true,
        section_availability: {
          sessions: false,
          sessions_reason: 'not_captured_in_ca_hand_facts',
        },
        metric_availability: {
          three_bet_percent: false,
          three_bet_numerator: 4,
          three_bet_opportunities: null,
          aggression_factor: true,
          aggression_factor_denominator: 7,
          wtsd: true,
          wtsd_opportunities: 18,
        },
      },
      coverage: {
        analysis_hand_cap: 5000,
        analysis_hands_capped: true,
        lifetime_index_complete: true,
        first_hand_at: '2026-01-01T00:00:00.000Z',
        last_hand_at: '2026-08-31T11:59:00.000Z',
      },
    });

    expect(result.contract_version).toBe(STATS_CONTRACT_VERSION);
    expect(result.valid).toBe(true);
    expect(result.scope).toMatchObject({ club_id: 'club-1', range_days: 30 });
    expect(result.quality.cash_money_exact).toBe(true);
    expect(result.quality.section_availability).toEqual({
      sessions: false,
      sessions_reason: 'not_captured_in_ca_hand_facts',
    });
    expect(result.quality.metric_availability).toMatchObject({
      three_bet_percent: false,
      three_bet_numerator: 4,
      three_bet_opportunities: null,
      aggression_factor: true,
      aggression_factor_denominator: 7,
      wtsd: true,
      wtsd_opportunities: 18,
    });
    expect(result.coverage.analysis_hands_capped).toBe(true);
    expect(
      statsContractMatchesRequest(result, {
        targetUserId: 'player-1',
        clubId: 'club-1',
        asset: 'chips',
        rangeDays: 30,
        timezone: 'America/Chicago',
        visibility: 'owner',
      })
    ).toBe(true);
    expect(
      statsContractMatchesRequest(result, {
        targetUserId: 'another-player',
        clubId: 'club-1',
        asset: 'chips',
        rangeDays: 30,
        timezone: 'America/Chicago',
        visibility: 'owner',
      })
    ).toBe(false);
  });

  it('fails closed to reconstructed, owner-only metadata for malformed input', () => {
    const result = normalizeStatsContractMetadata({
      generated_at: 'not-a-date',
      scope: { visibility: 'public', range_days: 'not-a-number' },
      quality: { cash_money_source: 'unknown' },
      coverage: { analysis_hand_cap: null },
    });

    expect(result.generated_at).toBeNull();
    expect(result.contract_version).toBeNull();
    expect(result.valid).toBe(false);
    expect(result.scope.visibility).toBe('owner');
    expect(result.scope.range_days).toBeNull();
    expect(result.quality).toMatchObject({
      cash_money_source: 'reconstructed_actions',
      cash_money_exact: false,
      historical_club_breakdown_available: false,
    });
    expect(result.coverage.analysis_hand_cap).toBe(750);
    expect(result.quality.live_tail_included).toBe(false);
    expect(result.quality.section_availability).toEqual({
      sessions: false,
      sessions_reason: null,
    });
    expect(result.quality.metric_availability).toMatchObject({
      three_bet_percent: false,
      three_bet_opportunities: null,
      aggression_factor: false,
      aggression_factor_denominator: 0,
      wtsd: false,
      wtsd_opportunities: 0,
    });
  });

  it('ships definitions with source and minimum sample for every registered metric', () => {
    for (const definition of Object.values(STATS_METRIC_DEFINITIONS)) {
      expect(definition.key).toBeTruthy();
      expect(definition.definition.length).toBeGreaterThan(20);
      expect(definition.minimumSample).toBeGreaterThan(0);
      expect(definition.source).toBeTruthy();
    }
  });

  it('overlays canonical opportunity denominators without turning unavailable into zero', () => {
    const unavailable = canonicalCashPerformanceOverlay(null);
    expect(unavailable.three_bet_percent).toBeNull();
    expect(unavailable.metric_availability.three_bet_percent).toBe(false);
    expect(unavailable.metric_availability.three_bet_opportunities).toBeNull();

    const measured = canonicalCashPerformanceOverlay({
      opportunities: {
        three_bet: { actions: 4, opportunities: 20 },
        cbet_flop: { actions: 6, opportunities: 10 },
      },
    } as never);
    expect(measured.three_bet_percent).toBe(0.2);
    expect(measured.cbet_flop).toBe(0.6);
    expect(measured.metric_availability).toMatchObject({
      three_bet_percent: true,
      three_bet_numerator: 4,
      three_bet_opportunities: 20,
      cbet_flop: true,
      cbet_flop_opportunities: 10,
    });
  });
});
