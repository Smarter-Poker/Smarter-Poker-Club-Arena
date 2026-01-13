/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Membership Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages club memberships, roles, and hierarchical permissions
 * 
 * ROLE HIERARCHY (Descending Authority):
 * 1. PLATFORM_ADMIN  → God mode (Smarter.Poker staff)
 * 2. UNION_LEAD      → Union owner, can manage all member clubs
 * 3. CLUB_OWNER      → Club creator with full club authority
 * 4. CLUB_ADMIN      → Delegated admin (can manage members, settings)
 * 5. AGENT           → Player referrer with commission tracking
 * 6. SUB_AGENT       → Under an agent, limited referral scope
 * 7. MEMBER          → Regular club member (can play)
 * 8. GUEST           → Trial access, limited features
 */

import { supabase, isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type MemberRole =
    | 'platform_admin'
    | 'union_lead'
    | 'club_owner'
    | 'club_admin'
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
    union_lead: 80,
    club_owner: 70,
    club_admin: 60,
    agent: 40,
    sub_agent: 30,
    member: 20,
    guest: 10,
};

// Demo members
const DEMO_MEMBERS: ClubMembership[] = [
    { id: 'm1', clubId: 'club_1', userId: 'user_1', role: 'club_owner', status: 'active', joinedAt: '2025-01-01', displayName: 'ClubOwner', isOnline: true },
    { id: 'm2', clubId: 'club_1', userId: 'user_2', role: 'club_admin', status: 'active', joinedAt: '2025-01-05', displayName: 'AdminBob', isOnline: true },
    { id: 'm3', clubId: 'club_1', userId: 'user_3', role: 'agent', status: 'active', joinedAt: '2025-01-10', displayName: 'AgentAce', agentId: 'agent_1', isOnline: false },
    { id: 'm4', clubId: 'club_1', userId: 'user_4', role: 'member', status: 'active', joinedAt: '2025-01-15', displayName: 'PlayerOne', agentId: 'agent_1', isOnline: true },
    { id: 'm5', clubId: 'club_1', userId: 'user_5', role: 'member', status: 'pending', joinedAt: '2025-01-20', displayName: 'NewPlayer', isOnline: false },
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
    canPerformAction(role: MemberRole, action: 'manage_members' | 'change_settings' | 'create_tables' | 'view_financials'): boolean {
        const permissions: Record<string, MemberRole[]> = {
            manage_members: ['platform_admin', 'union_lead', 'club_owner', 'club_admin'],
            change_settings: ['platform_admin', 'union_lead', 'club_owner', 'club_admin'],
            create_tables: ['platform_admin', 'union_lead', 'club_owner', 'club_admin', 'agent'],
            view_financials: ['platform_admin', 'union_lead', 'club_owner', 'club_admin', 'agent'],
        };

        return permissions[action]?.includes(role) ?? false;
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
