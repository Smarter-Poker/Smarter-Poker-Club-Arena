import { describe, expect, it } from 'vitest';
import {
  STATS_CONTRACT_VERSION,
  STATS_METRIC_DEFINITIONS,
  normalizeStatsContractMetadata,
} from '../../src/services/statsContract';

describe('normalizeStatsContractMetadata', () => {
  it('preserves a valid v2 owner scope and exact quality', () => {
    const result = normalizeStatsContractMetadata({
      contract_version: 2,
      generated_at: '2026-08-31T12:00:00.000Z',
      scope: {
        target_user_id: 'player-1',
        club_id: 'club-1',
        range_days: 30,
        visibility: 'owner',
      },
      quality: {
        cash_money_source: 'exact_settlement',
        cash_money_exact: true,
        historical_club_breakdown_available: true,
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
    expect(result.coverage.analysis_hands_capped).toBe(true);
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
  });

  it('ships definitions with source and minimum sample for every registered metric', () => {
    for (const definition of Object.values(STATS_METRIC_DEFINITIONS)) {
      expect(definition.key).toBeTruthy();
      expect(definition.definition.length).toBeGreaterThan(20);
      expect(definition.minimumSample).toBeGreaterThan(0);
      expect(definition.source).toBeTruthy();
    }
  });
});
