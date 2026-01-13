/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Membership Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages club memberships, roles, and hierarchical permissions
 * Real Supabase integration — no demo mode
 * 
 * ROLE HIERARCHY (Descending Authority):
 * 1. PLATFORM_ADMIN  → God mode (Smarter.Poker staff)
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
        const { data, error } = await supabase
            .from('club_members')
            .select(`
                id,
                club_id,
                user_id,
                role,
                status,
                joined_at,
                invited_by,
                agent_id,
                notes,
                profiles:user_id (
                    display_name,
                    avatar_url
                )
            `)
            .eq('club_id', clubId)
            .order('joined_at', { ascending: false });

        if (error) throw error;

        return (data || []).map(m => ({
            id: m.id,
            clubId: m.club_id,
            userId: m.user_id,
            role: m.role as MemberRole,
            status: m.status as MemberStatus,
            joinedAt: m.joined_at,
            invitedBy: m.invited_by,
            agentId: m.agent_id,
            notes: m.notes,
            displayName: (m.profiles as any)?.display_name,
            avatarUrl: (m.profiles as any)?.avatar_url,
        }));
    },

    /**
     * Get a user's membership in a specific club
     */
    async getMembership(clubId: string, userId: string): Promise<ClubMembership | null> {
        const { data, error } = await supabase
            .from('club_members')
            .select('*')
            .eq('club_id', clubId)
            .eq('user_id', userId)
            .single();

        if (error || !data) return null;

        return {
            id: data.id,
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
            .single();

        if (error) throw error;

        return {
            id: data.id,
            clubId: data.club_id,
            userId: data.user_id,
            role: data.role as MemberRole,
            status: data.status as MemberStatus,
            joinedAt: data.joined_at,
            invitedBy: data.invited_by,
        };
    },

    /**
     * Update member role
     */
    async updateRole(memberId: string, newRole: MemberRole): Promise<boolean> {
        const { error } = await supabase
            .from('club_members')
            .update({ role: newRole })
            .eq('id', memberId);

        return !error;
    },

    /**
     * Update member status
     */
    async updateStatus(memberId: string, status: MemberStatus): Promise<boolean> {
        const { error } = await supabase
            .from('club_members')
            .update({ status })
            .eq('id', memberId);

        return !error;
    },

    /**
     * Remove member from club
     */
    async removeMember(memberId: string): Promise<boolean> {
        const { error } = await supabase
            .from('club_members')
            .delete()
            .eq('id', memberId);

        return !error;
    },

    /**
     * Get members eligible for promotion to agent
     */
    async getEligibleForPromotion(clubId: string): Promise<ClubMembership[]> {
        const { data, error } = await supabase
            .from('club_members')
            .select(`
                id,
                club_id,
                user_id,
                role,
                status,
                joined_at,
                profiles:user_id (
                    display_name,
                    avatar_url
                )
            `)
            .eq('club_id', clubId)
            .eq('status', 'active')
            .in('role', ['member', 'guest'])
            .order('joined_at', { ascending: false });

        if (error) throw error;

        return (data || []).map(m => ({
            id: m.id,
            clubId: m.club_id,
            userId: m.user_id,
            role: m.role as MemberRole,
            status: m.status as MemberStatus,
            joinedAt: m.joined_at,
            displayName: (m.profiles as any)?.display_name || 'Unknown',
            avatarUrl: (m.profiles as any)?.avatar_url,
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
        action: 'manage_members' | 'change_settings' | 'create_tables' | 'view_financials' | 'manage_agents' | 'assign_credit'
    ): boolean {
        const permissions: Record<string, MemberRole[]> = {
            manage_members: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin'],
            change_settings: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin'],
            create_tables: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin', 'super_agent', 'agent'],
            view_financials: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin', 'super_agent', 'agent'],
            manage_agents: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin', 'super_agent'],
            assign_credit: ['platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin', 'super_agent', 'agent'],
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
    async getMemberCounts(clubId: string): Promise<{ total: number; active: number; pending: number; online: number }> {
        const { count: total } = await supabase
            .from('club_members')
            .select('*', { count: 'exact', head: true })
            .eq('club_id', clubId);

        const { count: active } = await supabase
            .from('club_members')
            .select('*', { count: 'exact', head: true })
            .eq('club_id', clubId)
            .eq('status', 'active');

        const { count: pending } = await supabase
            .from('club_members')
            .select('*', { count: 'exact', head: true })
            .eq('club_id', clubId)
            .eq('status', 'pending');

        return {
            total: total || 0,
            active: active || 0,
            pending: pending || 0,
            online: 0, // Would come from presence system
        };
    },
};

export default MembershipService;
