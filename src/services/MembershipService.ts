/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Membership Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages club memberships, roles, and hierarchical permissions
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

import { supabase, isDemoMode } from '../lib/supabase';

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
    parentAgentId?: string; // For sub-agents under super_agent or agent
    notes?: string;

    // Computed
    displayName?: string;
    avatarUrl?: string;
    isOnline?: boolean;
    lastActiveAt?: string;
}

export interface MemberStats {
    handsPlayed: number;
    rakeGenerated: number;
    sessionsPlayed: number;
    biggestWin: number;
    biggestLoss: number;
    lastPlayedAt: string;
}

export interface RoleChange {
    memberId: string;
    oldRole: MemberRole;
    newRole: MemberRole;
    changedBy: string;
    changedAt: string;
    reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Role hierarchy for permission checks (higher = more authority)
const ROLE_HIERARCHY: Record<MemberRole, number> = {
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

// Role display names
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

// Demo members
const DEMO_MEMBERS: ClubMembership[] = [
    { id: 'm1', clubId: 'club_1', userId: 'user_1', role: 'club_owner', status: 'active', joinedAt: '2025-01-01', displayName: 'ClubOwner', isOnline: true },
    { id: 'm2', clubId: 'club_1', userId: 'user_2', role: 'club_admin', status: 'active', joinedAt: '2025-01-05', displayName: 'AdminBob', isOnline: true },
    { id: 'm3', clubId: 'club_1', userId: 'user_3', role: 'super_agent', status: 'active', joinedAt: '2025-01-08', displayName: 'SuperAgentX', isOnline: true },
    { id: 'm4', clubId: 'club_1', userId: 'user_4', role: 'agent', status: 'active', joinedAt: '2025-01-10', displayName: 'AgentAce', parentAgentId: 'user_3', isOnline: false },
    { id: 'm5', clubId: 'club_1', userId: 'user_5', role: 'sub_agent', status: 'active', joinedAt: '2025-01-12', displayName: 'SubAgentPro', parentAgentId: 'user_4', isOnline: false },
    { id: 'm6', clubId: 'club_1', userId: 'user_6', role: 'member', status: 'active', joinedAt: '2025-01-15', displayName: 'PlayerOne', agentId: 'user_4', isOnline: true },
    { id: 'm7', clubId: 'club_1', userId: 'user_7', role: 'member', status: 'pending', joinedAt: '2025-01-20', displayName: 'NewPlayer', isOnline: false },
];

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
    async getClubMembers(clubId: string, includeStats = false): Promise<ClubMembership[]> {
        if (isDemoMode) {
            return DEMO_MEMBERS.filter(m => m.clubId === clubId);
        }

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
        if (isDemoMode) {
            return DEMO_MEMBERS.find(m => m.clubId === clubId && m.userId === userId) || null;
        }

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
     * Get all clubs a user is a member of
     */
    async getUserMemberships(userId: string): Promise<ClubMembership[]> {
        if (isDemoMode) {
            return DEMO_MEMBERS.filter(m => m.userId === userId);
        }

        const { data, error } = await supabase
            .from('club_members')
            .select(`
                *,
                clubs:club_id (
                    id,
                    name,
                    avatar_url
                )
            `)
            .eq('user_id', userId)
            .eq('status', 'active');

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
        }));
    },

    /**
     * Add a new member to a club
     */
    async addMember(
        clubId: string,
        userId: string,
        role: MemberRole = 'member',
        invitedBy?: string,
        agentId?: string
    ): Promise<ClubMembership> {
        if (isDemoMode) {
            const newMember: ClubMembership = {
                id: `m_${Date.now()}`,
                clubId,
                userId,
                role,
                status: 'active',
                joinedAt: new Date().toISOString(),
                invitedBy,
                agentId,
            };
            DEMO_MEMBERS.push(newMember);
            return newMember;
        }

        const { data, error } = await supabase
            .from('club_members')
            .insert({
                club_id: clubId,
                user_id: userId,
                role,
                status: 'active',
                invited_by: invitedBy,
                agent_id: agentId,
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
            agentId: data.agent_id,
        };
    },

    /**
     * Request to join a club (creates pending membership)
     */
    async requestJoin(clubId: string, userId: string, message?: string): Promise<ClubMembership> {
        if (isDemoMode) {
            const newRequest: ClubMembership = {
                id: `m_${Date.now()}`,
                clubId,
                userId,
                role: 'guest',
                status: 'pending',
                joinedAt: new Date().toISOString(),
                notes: message,
            };
            DEMO_MEMBERS.push(newRequest);
            return newRequest;
        }

        const { data, error } = await supabase
            .from('club_members')
            .insert({
                club_id: clubId,
                user_id: userId,
                role: 'guest',
                status: 'pending',
                notes: message,
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
            notes: data.notes,
        };
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // MEMBERSHIP ACTIONS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Approve a pending membership request
     */
    async approveMembership(memberId: string, approvedBy: string): Promise<boolean> {
        if (isDemoMode) {
            const member = DEMO_MEMBERS.find(m => m.id === memberId);
            if (member) {
                member.status = 'active';
                member.role = 'member';
            }
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .update({ status: 'active', role: 'member' })
            .eq('id', memberId)
            .eq('status', 'pending');

        return !error;
    },

    /**
     * Reject a pending membership request
     */
    async rejectMembership(memberId: string, rejectedBy: string, reason?: string): Promise<boolean> {
        if (isDemoMode) {
            const idx = DEMO_MEMBERS.findIndex(m => m.id === memberId);
            if (idx !== -1) DEMO_MEMBERS.splice(idx, 1);
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .delete()
            .eq('id', memberId)
            .eq('status', 'pending');

        return !error;
    },

    /**
     * Change a member's role
     */
    async changeRole(memberId: string, newRole: MemberRole, changedBy: string, reason?: string): Promise<boolean> {
        if (isDemoMode) {
            const member = DEMO_MEMBERS.find(m => m.id === memberId);
            if (member) member.role = newRole;
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .update({ role: newRole })
            .eq('id', memberId);

        if (error) return false;

        // Log the role change
        await supabase.from('role_changes').insert({
            member_id: memberId,
            new_role: newRole,
            changed_by: changedBy,
            reason,
        });

        return true;
    },

    /**
     * Suspend a member (temporary ban)
     */
    async suspendMember(memberId: string, suspendedBy: string, reason: string, durationDays?: number): Promise<boolean> {
        if (isDemoMode) {
            const member = DEMO_MEMBERS.find(m => m.id === memberId);
            if (member) member.status = 'suspended';
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .update({
                status: 'suspended',
                notes: reason,
            })
            .eq('id', memberId);

        return !error;
    },

    /**
     * Ban a member (permanent)
     */
    async banMember(memberId: string, bannedBy: string, reason: string): Promise<boolean> {
        if (isDemoMode) {
            const member = DEMO_MEMBERS.find(m => m.id === memberId);
            if (member) member.status = 'banned';
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .update({
                status: 'banned',
                notes: reason,
            })
            .eq('id', memberId);

        return !error;
    },

    /**
     * Remove a member from the club
     */
    async removeMember(memberId: string, removedBy: string): Promise<boolean> {
        if (isDemoMode) {
            const idx = DEMO_MEMBERS.findIndex(m => m.id === memberId);
            if (idx !== -1) DEMO_MEMBERS.splice(idx, 1);
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .delete()
            .eq('id', memberId);

        return !error;
    },

    /**
     * Member leaves club voluntarily
     */
    async leaveClub(clubId: string, userId: string): Promise<boolean> {
        if (isDemoMode) {
            const idx = DEMO_MEMBERS.findIndex(m => m.clubId === clubId && m.userId === userId);
            if (idx !== -1) DEMO_MEMBERS.splice(idx, 1);
            return true;
        }

        const { error } = await supabase
            .from('club_members')
            .delete()
            .eq('club_id', clubId)
            .eq('user_id', userId);

        return !error;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // PERMISSION HELPERS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Check if a role has authority over another role
     */
    hasAuthorityOver(actorRole: MemberRole, targetRole: MemberRole): boolean {
        return ROLE_HIERARCHY[actorRole] > ROLE_HIERARCHY[targetRole];
    },

    /**
     * Check if a role can perform a specific action
     */
    canPerformAction(role: MemberRole, action: 'manage_members' | 'change_settings' | 'create_tables' | 'view_financials' | 'manage_agents' | 'assign_credit'): boolean {
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
     * Check if a role is an agent-level role
     */
    isAgentRole(role: MemberRole): boolean {
        return ['super_agent', 'agent', 'sub_agent'].includes(role);
    },

    /**
     * Check if a role can have sub-agents under them
     */
    canHaveSubAgents(role: MemberRole): boolean {
        return ['super_agent', 'agent'].includes(role);
    },

    /**
     * Get member count by status
     */
    async getMemberCounts(clubId: string): Promise<{ total: number; active: number; pending: number; online: number }> {
        if (isDemoMode) {
            const members = DEMO_MEMBERS.filter(m => m.clubId === clubId);
            return {
                total: members.length,
                active: members.filter(m => m.status === 'active').length,
                pending: members.filter(m => m.status === 'pending').length,
                online: members.filter(m => m.isOnline).length,
            };
        }

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
