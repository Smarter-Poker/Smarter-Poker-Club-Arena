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

export interface ClassHand {
  hand_id: string;
  played_at: string;
  position: string;
  net: number;
  net_bb: number;
  big_blind: number;
  variant: string;
  was_all_in: boolean;
  showdown: boolean;
  won: boolean;
  hole_cards: Array<{ rank: string; suit: string }> | null;
}

export interface ClassHandsPayload {
  hand_class: string | null;
  hands: ClassHand[];
  generated_at?: string;
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

/**
 * POLISH 1 (Dan 2026-08-30): the player's own weighted rake, from the same
 * cent-exact source the money pipeline uses (ca_hand_facts.rake_paid, written
 * by the canonical allocator). Cash hands only.
 */
export interface PlayerRakeStats {
  hands: number;
  raked_hands: number;
  rake_paid: number;
  /** Rake per 100 hands played — the industry-standard shape. */
  rake_per_100: number;
  rake_in_bb: number;
  bb_per_100: number;
  avg_rake_per_raked_hand: number;
  first_hand_at: string | null;
  last_hand_at: string | null;
  days: number | null;
}

/** One hand's rake, and the caller's own share of it. */
export interface HandRakeShare {
  found: boolean;
  hand_id?: string;
  rake_method?: string;
  pot_size?: number | null;
  hand_rake?: number;
  hand_bbj?: number;
  your_contribution?: number;
  your_returned_uncalled?: number;
  your_share_pct?: number;
  your_rake?: number;
  your_bbj?: number;
  /** false when derived by the allocator (pre-ledger hand) rather than stored. */
  from_ledger?: boolean;
}

const EMPTY_RAKE_STATS: PlayerRakeStats = {
  hands: 0,
  raked_hands: 0,
  rake_paid: 0,
  rake_per_100: 0,
  rake_in_bb: 0,
  bb_per_100: 0,
  avg_rake_per_raked_hand: 0,
  first_hand_at: null,
  last_hand_at: null,
  days: null,
};

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

  /**
   * The individual hands behind one cell of the 13x13 grid.
   *
   * Returns hole cards that may never have gone to showdown, so it is the
   * caller's own hands only - the RPC asserts identity server-side.
   */
  async getClassHands(
    userId: string,
    handClass: string,
    opts: { position?: string | null; variant?: string | null; days?: number | null } = {}
  ): Promise<ClassHandsPayload> {
    return callRpc<ClassHandsPayload>(
      'ca_player_class_hands',
      {
        p_user: userId,
        p_hand_class: handClass,
        p_position: opts.position ?? null,
        p_variant: opts.variant ?? null,
        p_days: opts.days ?? null,
        p_limit: 20,
      },
      { hand_class: handClass, hands: [] }
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

  /**
   * POLISH 1: the caller's own weighted rake. Identity is derived server-side
   * from auth.uid() — the p_user argument is honoured for the engine only.
   * `days: null` means lifetime.
   */
  async getRakeStats(days: number | null = null): Promise<PlayerRakeStats> {
    return callRpc<PlayerRakeStats>(
      'ca_player_rake_stats',
      { p_user: null, p_days: days },
      EMPTY_RAKE_STATS
    );
  },

  /**
   * POLISH 1: "your rake share" for one hand, read from the authoritative
   * per-player ledger (rake_attributions), with the canonical allocator as the
   * fallback for hands that predate it. Never exposes another player's
   * contribution.
   */
  async getHandRakeShare(handId: string): Promise<HandRakeShare> {
    if (!handId) return { found: false };
    return callRpc<HandRakeShare>(
      'ca_player_hand_rake_share',
      { p_hand_id: handId },
      { found: false }
    );
  },
};

export default StatsFactsService;
