/**
 * AGENT RAKE SERVICE — live downline rake.
 *
 * Rake is generated continuously, and an agent needs to watch it as it happens
 * rather than waiting for the weekly statement. These reads go straight at
 * rake_records and use the SAME attribution as fn_rakeback_recompute_periods —
 * WEIGHTED CONTRIBUTED rake (Dan 2026-08-29): each player's credit is
 * proportional to their eligible contribution to the rakeable pot, with
 * historical DEALT_EQUAL rows still reported under their historical equal
 * split. So the live figure an agent sees is the figure they are eventually
 * paid on.
 *
 * Every function here is role-gated in the database: a plain player calling
 * them gets `not_an_agent`, and an agent asking for a peer's book gets
 * `not_authorised`. The UI gate is a convenience, not the control.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';

export interface AgentRoleRow {
  club_id: string;
  club_name: string | null;
  role: 'super_agent' | 'agent' | 'sub_agent';
  agent_id: string;
  is_overseer: boolean;
}

export interface DownlineRakeRow {
  player_id: string;
  username: string | null;
  club_id: string;
  club_name: string | null;
  role: string;
  depth: number;
  upline_user_id: string | null;
  upline_name: string | null;
  rake_generated: number;
  hands: number;
  last_hand_at: string | null;
  downline_players: number;
  downline_rake: number;
}

export interface DownlineRakeSummary {
  period_start: string;
  period_end: string;
  members: number;
  active: number;
  direct: number;
  sub_agents: number;
  hands: number;
  rake_generated: number;
  commission_rate: number;
  estimated_commission: number;
  last_hand_at: string | null;
  top_earner: { username: string | null; rake: number } | null;
}

/** Windows the UI offers. `null` start means "since the week began". */
export const RAKE_WINDOWS = [
  { key: 'today', label: 'Today', hours: null as number | null, today: true },
  { key: '24h', label: '24h', hours: 24 },
  { key: 'week', label: 'This Week', hours: null },
  { key: '30d', label: '30 Days', hours: 24 * 30 },
] as const;

export type RakeWindowKey = (typeof RAKE_WINDOWS)[number]['key'];

export function windowToRange(key: RakeWindowKey): { since: string | null; until: string | null } {
  const now = new Date();
  if (key === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { since: d.toISOString(), until: null };
  }
  if (key === '24h') {
    return { since: new Date(now.getTime() - 24 * 3600_000).toISOString(), until: null };
  }
  if (key === '30d') {
    return { since: new Date(now.getTime() - 30 * 24 * 3600_000).toISOString(), until: null };
  }
  return { since: null, until: null }; // 'week' → the function's own default
}

export function describeRakeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'Request failed');
  if (/not_an_agent/i.test(msg)) {
    return 'Rake reporting is available once you hold an agent role.';
  }
  if (/not_authorised|not_authorized/i.test(msg)) {
    return 'You can only view your own downline, or someone beneath you in it.';
  }
  if (/permission denied/i.test(msg)) return 'You do not have permission to do that.';
  // Unrecognised text is sanitised, never shown raw. See utils/safeErrorMessage.ts.
  return safeErrorMessage(e, 'That request could not be completed.');
}

/** Live rake channels, one per club, shared by every subscriber on the page. */
const rakeChannels = new Map<
  string,
  { channel: ReturnType<typeof supabase.channel>; listeners: Set<() => void> }
>();

export const AgentRakeService = {
  /** Agent roles the signed-in user holds. Empty → hide rake reporting entirely. */
  async getMyAgentRoles(): Promise<AgentRoleRow[]> {
    const { data, error } = await supabase.rpc('fn_my_agent_roles');
    if (error) {
      reportError(error, 'AgentRakeService.getMyAgentRoles');
      return [];
    }
    return (data ?? []) as AgentRoleRow[];
  },

  async getDownlineRake(opts: {
    agentUserId?: string;
    clubId?: string;
    since?: string | null;
    until?: string | null;
    search?: string;
    limit?: number;
  }): Promise<DownlineRakeRow[]> {
    const { data, error } = await supabase.rpc('fn_agent_downline_rake', {
      p_agent_user_id: opts.agentUserId ?? null,
      p_club_id: opts.clubId ?? null,
      p_since: opts.since ?? null,
      p_until: opts.until ?? null,
      p_search: opts.search?.trim() || null,
      p_limit: opts.limit ?? 500,
    });
    if (error) throw error;
    return (data ?? []) as DownlineRakeRow[];
  },

  async getDownlineRakeSummary(opts: {
    agentUserId?: string;
    clubId?: string;
    since?: string | null;
    until?: string | null;
  }): Promise<DownlineRakeSummary | null> {
    const { data, error } = await supabase.rpc('fn_agent_downline_rake_summary', {
      p_agent_user_id: opts.agentUserId ?? null,
      p_club_id: opts.clubId ?? null,
      p_since: opts.since ?? null,
      p_until: opts.until ?? null,
    });
    if (error) throw error;
    return (data ?? null) as DownlineRakeSummary | null;
  },

  /**
   * Live trigger, and it is NOT live. Returns an unsubscribe function.
   *
   * `rake_records` is deliberately NOT in the realtime publication - it would
   * broadcast every hand on the platform to every subscriber, which is both a
   * firehose and a cross-club data leak. That part still holds.
   *
   * What no longer holds is the next sentence, which said "agent_commissions is
   * published and is written as rake is earned, so it is the correct signal".
   * It was the correct signal, and it was published, until the 2026-09-06
   * publication trim: 1,802,610 writes against 6.7M live rows put it among the
   * eleven tables the trim keeps out. So this channel joins, reports SUBSCRIBED
   * and delivers nothing.
   *
   * The consumer is covered meanwhile: DownlineRakePanel wraps this in a 30s
   * poll it describes as a fallback "in case the socket drops", and that poll is
   * now the whole mechanism. Left in place rather than deleted because the
   * subscription is correct for a scoped carrier and the panel does not break
   * without it - but do not read this as a live feed.
   */
  subscribeToRake(clubId: string | undefined, onChange: () => void): () => void {
    /* ONE CHANNEL PER CLUB, SHARED. The name used to carry a random suffix, so
       every caller opened its own websocket subscription to the same
       postgres_changes filter and a page with three rake panels held three.
       Subscribers are counted; the channel is removed when the last one
       leaves and recreated by the next. */
    const key = clubId ?? 'all';
    let shared = rakeChannels.get(key);
    if (!shared) {
      const listeners = new Set<() => void>();
      const channel = supabase
        .channel(`downline-rake-${key}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'agent_commissions',
            ...(clubId ? { filter: `club_id=eq.${clubId}` } : {}),
          },
          () => listeners.forEach((fn) => fn())
        )
        .subscribe();
      shared = { channel, listeners };
      rakeChannels.set(key, shared);
    }
    shared.listeners.add(onChange);

    return () => {
      const current = rakeChannels.get(key);
      if (!current) return;
      current.listeners.delete(onChange);
      if (current.listeners.size === 0) {
        rakeChannels.delete(key);
        void supabase.removeChannel(current.channel);
      }
    };
  },
};

export default AgentRakeService;
