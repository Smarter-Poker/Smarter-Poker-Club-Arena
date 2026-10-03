export const STATS_CONTRACT_VERSION = 2 as const;

export interface StatsScopeContract {
  target_user_id: string | null;
  club_id: string | null;
  range_days: number | null;
  visibility: 'owner' | 'shared_club';
}

export interface StatsQualityContract {
  cash_money_source: 'exact_settlement' | 'reconstructed_actions' | 'mixed';
  cash_money_exact: boolean;
  /**
   * How many of the cash hands in this payload carry the engine's own
   * settlement row (ca_hand_facts). The rest use the action reconstruction.
   * Absent on payloads from before 2026-09-03; reported as 0 then.
   */
  exact_cash_hands: number;
  advanced_facts_source: 'ca_hand_facts' | 'ca_hand_player_stat';
  historical_club_breakdown_available: boolean;
  club_breakdown_available: boolean;
  club_breakdown_source: 'ca_hand_facts' | null;
  club_breakdown_starts_at: string | null;
  section_availability: StatsSectionAvailabilityContract;
  metric_availability: StatsMetricAvailabilityContract;
  live_tail_included: boolean;
}

/** Whole payload sections that the selected source cannot answer truthfully. */
export interface StatsSectionAvailabilityContract {
  sessions: boolean;
  sessions_reason: 'not_captured_in_ca_hand_facts' | null;
}

/** Denominator evidence for club fact metrics that may be unmeasured. */
export interface StatsMetricAvailabilityContract {
  three_bet_percent: boolean;
  three_bet_numerator: number;
  three_bet_opportunities: number | null;
  fold_to_three_bet: boolean;
  fold_to_three_bet_opportunities: number;
  cbet_flop: boolean;
  cbet_flop_opportunities: number;
  aggression_factor: boolean;
  aggression_factor_denominator: number;
  wtsd: boolean;
  wtsd_opportunities: number;
  hours_played: boolean;
}

export interface StatsCoverageContract {
  analysis_hand_cap: number;
  analysis_hands_capped: boolean;
  lifetime_index_complete: boolean;
  first_hand_at: string | null;
  last_hand_at: string | null;
  rollup_covered_through: string | null;
  rollup_updated_at: string | null;
}

export interface StatsContractMetadata {
  contract_version: typeof STATS_CONTRACT_VERSION | null;
  valid: boolean;
  generated_at: string | null;
  scope: StatsScopeContract;
  quality: StatsQualityContract;
  coverage: StatsCoverageContract;
}

export interface StatsMetricDefinition {
  key: string;
  label: string;
  unit: 'count' | 'chips' | 'ratio' | 'percent' | 'bb_per_100' | 'hours';
  source: 'settlement' | 'hand_actions' | 'tournament_ledger' | 'hand_facts';
  minimumSample: number;
  definition: string;
}

export interface CanonicalCashPerformanceOverlay {
  three_bet_percent: number | null;
  cbet_flop: number | null;
  metric_availability: Pick<
    StatsMetricAvailabilityContract,
    | 'three_bet_percent'
    | 'three_bet_numerator'
    | 'three_bet_opportunities'
    | 'cbet_flop'
    | 'cbet_flop_opportunities'
  >;
}

/**
 * Bridges the Phase 6 exact opportunity contract into the existing Performance
 * surface without converting absent historical denominators into a measured 0.
 */
export function canonicalCashPerformanceOverlay(
  payload: import('./StatsFactsService').CashOpportunityStats | null | undefined
): CanonicalCashPerformanceOverlay {
  const threeBet = payload?.opportunities.three_bet;
  const cbet = payload?.opportunities.cbet_flop;
  const rate = (row: { actions: number; opportunities: number } | undefined): number | null =>
    row && row.opportunities > 0 ? row.actions / row.opportunities : null;
  return {
    three_bet_percent: rate(threeBet),
    cbet_flop: rate(cbet),
    metric_availability: {
      three_bet_percent: Boolean(threeBet && threeBet.opportunities > 0),
      three_bet_numerator: Math.max(0, Math.floor(threeBet?.actions ?? 0)),
      three_bet_opportunities: threeBet ? Math.max(0, Math.floor(threeBet.opportunities)) : null,
      cbet_flop: Boolean(cbet && cbet.opportunities > 0),
      cbet_flop_opportunities: Math.max(0, Math.floor(cbet?.opportunities ?? 0)),
    },
  };
}

/**
 * The first versioned metric dictionary. Later phases may add metrics, but a
 * label cannot silently change its numerator, denominator or source.
 */
