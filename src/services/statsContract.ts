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
  advanced_facts_source: 'ca_hand_facts' | 'ca_hand_player_stat';
  historical_club_breakdown_available: boolean;
  live_tail_included: boolean;
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
    source: 'hand_actions',
    minimumSample: 1,
    definition:
      'Cash winnings minus reconstructed wagering and forced blinds in the selected window. Phase 2 replaces this source with exact settlement facts.',
  },
  bb_per_100: {
    key: 'bb_per_100',
    label: 'BB/100',
    unit: 'bb_per_100',
    source: 'hand_actions',
    minimumSample: 1000,
    definition: 'Cash result in big blinds divided by cash hands, multiplied by 100.',
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
      advanced_facts_source:
        quality.advanced_facts_source === 'ca_hand_player_stat'
          ? 'ca_hand_player_stat'
          : 'ca_hand_facts',
      historical_club_breakdown_available: quality.historical_club_breakdown_available === true,
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
