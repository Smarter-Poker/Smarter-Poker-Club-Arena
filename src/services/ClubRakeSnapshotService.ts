/**
 * RAKE SNAPSHOT — the question asked at the top of the page.
 *
 * "What has my union / club / downline done in rake today, this week, this
 * month, this year?" is a different question from "list my games", and it needs
 * a different read. ca_club_data_snapshot materialises one row per game and so
 * clamps itself to 93 days; ca_rake_snapshot reads only the daily rollups and
 * so answers for two years without leaving the index.
 *
 * Every scope is gated in the database, not here. The scopes offered by the UI
 * are a convenience so an operator is not shown a chip that will refuse them.
 */

import { supabase } from '../lib/supabase';
import { safeErrorMessage } from '../utils/safeErrorMessage';

export type RakeScope = 'club' | 'union' | 'agent';

export type PeriodKey = 'today' | 'yesterday' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

export interface RakeSnapshotSummary {
  fee: number;
  cash_fee: number | null;
  mtt_fee: number | null;
  games: number | null;
  cash_games?: number | null;
  mtt_games?: number | null;
  hands: number;
  total_winnings: number | null;
  cash_winnings?: number | null;
  mtt_winnings: number | null;
  /** agent scope only */
  members?: number;
  active?: number;
  commission_rate?: number | null;
  estimated_commission?: number | null;
}

export interface RakeSeriesPoint {
  bucket: string;
  fee: number;
  winnings: number;
}

/** Union scope: one row per member club. */
export interface RakeClubRow {
  club_id: string;
  name: string;
  code: string | null;
  avatar_url: string | null;
  fee: number;
  cash_fee: number;
  mtt_fee: number;
  winnings: number;
  hands: number;
  games: number;
}

/**
 * Club scope: one row per agent. DIRECT is the rake of the players assigned
 * straight to them; NETWORK adds everyone beneath. Network deliberately
 * double-counts up the chain - a super agent's network contains their
 * sub-agents' - so it is a ranking figure, never a summable one. Only the
 * direct column sums to the club's attributed total.
 */
export interface RakeAgentRow {
  agent_user_id: string | null;
  name: string;
  avatar_url: string | null;
  role: string;
  commission_rate: number | null;
  direct_players: number;
  direct_active: number;
  direct_rake: number;
  direct_hands: number;
  network_players: number;
  network_rake: number;
  sub_agents: number;
  /** Players in the club with no agent. Real rake; it just has no owner. */
  is_unassigned: boolean;
  /**
   * Commission money. NULL means NOT DISCLOSED, not zero.
   *
   * The club's commission bill is admin-only (fn_is_club_admin_uid), which is
   * tighter than the finances gate this page runs under - so a super agent
   * reads every rake figure and gets nulls here. Zero would say "this agent
   * costs nothing", which is a different claim and a false one.
   *
   * Commission CASCADES: an upline earns on their downline's rake and has its
   * own ledger rows for it. So this is NOT direct_rake times commission_rate,
   * and the panel must not invite that arithmetic. Unlike network_rake it does
   * sum - one recipient per ledger row - so the column total is the club's
   * bill for the window.
   */
  commission_earned: number | null;
  commission_outstanding: number | null;
  commission_settled: number | null;
  /** Commission owed to someone with no agents row in this club. */
  is_residual?: boolean;
}

/** Agent scope: one row per member beneath the viewer. */
export interface RakeDownlineRow {
  player_id: string;
  name: string;
  role: string;
  depth: number;
  upline_user_id: string | null;
  upline_name: string | null;
  rake: number;
  hands: number;
  last_hand_at: string | null;
  /** Non-zero means this member is an agent too, so their row opens. */
  downline_players: number;
  downline_rake: number;
}

export type RakeBreakdownRow = RakeClubRow | RakeAgentRow | RakeDownlineRow;

export interface RakeSnapshot {
  scope: RakeScope;
  scope_label: string;
  club_id: string | null;
  union_id: string | null;
  club_count?: number | null;
  range: { start: string; end: string; days: number };
  previous_range: { start: string; end: string; days: number };
  summary: RakeSnapshotSummary;
  previous: Partial<RakeSnapshotSummary>;
  delta: {
    fee_pct: number | null;
    games_pct: number | null;
    fee_abs: number | null;
    winnings_abs: number | null;
  };
  series: RakeSeriesPoint[];
  series_bucket: 'day' | 'week' | 'month';
  breakdown: RakeBreakdownRow[];
  breakdown_kind: 'club' | 'agent' | 'downline' | 'none';
  /**
   * How many rows exist BEHIND the page, not how many are in it. A union with
   * fifty-one clubs used to show fifty and say nothing, which made the
   * fifty-first indistinguishable from a club that produced no rake.
   */
  breakdown_count: number;
  /** The offset this page was read from. */
  breakdown_offset: number;
  /**
   * The sum of the breakdown's own non-overlapping column. Shares are computed
   * against this, never against the headline: the headline includes tournament
   * fee and today, and the per-player rollup includes neither, so a share
   * against it would be quietly and consistently too small.
   */
  breakdown_total: number | null;
  /**
   * The club's commission bill for the window, or null when the viewer is not
   * entitled to it. Reconciles exactly with fn_club_commission_accrued.
   */
  commission_total: number | null;
  /**
   * True when the breakdown reads rake_records for everything the daily rollup
   * has not finished, so it is current to the second.
   *
   * It matters because the HEADLINE is not. club_table_daily is written by an
   * hourly catch-up job, so between runs a live breakdown can legitimately sum
   * to MORE than the club total beside it. That looks like an error and is
   * not, so the panel says which side is live rather than leaving an operator
   * to find the discrepancy and stop trusting both figures.
   */
  breakdown_live: boolean;
  /**
   * Retained for older payloads. The club breakdown used to stop at the last
   * complete rollup day and this named it; it now reads live and this is null.
   */
  rake_complete_through: string | null;
  top_earner?: { username: string | null; rake: number } | null;
  data_updated_at?: string | null;
  generated_at: string;
}

