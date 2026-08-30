/**
 * CLUB ROSTER SERVICE
 * ============================================================================
 * The Players tab and everything it opens read through here.
 *
 * WHAT THIS REPLACES. ClubMembersPage used to assemble the roster itself, in
 * the component body: one select on club_members, then profiles fetched in
 * chunks of thirty because there is no foreign key between the two, then a
 * separate poll of `tables`, then a poll of `table_seats`, then a presence
 * channel -- five round trips and a 30 second timer to produce a list that
 * still had no downline counts, no wallets and no fees, because nothing on the
 * client could compute them.
 *
 * ca_club_members_overview answers all of it in one call, and does the parts
 * the client cannot: it walks the agent tree, it resolves a union to every club
 * beneath it, and it reads the seat table that RLS and the closed-tables bug
 * kept the page from seeing.
 *
 * NUMBERS ARRIVE AS STRINGS. PostgREST serialises `numeric` as a JSON string to
 * avoid the float precision loss that would come from a JS number -- a wallet
 * of 14428679.67 must not become 14428679.669999998. Every numeric column is
 * therefore run through `num()` on the way in, once, here, so no screen ever
 * does arithmetic on "0.00" and gets a string back.
 */

import { supabase } from '../lib/supabase';
import { normaliseRole, type ClubRole } from '../types/clubRoles';
import { reportError } from '../utils/errorReporter';

/** PostgREST hands back `numeric` as a string. Make it a number, exactly once. */
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface RosterMember {
  user_id: string;
  home_club_id: string | null;
  home_club_name: string | null;
  /** profiles.player_number. Guaranteed present by the 20260823_01 migration. */
  player_number: string | null;
  /** The Club Arena name. profiles.alias, with sane fallbacks. */
  alias: string;
  /** The account username. Lowercased by a database trigger; shown as-is. */
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: ClubRole;
  role_rank: number;
  is_online: boolean;
  /** Specifically "sitting at a live table", as opposed to merely connected. */
  is_seated: boolean;
  chip_balance: number;
  player_wallet: number;
  agent_wallet: number;
  promo_wallet: number;
  /** Total rake this member has generated. */
  total_fees: number;
  downline_fees: number;
  total_hands: number;
  downline_direct: number;
  downline_total: number;
  upline_user_id: string | null;
  upline_name: string | null;
  joined_at: string | null;
  last_login: string | null;
  nickname: string | null;
  remark: string | null;
}

/**
 * Exported so the page's sessionStorage cache can be run through the SAME
 * defaulting the network path gets. A blob written by an earlier build (before
 * a field existed) used to be cast straight to RosterMember and rendered, and
 * the first `.toLocaleString()` on the missing field white-screened the tab on
 * every load until the user closed it.
 */
export function mapRosterRow(row: Record<string, unknown>): RosterMember {
  return {
    user_id: String(row.user_id ?? ''),
    home_club_id: (row.home_club_id as string) ?? null,
    home_club_name: (row.home_club_name as string) ?? null,
    player_number: (row.player_number as string) ?? null,
    alias: (row.alias as string) || 'Unknown',
    username: (row.username as string) || '',
    display_name: (row.display_name as string) || '',
    avatar_url: (row.avatar_url as string) || null,
    role: normaliseRole(row.role),
    role_rank: num(row.role_rank),
    is_online: row.is_online === true,
    is_seated: row.is_seated === true,
    chip_balance: num(row.chip_balance),
    player_wallet: num(row.player_wallet),
    agent_wallet: num(row.agent_wallet),
    promo_wallet: num(row.promo_wallet),
    total_fees: num(row.total_fees),
    downline_fees: num(row.downline_fees),
    total_hands: num(row.total_hands),
    downline_direct: num(row.downline_direct),
    downline_total: num(row.downline_total),
    upline_user_id: (row.upline_user_id as string) ?? null,
    upline_name: (row.upline_name as string) ?? null,
    joined_at: (row.joined_at as string) ?? null,
    last_login: (row.last_login as string) ?? null,
    nickname: (row.nickname as string) ?? null,
    remark: (row.remark as string) ?? null,
  };
}

export interface MemberRange {
  /** ISO date, yyyy-mm-dd. Both null means Overall (lifetime). */
  from: string | null;
  to: string | null;
}

export const RANGE_OVERALL: MemberRange = { from: null, to: null };

/** The last N days inclusive of today, as the RPCs want it. */
export function lastDaysRange(days: number): MemberRange {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to) };
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface MemberDetail {
  identity: {
    user_id: string | null;
    player_number: string | null;
    alias: string | null;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    role: ClubRole;
    role_rank: number;
    nickname: string | null;
    remark: string | null;
    last_login: string | null;
    joined_at: string | null;
    home_club_id: string | null;
    home_club_name: string | null;
    upline_user_id: string | null;
    upline_name: string | null;
    upline_player_number: string | null;
  };
  presence: { is_online: boolean; is_seated: boolean };
  wallets: {
    chip_balance: number;
    player_wallet: number;
    agent_wallet: number;
    promo_wallet: number;
  };
  downline: { downline_direct: number; downline_total: number };
  stats: {
    hands: number;
    mtt_hands: number;
    total_fee: number;
    mtt_fee: number;
    claimed_back: number;
    sent_out: number;
    total_winnings: number;
    mtt_winnings: number;
  };
  range: { from: string | null; to: string | null; is_overall: boolean };
}

export interface MemberStatistics {
  variant: string;
  variants: string[];
  total_games: number;
  total_hands: number;
  wins: number;
  winner: number;
  vpip: number;
  pfr: number;
  three_bet: number;
  cbet: number;
  net: number;
  fees: number;
  from: string | null;
  to: string | null;
  is_overall: boolean;
}

