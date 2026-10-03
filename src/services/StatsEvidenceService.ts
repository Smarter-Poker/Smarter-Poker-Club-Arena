import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import type { StatsClubId, StatsScope } from './statsScope';

export type StatsEvidenceOutcome = 'won' | 'lost';

export const CASH_EVIDENCE_METRICS = [
  'three_bet',
  'four_bet',
  'steal',
  'squeeze',
  'blind_defense',
  'cbet_flop',
  'barrel_turn',
  'barrel_river',
  'check_raise',
  'donk',
  'probe',
] as const;

export type CashEvidenceMetric = (typeof CASH_EVIDENCE_METRICS)[number];

export function isCashEvidenceMetric(value: unknown): value is CashEvidenceMetric {
  return typeof value === 'string' && (CASH_EVIDENCE_METRICS as readonly string[]).includes(value);
}

export interface StatsEvidenceQuery {
  variant?: string | null;
  position?: string | null;
  bigBlind?: number | null;
  from?: string | null;
  to?: string | null;
  outcome?: StatsEvidenceOutcome | null;
  showdown?: boolean | null;
  allIn?: boolean | null;
  bigPots?: boolean | null;
  noted?: boolean | null;
  handClass?: string | null;
  tournament?: boolean | null;
  cashMetric?: CashEvidenceMetric | null;
}

export interface StatsEvidenceCursor {
  played_at: string;
  hand_id: string;
}

export interface StatsEvidenceHand {
  hand_id: string;
  club_id: string | null;
  table_id: string | null;
  tournament_id: string | null;
  played_at: string;
  game_variant: string;
  big_blind: number;
  position: string | null;
  hand_class: string | null;
  net: number;
  net_bb: number;
  pot_size: number;
  went_to_showdown: boolean;
  was_all_in: boolean;
  won_at_showdown: boolean;
  cash_metric?: CashEvidenceMetric | null;
  cash_metric_action?: boolean | null;
}

export interface StatsEvidencePage {
  hands: StatsEvidenceHand[];
  has_more: boolean;
  next_cursor: StatsEvidenceCursor | null;
  scope: unknown;
  generated_at: string;
}

export interface StatsSessionEvidencePage {
  hands: Array<Pick<StatsEvidenceHand, 'hand_id' | 'played_at' | 'club_id' | 'table_id'>>;
  has_more: boolean;
  next_cursor: StatsEvidenceCursor | null;
  scope: unknown;
  evidence_status?: string;
}

const EMPTY_PAGE: StatsEvidencePage = {
  hands: [],
  has_more: false,
  next_cursor: null,
  scope: null,
  generated_at: '',
};

async function list(
  userId: string,
  scope: StatsScope,
  clubId: StatsClubId,
  query: StatsEvidenceQuery,
  cursor: StatsEvidenceCursor | null = null,
  limit = 12
): Promise<StatsEvidencePage & { error?: string }> {
  const args = {
    p_user: userId,
    p_club_id: clubId,
    p_asset: scope,
    p_variant: query.variant ?? null,
    p_position: query.position ?? null,
    p_big_blind: query.bigBlind ?? null,
    p_from: query.from ?? null,
    p_to: query.to ?? null,
    p_outcome: query.outcome ?? null,
    p_showdown: query.showdown ?? null,
    p_all_in: query.allIn ?? null,
    p_big_pots: query.bigPots ?? null,
    p_noted: query.noted ?? null,
    p_hand_class: query.handClass ?? null,
    p_tournament: query.tournament ?? null,
    p_cash_metric: query.cashMetric ?? null,
    p_cash_session_id: null,
    p_cursor_played_at: cursor?.played_at ?? null,
    p_cursor_hand_id: cursor?.hand_id ?? null,
    p_limit: Math.max(1, Math.min(100, Math.trunc(limit))),
  };

  try {
    const { data, error } = await supabase.rpc('ca_player_stats_hand_evidence', args);
    if (error) {
      if (error.code !== '42501') {
        reportError(error, 'StatsEvidenceService.ca_player_stats_hand_evidence', {
          ...args,
          p_user: 'self',
        });
      }
      return { ...EMPTY_PAGE, error: error.message || error.code || 'read_failed' };
    }
    const payload = (data ?? EMPTY_PAGE) as Partial<StatsEvidencePage>;
    return {
      hands: Array.isArray(payload.hands) ? payload.hands : [],
      has_more: payload.has_more === true,
      next_cursor: payload.next_cursor ?? null,
      scope: payload.scope ?? null,
      generated_at: typeof payload.generated_at === 'string' ? payload.generated_at : '',
    };
  } catch (error) {
    reportError(error, 'StatsEvidenceService.ca_player_stats_hand_evidence.threw', {
      ...args,
      p_user: 'self',
    });
    return {
      ...EMPTY_PAGE,
      error: error instanceof Error ? error.message : 'read_threw',
    };
  }
}

async function listCashSession(
  userId: string,
  cashSessionId: string,
  cursor: StatsEvidenceCursor | null = null,
  limit = 12
): Promise<StatsSessionEvidencePage & { error?: string }> {
  const args = {
    p_user: userId,
    p_club_id: null,
    p_asset: 'chips',
    p_variant: null,
    p_position: null,
    p_big_blind: null,
    p_from: null,
    p_to: null,
    p_outcome: null,
    p_showdown: null,
    p_all_in: null,
    p_big_pots: null,
    p_noted: null,
    p_hand_class: null,
    p_tournament: null,
    p_cash_metric: null,
    p_cash_session_id: cashSessionId,
    p_cursor_played_at: cursor?.played_at ?? null,
    p_cursor_hand_id: cursor?.hand_id ?? null,
    p_limit: Math.max(1, Math.min(100, Math.trunc(limit))),
  };
  try {
    const { data, error } = await supabase.rpc('ca_player_stats_hand_evidence', args);
    if (error) {
      if (error.code !== '42501') {
        reportError(error, 'StatsEvidenceService.ca_player_stats_hand_evidence.session', {
          ...args,
          p_user: 'self',
        });
      }
      return { hands: [], has_more: false, next_cursor: null, scope: null, error: error.message };
    }
    const payload = (data ?? {}) as Partial<StatsSessionEvidencePage>;
    return {
      hands: Array.isArray(payload.hands) ? payload.hands : [],
      has_more: payload.has_more === true,
      next_cursor: payload.next_cursor ?? null,
      scope: payload.scope ?? null,
      evidence_status: payload.evidence_status,
    };
  } catch (error) {
    reportError(error, 'StatsEvidenceService.ca_player_stats_hand_evidence.session.threw', {
      ...args,
      p_user: 'self',
    });
    return {
      hands: [],
      has_more: false,
      next_cursor: null,
      scope: null,
      error: error instanceof Error ? error.message : 'read_threw',
    };
  }
}

export const StatsEvidenceService = { list, listCashSession };

export default StatsEvidenceService;
