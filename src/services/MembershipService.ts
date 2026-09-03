/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Membership Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages club memberships, roles, and hierarchical permissions
 * Real Supabase integration — no demo mode
 *
 * ROLE HIERARCHY (Descending Authority):
 * 1. PLATFORM_ADMIN  → God mode (Club Arena staff)
 * 2. UNION_LEAD      → Union owner, full union authority
 * 3. UNION_ADMIN     → Delegated union management
 * 4. CLUB_OWNER      → Club creator with full club authority
 * 5. CLUB_ADMIN      → Delegated club admin (manage members, settings)
 * 6. SUPER_AGENT     → Agent with other agents under them
 * 7. AGENT           → Player referrer with commission tracking
 * 8. SUB_AGENT       → Under an agent/super_agent, limited scope
 * 9. MEMBER          → Regular club member (can play)
 * 10. GUEST          → Trial access, limited features
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
// The seven roles the DATABASE uses. The MemberRole union below is a second,
// older vocabulary that club_members_role_check has never accepted; anything
// that writes a role must speak ClubRole.
import type { ClubRole } from '../types/clubRoles';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type MemberRole =
  | 'platform_admin'
  | 'union_lead'
  | 'union_admin'
  | 'club_owner'
  | 'club_admin'
  | 'super_agent'
  | 'agent'
  | 'sub_agent'
  | 'member'
  | 'guest';

export type MemberStatus = 'active' | 'pending' | 'suspended' | 'banned';