export interface RakePeriod {
  key: PeriodKey;
  label: string;
  /** Short form for the dense mobile rail. */
  short: string;
}

export const RAKE_PERIODS: RakePeriod[] = [
  { key: 'today', label: 'Day', short: 'D' },
  { key: 'week', label: 'Week', short: 'W' },
  { key: 'month', label: 'Month', short: 'M' },
  { key: 'quarter', label: 'Quarter', short: 'Q' },
  { key: 'year', label: 'Year', short: 'Y' },
  { key: 'custom', label: 'Custom', short: '…' },
];

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Calendar periods, not rolling ones. An owner asking "this month" means the
 * month on the wall, not the last thirty days — the two disagree by up to a
 * third of the figure on the third of the month, and the wall calendar is what
 * the union settles against. UTC throughout, because the rollup these figures
 * come from is keyed on UTC days.
 */
export function periodToRange(
  key: PeriodKey,
  custom?: { start: string; end: string }
): { start: string; end: string } {
  const today = utcToday();
  const end = toISODate(today);

  if (key === 'custom') {
    const s = custom?.start || end;
    const e = custom?.end || end;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }
  if (key === 'today') return { start: end, end };
  if (key === 'yesterday') {
    const y = new Date(today);
    y.setUTCDate(y.getUTCDate() - 1);
    return { start: toISODate(y), end: toISODate(y) };
  }
  if (key === 'week') {
    // Monday-anchored, matching fn_union_week_start: the union's settlement
    // week is the week an operator is asking about.
    const d = new Date(today);
    const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
    d.setUTCDate(d.getUTCDate() - dow);
    return { start: toISODate(d), end };
  }
  if (key === 'month') {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { start: toISODate(d), end };
  }
  if (key === 'quarter') {
    const q = Math.floor(today.getUTCMonth() / 3) * 3;
    const d = new Date(Date.UTC(today.getUTCFullYear(), q, 1));
    return { start: toISODate(d), end };
  }
  // year
  const d = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  return { start: toISODate(d), end };
}

export function describeRakeSnapshotError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'Request failed');
  if (/not authorized for this union/i.test(msg)) {
    return 'Union figures are visible to union owners and union staff.';
  }
  if (/not authorized for this club/i.test(msg)) {
    return 'Club finances are visible to owners, admins, and super agents.';
  }
  if (/not_an_agent/i.test(msg)) return 'Downline rake is available once you hold an agent role.';
  if (/not_authorised|not_authorized/i.test(msg)) {
    return 'You can only read your own downline, or someone beneath you in it.';
  }
  if (/no union for this context/i.test(msg)) return 'This club does not belong to a union.';
  if (/permission denied/i.test(msg)) return 'You do not have permission to read that.';
  return safeErrorMessage(e, 'That snapshot could not be loaded.');
}

export const ClubRakeSnapshotService = {
  async get(opts: {
    scope: RakeScope;
    clubId?: string | null;
    unionId?: string | null;
    start: string;
    end: string;
    agentUserId?: string | null;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<RakeSnapshot> {
    let query = supabase.rpc('ca_rake_snapshot', {
      p_scope: opts.scope,
      p_club_id: opts.clubId ?? null,
      p_union_id: opts.unionId ?? null,
      p_start: opts.start,
      p_end: opts.end,
      p_agent_user_id: opts.agentUserId ?? null,
      p_limit: opts.limit ?? 50,
      p_offset: opts.offset ?? 0,
    });
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || typeof data !== 'object') {
      throw new Error('The snapshot returned no readable payload.');
    }
    const raw = data as Partial<RakeSnapshot>;
    return {
      ...raw,
      series: Array.isArray(raw.series) ? raw.series : [],
      breakdown: Array.isArray(raw.breakdown) ? raw.breakdown : [],
      // A payload from before paging existed carries neither field. Falling
      // back to the page length keeps "showing X of Y" honest rather than
      // rendering "of undefined" or claiming zero rows exist.
      breakdown_count: Number.isFinite(Number(raw.breakdown_count))
        ? Number(raw.breakdown_count)
        : Array.isArray(raw.breakdown)
          ? raw.breakdown.length
          : 0,
      breakdown_offset: Number.isFinite(Number(raw.breakdown_offset))
        ? Number(raw.breakdown_offset)
        : 0,
    } as RakeSnapshot;
  },
};