export interface DownlineMember {
  user_id: string;
  player_number: string | null;
  alias: string;
  username: string;
  role: ClubRole;
  role_rank: number;
  depth: number;
  chip_balance: number;
  total_fees: number;
  is_online: boolean;
}

export const ClubRosterService = {
  /**
   * The whole Players tab in one call. `clubId` must already be a UUID --
   * callers resolve a slug with utils/clubIdResolver first, because this
   * service has no opinion about routing.
   */
  async getRoster(clubId: string): Promise<RosterMember[]> {
    const { data, error } = await supabase.rpc('ca_club_members_overview', {
      p_club_id: clubId,
    });
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => mapRosterRow(row));
  },

  /**
   * Nudge the fee rollup forward. Fire and forget: the roster is perfectly
   * usable with fees a minute stale, and the RPC self-throttles to one advance
   * every thirty seconds however many members have the tab open. A failure here
   * must never surface to the user or block the render, so it is swallowed
   * after being reported.
   */
  touchFeeRollup(): void {
    void supabase
      .rpc('ca_touch_member_fee_rollup')
      .then(({ error }) => {
        if (error) reportError(error.message, 'ClubRosterService.touchFeeRollup');
      })
      .then(undefined, (err: unknown) => reportError(err, 'ClubRosterService.touchFeeRollup'));
  },

  async getMemberDetail(
    clubId: string,
    userId: string,
    range: MemberRange = RANGE_OVERALL
  ): Promise<MemberDetail> {
    const { data, error } = await supabase.rpc('ca_club_member_detail', {
      p_club_id: clubId,
      p_user_id: userId,
      p_from: range.from,
      p_to: range.to,
    });
    if (error) throw error;
    const d = (data ?? {}) as Record<string, any>;
    // The RPC already guarantees numbers rather than strings and zeros rather
    // than nulls, but a missing member returns an object with null identity, so
    // every field is still defaulted here rather than trusted.
    return {
      identity: {
        user_id: d.identity?.user_id ?? null,
        player_number: d.identity?.player_number ?? null,
        alias: d.identity?.alias ?? null,
        username: d.identity?.username ?? null,
        display_name: d.identity?.display_name ?? null,
        avatar_url: d.identity?.avatar_url ?? null,
        role: normaliseRole(d.identity?.role),
        role_rank: num(d.identity?.role_rank),
        nickname: d.identity?.nickname ?? null,
        remark: d.identity?.remark ?? null,
        last_login: d.identity?.last_login ?? null,
        joined_at: d.identity?.joined_at ?? null,
        home_club_id: d.identity?.home_club_id ?? null,
        home_club_name: d.identity?.home_club_name ?? null,
        upline_user_id: d.identity?.upline_user_id ?? null,
        upline_name: d.identity?.upline_name ?? null,
        upline_player_number: d.identity?.upline_player_number ?? null,
      },
      presence: {
        is_online: d.presence?.is_online === true,
        is_seated: d.presence?.is_seated === true,
      },
      wallets: {
        chip_balance: num(d.wallets?.chip_balance),
        player_wallet: num(d.wallets?.player_wallet),
        agent_wallet: num(d.wallets?.agent_wallet),
        promo_wallet: num(d.wallets?.promo_wallet),
      },
      downline: {
        downline_direct: num(d.downline?.downline_direct),
        downline_total: num(d.downline?.downline_total),
      },
      stats: {
        hands: num(d.stats?.hands),
        mtt_hands: num(d.stats?.mtt_hands),
        total_fee: num(d.stats?.total_fee),
        mtt_fee: num(d.stats?.mtt_fee),
        claimed_back: num(d.stats?.claimed_back),
        sent_out: num(d.stats?.sent_out),
        total_winnings: num(d.stats?.total_winnings),
        mtt_winnings: num(d.stats?.mtt_winnings),
      },
      range: {
        from: d.range?.from ?? null,
        to: d.range?.to ?? null,
        is_overall: d.range?.is_overall !== false,
      },
    };
  },

  async getMemberStatistics(
    clubId: string,
    userId: string,
    variant: string | null = null,
    range: MemberRange = RANGE_OVERALL
  ): Promise<MemberStatistics> {
    const { data, error } = await supabase.rpc('ca_club_member_statistics', {
      p_club_id: clubId,
      p_user_id: userId,
      p_variant: variant,
      p_from: range.from,
      p_to: range.to,
    });
    if (error) throw error;
    const d = (data ?? {}) as Record<string, any>;
    return {
      variant: d.variant ?? 'all',
      variants: Array.isArray(d.variants) ? d.variants.filter(Boolean) : [],
      total_games: num(d.total_games),
      total_hands: num(d.total_hands),
      wins: num(d.wins),
      winner: num(d.winner),
      vpip: num(d.vpip),
      pfr: num(d.pfr),
      three_bet: num(d.three_bet),
      cbet: num(d.cbet),
      net: num(d.net),
      fees: num(d.fees),
      from: d.from ?? null,
      to: d.to ?? null,
      is_overall: d.is_overall !== false,
    };
  },

  async getDownline(clubId: string, userId: string): Promise<DownlineMember[]> {
    const { data, error } = await supabase.rpc('ca_club_member_downline', {
      p_club_id: clubId,
      p_user_id: userId,
    });
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      user_id: String(row.user_id ?? ''),
      player_number: (row.player_number as string) ?? null,
      alias: (row.alias as string) || 'Unknown',
      username: (row.username as string) || '',
      role: normaliseRole(row.role),
      role_rank: num(row.role_rank),
      depth: num(row.depth),
      chip_balance: num(row.chip_balance),
      total_fees: num(row.total_fees),
      is_online: row.is_online === true,
    }));
  },
};

export default ClubRosterService;
