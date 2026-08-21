/**
 * StatsFactsService — typed reads over the ca_hand_facts layer.
 *
 * These four RPCs are all SECURITY DEFINER and every one of them asserts
 * `p_user = auth.uid()` server-side before touching a row (see
 * ca_assert_self). That is not a formality: ca_hand_facts.hole_cards contains
 * holdings that were never shown at showdown, so a DEFINER function without
 * that gate would hand any logged-in user any other player's mucked cards.
 *
 * The client must therefore never call these for anyone but the signed-in
 * user. Callers gate on `isOwnProfile`; the database refuses regardless, but
 * a UI that asks and gets a 42501 is a UI that shows an error where it should
 * have shown nothing.
 *
 * NO BACKFILL: ca_hand_facts starts at the deploy date. Every read here can
 * legitimately come back empty for a player with years of history, and the
 * components must treat "no rows" as "not gathered yet", never as "you have
 * never played".
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

// ── EV vs actual ───────────────────────────────────────────────────────────

export interface EVCurvePoint {
  i: number;
  at: string;
  net_bb: number;
  ev_net_bb: number;
  cum_net_bb: number;
  cum_ev_net_bb: number;
}

export interface EVCurveSummary {
  hands: number;
  all_in_hands: number;
  net_bb: number;
  ev_net_bb: number;
  /** Positive means running ABOVE expectation. */
  luck_bb: number;
  luck_bb_per_100: number;
  biggest_suckout: number;
  biggest_beat: number;
  capped: boolean;
}

export interface EVCurvePayload {
  points: EVCurvePoint[];
  summary: EVCurveSummary;
  generated_at: string;
}

// ── 13x13 grid ─────────────────────────────────────────────────────────────

export interface HandGridCell {
  hand_class: string;
  hands: number;
  hands_vpip: number;
  hands_won: number;
  /** Fraction 0..1, not a percentage. */
  vpip_pct: number;
  net_bb: number;
  ev_net_bb: number;
  bb100: number;
}

export interface HandGridPayload {
  cells: HandGridCell[];
  totals: { hands: number; classes_seen: number };
  filters: { position: string | null; variant: string | null; days: number | null };
  generated_at: string;
}

// ── Nemesis ────────────────────────────────────────────────────────────────

export interface OpponentFlow {
  opponent_id: string;
  username: string | null;
  avatar_url: string | null;
  /** Signed from the caller's view: negative means they are up on you. */
  net_chips: number;
  hands_together: number;
  last_played_at: string | null;
}

export interface NemesisPayload {
  nemesis: OpponentFlow | null;
  target: OpponentFlow | null;
  worst: OpponentFlow[];
  best: OpponentFlow[];
  min_hands: number;
  opponents_qualified: number;
  generated_at: string;
}

// ── Benchmarks ─────────────────────────────────────────────────────────────

export interface DistributionRow {
  cohort: string;
  metric: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  sample_size: number;
}

const EMPTY_EV: EVCurvePayload = {
  points: [],
  summary: {
    hands: 0,
    all_in_hands: 0,
    net_bb: 0,
    ev_net_bb: 0,
    luck_bb: 0,
    luck_bb_per_100: 0,
    biggest_suckout: 0,
    biggest_beat: 0,
    capped: false,
  },
  generated_at: '',
};

async function callRpc<T>(fn: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      // 42501 is the identity gate refusing a cross-user read. That is the
      // system working, not a fault, so it is not reported as an error.
      if (error.code !== '42501') reportError(error, `StatsFactsService.${fn}`, args);
      return fallback;
    }
    return (data as T) ?? fallback;
  } catch (err) {
    reportError(err, `StatsFactsService.${fn}.threw`, args);
    return fallback;
  }
}

export const StatsFactsService = {
  /** Cumulative actual vs all-in-adjusted EV. Cash hands only. */
  async getEVCurve(userId: string, days: number | null = null): Promise<EVCurvePayload> {
    return callRpc<EVCurvePayload>(
      'ca_player_ev_curve',
      { p_user: userId, p_days: days, p_limit: 5000 },
      EMPTY_EV
    );
  },

  /** Per-hand-class aggregates for the 169-cell grid. NLH / short-deck only. */
  async getHandGrid(
    userId: string,
    opts: { position?: string | null; variant?: string | null; days?: number | null } = {}
  ): Promise<HandGridPayload> {
    return callRpc<HandGridPayload>(
      'ca_player_hand_grid',
      {
        p_user: userId,
        p_position: opts.position ?? null,
        p_variant: opts.variant ?? null,
        p_days: opts.days ?? null,
      },
      {
        cells: [],
        totals: { hands: 0, classes_seen: 0 },
        filters: { position: null, variant: null, days: null },
        generated_at: '',
      }
    );
  },

  /** Head-to-head chip flow. minHands guards against crowning a nemesis off one cooler. */
  async getNemesis(
    userId: string,
    opts: { days?: number | null; minHands?: number } = {}
  ): Promise<NemesisPayload> {
    return callRpc<NemesisPayload>(
      'ca_player_nemesis',
      {
        p_user: userId,
        p_days: opts.days ?? null,
        p_min_hands: opts.minHands ?? 25,
        p_limit: 10,
      },
      {
        nemesis: null,
        target: null,
        worst: [],
        best: [],
        min_hands: opts.minHands ?? 25,
        opponents_qualified: 0,
        generated_at: '',
      }
    );
  },

  /**
   * Percentile breakpoints for the field.
   *
   * COHORT HONESTY: 584 of the 585 users with hands are horses. This is a
   * comparison against the field a player actually faces, which is useful and
   * real — but it is not a human population, and every surface that renders
   * these must say "the field", never "players like you".
   */
  async getDistribution(cohort = 'field'): Promise<DistributionRow[]> {
    try {
      const { data, error } = await supabase
        .from('ca_stat_distribution')
        .select('cohort, metric, p10, p25, p50, p75, p90, sample_size')
        .eq('cohort', cohort);
      if (error) {
        reportError(error, 'StatsFactsService.getDistribution', { cohort });
        return [];
      }
      return (data as DistributionRow[]) ?? [];
    } catch (err) {
      reportError(err, 'StatsFactsService.getDistribution.threw', { cohort });
      return [];
    }
  },
};

export default StatsFactsService;