export const STATS_METRIC_DEFINITIONS: Readonly<Record<string, StatsMetricDefinition>> = {
  total_hands: {
    key: 'total_hands',
    label: 'Hands Analyzed',
    unit: 'count',
    source: 'hand_actions',
    minimumSample: 1,
    definition: 'Hands included in the selected analysis window after the documented cap.',
  },
  total_profit: {
    key: 'total_profit',
    label: 'Cash Result',
    unit: 'chips',
    source: 'settlement',
    minimumSample: 1,
    definition:
      'Cash return minus exact settlement investment where ca_hand_facts coverage exists. The payload quality contract names reconstructed or mixed historical coverage explicitly.',
  },
  bb_per_100: {
    key: 'bb_per_100',
    label: 'BB/100',
    unit: 'bb_per_100',
    source: 'settlement',
    minimumSample: 1000,
    definition:
      'Exact settlement cash net in big blinds divided by cash hands, multiplied by 100. Reconstructed or mixed historical coverage is named by the payload quality contract.',
  },
  vpip: {
    key: 'vpip',
    label: 'VPIP',
    unit: 'percent',
    source: 'hand_actions',
    minimumSample: 100,
    definition: 'Hands where the player voluntarily invested preflop divided by dealt hands.',
  },
  pfr: {
    key: 'pfr',
    label: 'PFR',
    unit: 'percent',
    source: 'hand_actions',
    minimumSample: 100,
    definition: 'Hands where the player raised preflop divided by dealt hands.',
  },
  three_bet: {
    key: 'three_bet',
    label: '3-Bet',
    unit: 'percent',
    source: 'hand_facts',
    minimumSample: 50,
    definition: 'Accepted 3-bets divided by exact opportunities to make the third full raise.',
  },
  cbet_flop: {
    key: 'cbet_flop',
    label: 'Flop C-Bet',
    unit: 'percent',
    source: 'hand_facts',
    minimumSample: 50,
    definition:
      'Flop continuation bets divided by checked-to opportunities for the preflop aggressor.',
  },
  rake_paid: {
    key: 'rake_paid',
    label: 'Rake Paid',
    unit: 'chips',
    source: 'settlement',
    minimumSample: 1,
    definition: 'Player-attributed rake from the canonical weighted rake allocator.',
  },
  tournament_roi: {
    key: 'tournament_roi',
    label: 'Tournament ROI',
    unit: 'percent',
    source: 'tournament_ledger',
    minimumSample: 100,
    definition: 'Finalized tournament net result divided by actual finalized entry cost.',
  },
};

const finite = (value: unknown, fallback = 0): number => {
  if (value == null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nullableFinite = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
};

export function normalizeStatsContractMetadata(data: unknown): StatsContractMetadata {
  const raw = data && typeof data === 'object' ? (data as Record<string, any>) : {};
  const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const quality = raw.quality && typeof raw.quality === 'object' ? raw.quality : {};
  const metricAvailability =
    quality.metric_availability && typeof quality.metric_availability === 'object'
      ? quality.metric_availability
      : {};
  const sectionAvailability =
    quality.section_availability && typeof quality.section_availability === 'object'
      ? quality.section_availability
      : {};
  const coverage = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {};

  return {
    contract_version:
      raw.contract_version === STATS_CONTRACT_VERSION ? STATS_CONTRACT_VERSION : null,
    valid:
      raw.contract_version === STATS_CONTRACT_VERSION &&
      raw.scope != null &&
      typeof raw.scope === 'object' &&
      raw.quality != null &&
      typeof raw.quality === 'object' &&
      raw.coverage != null &&
      typeof raw.coverage === 'object',
    generated_at: isoOrNull(raw.generated_at),
    scope: {
      target_user_id: typeof scope.target_user_id === 'string' ? scope.target_user_id : null,
      club_id: typeof scope.club_id === 'string' ? scope.club_id : null,
      range_days: nullableFinite(scope.range_days),
      visibility: scope.visibility === 'shared_club' ? 'shared_club' : 'owner',
    },
    quality: {
      cash_money_source:
        quality.cash_money_source === 'exact_settlement' || quality.cash_money_source === 'mixed'
          ? quality.cash_money_source
          : 'reconstructed_actions',
      cash_money_exact: quality.cash_money_exact === true,
      exact_cash_hands: Math.max(0, Math.floor(finite(quality.exact_cash_hands, 0))),
      advanced_facts_source:
        quality.advanced_facts_source === 'ca_hand_player_stat'
          ? 'ca_hand_player_stat'
          : 'ca_hand_facts',
      historical_club_breakdown_available: quality.historical_club_breakdown_available === true,
      club_breakdown_available: quality.club_breakdown_available === true,
      club_breakdown_source:
        quality.club_breakdown_source === 'ca_hand_facts' ? 'ca_hand_facts' : null,
      club_breakdown_starts_at: isoOrNull(quality.club_breakdown_starts_at),
      section_availability: {
        sessions: sectionAvailability.sessions === true,
        sessions_reason:
          sectionAvailability.sessions_reason === 'not_captured_in_ca_hand_facts'
            ? 'not_captured_in_ca_hand_facts'
            : null,
      },
      metric_availability: {
        three_bet_percent: metricAvailability.three_bet_percent === true,
        three_bet_numerator: Math.max(
          0,
          Math.floor(finite(metricAvailability.three_bet_numerator))
        ),
        three_bet_opportunities: nullableFinite(metricAvailability.three_bet_opportunities),
        fold_to_three_bet: metricAvailability.fold_to_three_bet === true,
        fold_to_three_bet_opportunities: Math.max(
          0,
          Math.floor(finite(metricAvailability.fold_to_three_bet_opportunities))
        ),
        cbet_flop: metricAvailability.cbet_flop === true,
        cbet_flop_opportunities: Math.max(
          0,
          Math.floor(finite(metricAvailability.cbet_flop_opportunities))
        ),
        aggression_factor: metricAvailability.aggression_factor === true,
        aggression_factor_denominator: Math.max(
          0,
          Math.floor(finite(metricAvailability.aggression_factor_denominator))
        ),
        wtsd: metricAvailability.wtsd === true,
        wtsd_opportunities: Math.max(0, Math.floor(finite(metricAvailability.wtsd_opportunities))),
        hours_played: metricAvailability.hours_played === true,
      },
      live_tail_included: quality.live_tail_included === true,
    },
    coverage: {
      analysis_hand_cap: finite(coverage.analysis_hand_cap, 750),
      analysis_hands_capped: coverage.analysis_hands_capped === true,
      lifetime_index_complete: coverage.lifetime_index_complete === true,
      first_hand_at: isoOrNull(coverage.first_hand_at),
      last_hand_at: isoOrNull(coverage.last_hand_at),
      rollup_covered_through: isoOrNull(coverage.rollup_covered_through),
      rollup_updated_at: isoOrNull(coverage.rollup_updated_at),
    },
  };
}
