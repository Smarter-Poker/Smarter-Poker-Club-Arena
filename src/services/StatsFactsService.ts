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
import {
  CHIP_STATS,
  STATS_SCOPE_UNREADABLE,
  statsScopeArgs,
  statsScopeIsReadable,
  type StatsScope,
} from './statsScope';

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

export function normaliseRakeStats(
  raw: Partial<ScopedRead<PlayerRakeStats>> | null | undefined
): ScopedRead<PlayerRakeStats> {
  const src = (raw ?? {}) as Partial<ScopedRead<PlayerRakeStats>>;
  const num = (v: unknown): number => (Number.isFinite(Number(v)) && v !== null ? Number(v) : 0);
  const out: ScopedRead<PlayerRakeStats> = {
    ...EMPTY_RAKE_STATS,
    /* The scope survives normalisation. A figure that arrives knowing which
       asset it describes must not lose that on the way to the tab. */
    scope: src.scope ?? CHIP_STATS,
    hands: num(src.hands),
    raked_hands: num(src.raked_hands),
    rake_paid: num(src.rake_paid),
    rake_per_100: num(src.rake_per_100),
    rake_in_bb: num(src.rake_in_bb),
    bb_per_100: num(src.bb_per_100),
    avg_rake_per_raked_hand: num(src.avg_rake_per_raked_hand),
    first_hand_at: typeof src.first_hand_at === 'string' ? src.first_hand_at : null,
    last_hand_at: typeof src.last_hand_at === 'string' ? src.last_hand_at : null,
    days: src.days === null || src.days === undefined ? null : num(src.days),
  };
  if (src.error) out.error = src.error;
  return out;
}

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

/**
 * Every payload carries `error` when the read FAILED, so a panel can tell
 * "the database said nothing is there" from "the database could not be
 * asked". Before 2026-09-03 both came back as the same empty fallback, and
 * every consumer printed a reassuring "not gathered yet" on a network fault.
 */
export type WithReadStatus<T> = T & { error?: string };

/**
 * A payload that knows which asset it describes.
 *
 * EVERY read here carries one. A figure whose scope has been lost is a figure
 * that can be printed under the wrong heading, which is the whole of the
 * defect this guards (see `./statsScope`).
 */
export type ScopedRead<T> = WithReadStatus<T> & { scope: StatsScope };

async function callRpc<T>(
  fn: string,
  args: Record<string, unknown>,
  fallback: T,
  scope: StatsScope
): Promise<ScopedRead<T>> {
  /* A SCOPE THE DATABASE CANNOT SEPARATE IS NOT ANSWERED (2026-09-20).
     Falling through to the unscoped RPC here would return a chips total
     wearing a Diamond label, which is worse than returning nothing: the panel
     would render it, and it would look right. */
  if (!statsScopeIsReadable(scope)) {
    return { ...fallback, scope, error: STATS_SCOPE_UNREADABLE };
  }
  try {
    const { data, error } = await supabase.rpc(fn, { ...args, ...statsScopeArgs(scope) });
    if (error) {
      // 42501 is the identity gate refusing a cross-user read. That is the
      // system working, not a fault, so it is not reported as an error.
      if (error.code !== '42501') reportError(error, `StatsFactsService.${fn}`, args);
      return { ...fallback, scope, error: error.message || error.code || 'read_failed' };
    }
    return { ...((data as T) ?? fallback), scope } as ScopedRead<T>;
  } catch (err) {
    reportError(err, `StatsFactsService.${fn}.threw`, args);
    return { ...fallback, scope, error: err instanceof Error ? err.message : 'read_threw' };
  }
}

export const StatsFactsService = {
  /** Cumulative actual vs all-in-adjusted EV. Cash hands only. */
  async getEVCurve(
    userId: string,
    scope: StatsScope,
    days: number | null = null
  ): Promise<ScopedRead<EVCurvePayload>> {
    return callRpc<EVCurvePayload>(
      'ca_player_ev_curve',
      { p_user: userId, p_days: days, p_limit: 5000 },
      EMPTY_EV,
      scope
    );
  },

  /** Per-hand-class aggregates for the 169-cell grid. NLH / short-deck only. */
  async getHandGrid(
    userId: string,
    scope: StatsScope,
    opts: { position?: string | null; variant?: string | null; days?: number | null } = {}
  ): Promise<ScopedRead<HandGridPayload>> {
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
      },
      scope
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
    scope: StatsScope,
    handClass: string,
    opts: { position?: string | null; variant?: string | null; days?: number | null } = {}
  ): Promise<ScopedRead<ClassHandsPayload>> {
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
      { hand_class: handClass, hands: [] },
      scope
    );
  },

  /** Head-to-head flow in one asset. minHands guards against crowning a nemesis off one cooler. */
  async getNemesis(
    userId: string,
    scope: StatsScope,
    opts: { days?: number | null; minHands?: number } = {}
  ): Promise<ScopedRead<NemesisPayload>> {
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
      },
      scope
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
  async getDistribution(cohort = 'field'): Promise<{ rows: DistributionRow[]; error?: string }> {
    try {
      const { data, error } = await supabase
        .from('ca_stat_distribution')
        .select('cohort, metric, p10, p25, p50, p75, p90, sample_size')
        .eq('cohort', cohort);
      if (error) {
        reportError(error, 'StatsFactsService.getDistribution', { cohort });
        return { rows: [], error: error.message || 'read_failed' };
      }
      return { rows: (data as DistributionRow[]) ?? [] };
    } catch (err) {
      reportError(err, 'StatsFactsService.getDistribution.threw', { cohort });
      return { rows: [], error: err instanceof Error ? err.message : 'read_threw' };
    }
  },

  /**
   * POLISH 1: the caller's own weighted rake. Identity is derived server-side
   * from auth.uid() — the p_user argument is honoured for the engine only.
   * `days: null` means lifetime.
   */
  async getRakeStats(
    scope: StatsScope,
    days: number | null = null
  ): Promise<ScopedRead<PlayerRakeStats>> {
    const raw = await callRpc<PlayerRakeStats>(
      'ca_player_rake_stats',
      { p_user: null, p_days: days },
      EMPTY_RAKE_STATS,
      scope
    );
    /* THE SHAPE IS PROMISED HERE, NOT ASSUMED IN THE TAB (2026-09-10). The
       Rake tab calls toFixed / toLocaleString on six of these fields, and a
       payload missing one - an older RPC, a null the SQL let through - was a
       TypeError that unmounted the whole stats tab. Every numeric field is
       coerced against the empty shape, so a missing value renders as 0 in
       its own row rather than taking the page down. */
    return normaliseRakeStats(raw);
  },

  /**
   * POLISH 1: "your rake share" for one hand, read from the authoritative
   * per-player ledger (rake_attributions), with the canonical allocator as the
   * fallback for hands that predate it. Never exposes another player's
   * contribution.
   */
  async getHandRakeShare(
    handId: string,
    scope: StatsScope = CHIP_STATS
  ): Promise<ScopedRead<HandRakeShare>> {
    if (!handId) return { found: false, scope };
    return callRpc<HandRakeShare>(
      'ca_player_hand_rake_share',
      { p_hand_id: handId },
      { found: false },
      scope
    );
  },
};

export default StatsFactsService;