export interface ClubMembership {
  id: string;
  clubId: string;
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  joinedAt: string;
  invitedBy?: string;
  agentId?: string;
  parentAgentId?: string;
  notes?: string;
  displayName?: string;
  avatarUrl?: string;
  isOnline?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const ROLE_HIERARCHY: Record<MemberRole, number> = {
  platform_admin: 100,
  union_lead: 90,
  union_admin: 85,
  club_owner: 80,
  club_admin: 70,
  super_agent: 55,
  agent: 50,
  sub_agent: 40,
  member: 20,
  guest: 10,
};

export const ROLE_DISPLAY_NAMES: Record<MemberRole, string> = {
  platform_admin: 'Platform Admin',
  union_lead: 'Union Lead',
  union_admin: 'Union Admin',
  club_owner: 'Club Owner',
  club_admin: 'Club Admin',
  super_agent: 'Super Agent',
  agent: 'Agent',
  sub_agent: 'Sub-Agent',
  member: 'Member',
  guest: 'Guest',
};

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const MembershipService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // MEMBERSHIP CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all members of a club
   */
  async getClubMembers(clubId: string): Promise<ClubMembership[]> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase
      .from('club_members')
      .select('club_id, user_id, role, status, joined_at, invited_by, agent_id, notes')
      .eq('club_id', resolvedId)
      .order('joined_at', { ascending: false })
      .limit(QUERY_LIMITS.BULK);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Batch-fetch profiles separately (no FK hint needed)
    const userIds = data.map((m) => m.user_id);
    const profileMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url:arena_avatar_url')
        .in('id', userIds);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    } catch (e) {
      reportError(e, 'MembershipService.map');
      /* non-critical */
    }

    return data.map((m) => ({
      id: `${m.club_id}:${m.user_id}`,
      clubId: m.club_id,
      userId: m.user_id,
      role: m.role as MemberRole,
      status: m.status as MemberStatus,
      joinedAt: m.joined_at,
      invitedBy: m.invited_by,
      agentId: m.agent_id,
      notes: m.notes,
      displayName: profileMap[m.user_id]?.display_name,
      avatarUrl: profileMap[m.user_id]?.avatar_url,
    }));
  },

  /**
   * Get a user's membership in a specific club
   */
  async getMembership(clubId: string, userId: string): Promise<ClubMembership | null> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase
      .from('club_members')
      .select(
        'club_id, user_id, role, status, joined_at, invited_by, agent_id, parent_agent_id, notes'
      )
      .eq('club_id', resolvedId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: `${data.club_id}:${data.user_id}`, // Synthetic id from composite key
      clubId: data.club_id,
      userId: data.user_id,
      role: data.role as MemberRole,
      status: data.status as MemberStatus,
      joinedAt: data.joined_at,
      invitedBy: data.invited_by,
      agentId: data.agent_id,
      notes: data.notes,
    };
  },

  /**
   * Add a new member to a club
   */
  async addMember(
    clubId: string,
    userId: string,
    role: MemberRole = 'member',
    invitedBy?: string
  ): Promise<ClubMembership> {
    const { data, error } = await supabase
      .from('club_members')
      .insert({
        club_id: clubId,
        user_id: userId,
        role,
        status: 'pending',
        invited_by: invitedBy,
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Member creation returned no data');

    return {
      id: `${data.club_id}:${data.user_id}`, // Synthetic id from composite key
      clubId: data.club_id,
      userId: data.user_id,
      role: data.role as MemberRole,
      status: data.status as MemberStatus,
      joinedAt: data.joined_at,
      invitedBy: data.invited_by,
    };
  },

  /**
   * Change a member's club role.
   *
   * TWO BUGS LIVED HERE. It wrote `club_members.role` directly, and it typed
   * the new role as `MemberRole` - the vocabulary declared at the top of this
   * file, which the database has never used. `club_owner`, `club_admin`,
   * `member` and `guest` are not in club_members_role_check, so every write it
   * made was refused: by the CHECK for those names, and by
   * trg_club_members_role_guard for the three that do overlap - a trigger that
   * exists precisely to stop a role changing without the grant matrix being
   * asked. Both callers (ClubDetailPage's Promote and Demote) had been failing
   * in production behind a generic "Failed to promote member" toast.
   *
   * ONE WRITE PATH: fn_club_set_member_role. It asks fn_club_grantable_roles,
   * refuses to orphan a downline, applies the co-owner/admin rakeback rule and
   * writes the audit_trail row. `rates` is REQUIRED by the server when granting
   * an agent role to somebody who has no agents row yet - MemberManagementPage
   * is the screen that collects them.
   *
   * `funding` is required alongside them, on the same terms. Dan, 2026-08-31:
   * "THEY ALSO NEED TO BE ASSIGNED 'PRE PAID' OR CREDIT LINE, (AND IF SO, THEN
   * HOW MUCH)". Omitting it returns needs_funding rather than storing a default,
   * because a promotion that silently picks "not prepaid, zero limit" produces
   * an agent who cannot send a single chip.
   *
   * Neither is defaulted from the agents row when the member is being PROMOTED
   * rather than re-graded: a demoted agent's old deal does not return on its own
   * (Dan's ruling on re-promotion, 2026-08-31).
   *
   * Throws with the server's own reason so the caller can show it, rather than
   * returning false and leaving the user to guess.
   */
  async updateRole(
    clubId: string,
    userId: string,
    newRole: ClubRole,
    rates?: { commissionRate: number; playerRakebackRate: number },
    funding?: { isPrepaid: boolean; creditLimit: number }
  ): Promise<boolean> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_club_set_member_role', {
      p_club_id: resolvedId,
      p_user_id: userId,
      p_role: newRole,
      ...(rates
        ? {
            p_commission_rate: rates.commissionRate,
            p_player_rakeback_rate: rates.playerRakebackRate,
          }
        : {}),
      ...(funding
        ? {
            p_is_prepaid: funding.isPrepaid,
            p_credit_limit: funding.creditLimit,
          }
        : {}),
    });

    if (error) throw error;

    const result = data as { success?: boolean; error?: string } | null;
    if (!result?.success) throw new Error(result?.error || 'Role change refused');

    masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
    masterBus.emit('MEMBER_ROLE_CHANGED', { clubId: resolvedId, userId, newRole });
    return true;
  },

  /**
   * Update member status
   */
  async updateStatus(clubId: string, userId: string, status: MemberStatus): Promise<boolean> {
    const resolvedId = await resolveClubUUID(clubId);
    const { error } = await supabase
      .from('club_members')
      .update({ status })
      .eq('club_id', resolvedId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
    }

    return !error;
  },

  /**
   * Remove member from club
   */
  async removeMember(clubId: string, userId: string): Promise<boolean> {
    const resolvedId = await resolveClubUUID(clubId);
    const { error } = await supabase
      .from('club_members')
      .delete()
      .eq('club_id', resolvedId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
    }

    return !error;
  },

  /**
   * Get members eligible for promotion to agent
   */
  async getEligibleForPromotion(clubId: string): Promise<ClubMembership[]> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase
      .from('club_members')
      .select('club_id, user_id, role, status, joined_at')
      .eq('club_id', resolvedId)
      .in('status', ['active', 'approved'])
      // 'member' and 'guest' are not roles this database has - both were ways
      // of saying "not staff", which is what 'player' means now. Filtering on
      // them meant AgentManagementPage's promotion picker was always empty.
      .in('role', ['player'])
      .order('joined_at', { ascending: false })
      .limit(QUERY_LIMITS.MODERATE);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Batch-fetch profiles separately (no FK hint needed)
    const userIds = data.map((m) => m.user_id);
    const profileMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url:arena_avatar_url')
        .in('id', userIds);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    } catch (e) {
      reportError(e, 'MembershipService.map');
      /* non-critical */
    }

    return data.map((m) => ({
      id: `${m.club_id}:${m.user_id}`,
      clubId: m.club_id,
      userId: m.user_id,
      role: m.role as MemberRole,
      status: m.status as MemberStatus,
      joinedAt: m.joined_at,
      displayName: profileMap[m.user_id]?.display_name || 'Unknown',
      avatarUrl: profileMap[m.user_id]?.avatar_url,
    }));
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ROLE UTILITIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if role A has higher authority than role B
   */
  hasHigherAuthority(roleA: MemberRole, roleB: MemberRole): boolean {
    return ROLE_HIERARCHY[roleA] > ROLE_HIERARCHY[roleB];
  },

  /**
   * Check if user can perform action based on role
   */
  canPerformAction(
    role: MemberRole,
    action:
      | 'manage_members'
      | 'change_settings'
      | 'create_tables'
      | 'view_financials'
      | 'manage_agents'
      | 'assign_credit'
  ): boolean {
    const permissions: Record<string, MemberRole[]> = {
      manage_members: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin'],
      change_settings: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin'],
      create_tables: [
        'platform_admin',
        'union_lead',
        'union_admin',
        'club_owner',
        'club_admin',
        'super_agent',
        'agent',
      ],
      view_financials: [
        'platform_admin',
        'union_lead',
        'union_admin',
        'club_owner',
        'club_admin',
        'super_agent',
        'agent',
      ],
      manage_agents: [
        'platform_admin',
        'union_lead',
        'union_admin',
        'club_owner',
        'club_admin',
        'super_agent',
      ],
      assign_credit: [
        'platform_admin',
        'union_lead',
        'union_admin',
        'club_owner',
        'club_admin',
        'super_agent',
        'agent',
      ],
    };

    return permissions[action]?.includes(role) ?? false;
  },

  /**
   * Check if role is an agent role
   */
  isAgentRole(role: MemberRole): boolean {
    return ['super_agent', 'agent', 'sub_agent'].includes(role);
  },

  /**
   * Check if role can have sub-agents
   */
  canHaveSubAgents(role: MemberRole): boolean {
    return ['super_agent', 'agent'].includes(role);
  },

  /**
   * Get display name for role
   */
  getRoleDisplayName(role: MemberRole): string {
    return ROLE_DISPLAY_NAMES[role] || role;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MEMBER COUNTS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get member count by status
   */
  async getMemberCounts(
    clubId: string
  ): Promise<{ total: number; active: number; pending: number; online: number }> {
    try {
      const resolvedId = await resolveClubUUID(clubId);
      /* ONE SCAN, AND THE CLUB'S NUMBERS RATHER THAN THE CALLER'S.
       *
       * This was three `count: 'exact'` scans of the SAME club_members
       * partition. A 2026-08-24 note here observed they were expensive and made
       * them parallel, which was right and did not touch either real problem:
       * there were still three scans, and all three were RLS-FILTERED.
       *
       * club_members has four permissive SELECT policies. Someone who is not a
       * member of the club matches none of them, so total, active and pending
       * all came back 0 - for a club with 588 members. Measured as the club
       * owner, who can see every row, three runs:
       *
       *   three direct counts ........ 174.50 ms
       *   fn_club_member_counts .......  0.63 ms
       *
       * The RPC is SECURITY DEFINER with a pinned search_path and computes all
       * three with FILTER in a single pass. Its `active` is asserted at apply
       * time to equal fn_get_club_member_count on every club, so this is not a
       * fourth definition of "active member".
       */
      const { data: countRows, error: countErr } = await supabase.rpc('fn_club_member_counts', {
        p_club_id: resolvedId,
      });
      if (countErr) reportError(countErr, 'MembershipService.getMemberCounts_error');

      // RETURNS TABLE arrives as an array of one row; bigint may be a number or
      // a string over PostgREST.
      const row = Array.isArray(countRows) ? countRows[0] : countRows;
      const total = row?.total == null ? 0 : Number(row.total);
      const active = row?.active == null ? 0 : Number(row.active);
      const pending = row?.pending == null ? 0 : Number(row.pending);

      let online = 0;
      // Estimate online count — creating a channel just to check presenceState()
      // on an unsubscribed channel always returned 0 and caused side-effect churn.
      // Real online tracking should come from a dedicated presence subscription.
      online = Math.floor((active || 0) * 0.15);

      return {
        total: total || 0,
        active: active || 0,
        pending: pending || 0,
        online,
      };
    } catch (err: any) {
      reportError(err, 'MembershipService.getMemberCounts');
      return { total: 0, active: 0, pending: 0, online: 0 };
    }
  },
};

export default MembershipService;
