/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔐 PERMISSION SERVICE — Multi-Level Admin System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Hierarchical permission system for Club Arena.
 *
 * HIERARCHY (Highest to Lowest):
 * 1. PLATFORM_ADMIN — Smarter.Poker super admins (full system access)
 * 2. UNION_ADMIN — Union owners (manage union + all member clubs)
 * 3. CLUB_OWNER — Club owners (manage their club, agents, players)
 * 4. AGENT — Club agents (manage their downline players)
 * 5. PLAYER — Regular players (self-management only)
 *
 * PERMISSIONS:
 * - Each level inherits all permissions of lower levels
 * - Context-aware: ClubOwner in Club A cannot manage Club B
 */

import { supabase, isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AdminLevel = 'PLATFORM_ADMIN' | 'UNION_ADMIN' | 'CLUB_OWNER' | 'AGENT' | 'PLAYER';

export type Permission =
    // Platform Admin Only
    | 'SYSTEM_SETTINGS'
    | 'VIEW_ALL_CLUBS'
    | 'VIEW_ALL_UNIONS'
    | 'MANAGE_PLATFORM_ADMINS'
    | 'GLOBAL_BAN'
    | 'FREEZE_SETTLEMENTS'
    | 'EMERGENCY_SHUTDOWN'
    // Union Admin
    | 'CREATE_UNION'
    | 'MANAGE_UNION'
    | 'INVITE_CLUBS_TO_UNION'
    | 'REMOVE_CLUBS_FROM_UNION'
    | 'VIEW_UNION_SETTLEMENTS'
    | 'APPROVE_UNION_SETTLEMENTS'
    // Club Owner
    | 'CREATE_CLUB'
    | 'MANAGE_CLUB_SETTINGS'
    | 'MANAGE_CLUB_AGENTS'
    | 'MANAGE_CLUB_MEMBERS'
    | 'CREATE_TABLES'
    | 'CREATE_TOURNAMENTS'
    | 'VIEW_CLUB_FINANCIALS'
    | 'MINT_CHIPS'
    | 'SET_COMMISSION_RATES'
    | 'VIEW_SECURITY_LOGS'
    | 'BAN_FROM_CLUB'
    // Agent
    | 'INVITE_PLAYERS'
    | 'MANAGE_DOWNLINE'
    | 'DISTRIBUTE_CHIPS'
    | 'VIEW_AGENT_REPORTS'
    | 'SET_PLAYER_RAKEBACK'
    | 'EXTEND_CREDIT'
    // Player
    | 'JOIN_TABLES'
    | 'JOIN_TOURNAMENTS'
    | 'VIEW_OWN_HISTORY'
    | 'MANAGE_OWN_PROFILE'
    | 'TRANSFER_CHIPS'
    | 'ADD_FRIENDS';

export interface UserPermissions {
    userId: string;
    level: AdminLevel;
    permissions: Permission[];
    contexts: {
        platformAdmin?: boolean;
        unionIds?: string[];
        clubIds?: string[];
        agentForClubIds?: string[];
    };
}

export interface PermissionCheck {
    allowed: boolean;
    reason?: string;
    requiredLevel?: AdminLevel;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const LEVEL_PERMISSIONS: Record<AdminLevel, Permission[]> = {
    PLATFORM_ADMIN: [
        'SYSTEM_SETTINGS', 'VIEW_ALL_CLUBS', 'VIEW_ALL_UNIONS',
        'MANAGE_PLATFORM_ADMINS', 'GLOBAL_BAN', 'FREEZE_SETTLEMENTS', 'EMERGENCY_SHUTDOWN',
        // Inherits all below
        'CREATE_UNION', 'MANAGE_UNION', 'INVITE_CLUBS_TO_UNION', 'REMOVE_CLUBS_FROM_UNION',
        'VIEW_UNION_SETTLEMENTS', 'APPROVE_UNION_SETTLEMENTS',
        'CREATE_CLUB', 'MANAGE_CLUB_SETTINGS', 'MANAGE_CLUB_AGENTS', 'MANAGE_CLUB_MEMBERS',
        'CREATE_TABLES', 'CREATE_TOURNAMENTS', 'VIEW_CLUB_FINANCIALS', 'MINT_CHIPS',
        'SET_COMMISSION_RATES', 'VIEW_SECURITY_LOGS', 'BAN_FROM_CLUB',
        'INVITE_PLAYERS', 'MANAGE_DOWNLINE', 'DISTRIBUTE_CHIPS', 'VIEW_AGENT_REPORTS',
        'SET_PLAYER_RAKEBACK', 'EXTEND_CREDIT',
        'JOIN_TABLES', 'JOIN_TOURNAMENTS', 'VIEW_OWN_HISTORY', 'MANAGE_OWN_PROFILE',
        'TRANSFER_CHIPS', 'ADD_FRIENDS',
    ],
    UNION_ADMIN: [
        'CREATE_UNION', 'MANAGE_UNION', 'INVITE_CLUBS_TO_UNION', 'REMOVE_CLUBS_FROM_UNION',
        'VIEW_UNION_SETTLEMENTS', 'APPROVE_UNION_SETTLEMENTS',
        // Inherits club owner + below
        'CREATE_CLUB', 'MANAGE_CLUB_SETTINGS', 'MANAGE_CLUB_AGENTS', 'MANAGE_CLUB_MEMBERS',
        'CREATE_TABLES', 'CREATE_TOURNAMENTS', 'VIEW_CLUB_FINANCIALS', 'MINT_CHIPS',
        'SET_COMMISSION_RATES', 'VIEW_SECURITY_LOGS', 'BAN_FROM_CLUB',
        'INVITE_PLAYERS', 'MANAGE_DOWNLINE', 'DISTRIBUTE_CHIPS', 'VIEW_AGENT_REPORTS',
        'SET_PLAYER_RAKEBACK', 'EXTEND_CREDIT',
        'JOIN_TABLES', 'JOIN_TOURNAMENTS', 'VIEW_OWN_HISTORY', 'MANAGE_OWN_PROFILE',
        'TRANSFER_CHIPS', 'ADD_FRIENDS',
    ],
    CLUB_OWNER: [
        'CREATE_CLUB', 'MANAGE_CLUB_SETTINGS', 'MANAGE_CLUB_AGENTS', 'MANAGE_CLUB_MEMBERS',
        'CREATE_TABLES', 'CREATE_TOURNAMENTS', 'VIEW_CLUB_FINANCIALS', 'MINT_CHIPS',
        'SET_COMMISSION_RATES', 'VIEW_SECURITY_LOGS', 'BAN_FROM_CLUB',
        // Inherits agent + player
        'INVITE_PLAYERS', 'MANAGE_DOWNLINE', 'DISTRIBUTE_CHIPS', 'VIEW_AGENT_REPORTS',
        'SET_PLAYER_RAKEBACK', 'EXTEND_CREDIT',
        'JOIN_TABLES', 'JOIN_TOURNAMENTS', 'VIEW_OWN_HISTORY', 'MANAGE_OWN_PROFILE',
        'TRANSFER_CHIPS', 'ADD_FRIENDS',
    ],
    AGENT: [
        'INVITE_PLAYERS', 'MANAGE_DOWNLINE', 'DISTRIBUTE_CHIPS', 'VIEW_AGENT_REPORTS',
        'SET_PLAYER_RAKEBACK', 'EXTEND_CREDIT',
        // Inherits player
        'JOIN_TABLES', 'JOIN_TOURNAMENTS', 'VIEW_OWN_HISTORY', 'MANAGE_OWN_PROFILE',
        'TRANSFER_CHIPS', 'ADD_FRIENDS',
    ],
    PLAYER: [
        'JOIN_TABLES', 'JOIN_TOURNAMENTS', 'VIEW_OWN_HISTORY', 'MANAGE_OWN_PROFILE',
        'TRANSFER_CHIPS', 'ADD_FRIENDS',
    ],
};

const LEVEL_HIERARCHY: AdminLevel[] = ['PLATFORM_ADMIN', 'UNION_ADMIN', 'CLUB_OWNER', 'AGENT', 'PLAYER'];

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_USER_ROLES: Map<string, UserPermissions> = new Map([
    ['admin_1', {
        userId: 'admin_1',
        level: 'PLATFORM_ADMIN',
        permissions: LEVEL_PERMISSIONS.PLATFORM_ADMIN,
        contexts: { platformAdmin: true },
    }],
    ['union_owner_1', {
        userId: 'union_owner_1',
        level: 'UNION_ADMIN',
        permissions: LEVEL_PERMISSIONS.UNION_ADMIN,
        contexts: { unionIds: ['union_1', 'union_2'] },
    }],
    ['club_owner_1', {
        userId: 'club_owner_1',
        level: 'CLUB_OWNER',
        permissions: LEVEL_PERMISSIONS.CLUB_OWNER,
        contexts: { clubIds: ['club_1'] },
    }],
    ['agent_1', {
        userId: 'agent_1',
        level: 'AGENT',
        permissions: LEVEL_PERMISSIONS.AGENT,
        contexts: { agentForClubIds: ['club_1'] },
    }],
]);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const PermissionService = {
    // ─────────────────────────────────────────────────────────────────────────────
    // USER PERMISSIONS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get user's permissions and contexts
     */
    async getUserPermissions(userId: string): Promise<UserPermissions> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 100));
            return DEMO_USER_ROLES.get(userId) || {
                userId,
                level: 'PLAYER',
                permissions: LEVEL_PERMISSIONS.PLAYER,
                contexts: {},
            };
        }

        // 1. Check if platform admin
        const { data: profile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .single();

        if (profile?.role === 'super_admin' || profile?.role === 'admin') {
            return {
                userId,
                level: 'PLATFORM_ADMIN',
                permissions: LEVEL_PERMISSIONS.PLATFORM_ADMIN,
                contexts: { platformAdmin: true },
            };
        }

        // 2. Check if union admin
        const { data: ownedUnions } = await supabase
            .from('unions')
            .select('id')
            .eq('owner_id', userId);

        if (ownedUnions && ownedUnions.length > 0) {
            return {
                userId,
                level: 'UNION_ADMIN',
                permissions: LEVEL_PERMISSIONS.UNION_ADMIN,
                contexts: { unionIds: ownedUnions.map(u => u.id) },
            };
        }

        // 3. Check if club owner
        const { data: ownedClubs } = await supabase
            .from('clubs')
            .select('id')
            .eq('owner_id', userId);

        if (ownedClubs && ownedClubs.length > 0) {
            return {
                userId,
                level: 'CLUB_OWNER',
                permissions: LEVEL_PERMISSIONS.CLUB_OWNER,
                contexts: { clubIds: ownedClubs.map(c => c.id) },
            };
        }

        // 4. Check if agent
        const { data: agentRecords } = await supabase
            .from('agents')
            .select('club_id')
            .eq('user_id', userId);

        if (agentRecords && agentRecords.length > 0) {
            return {
                userId,
                level: 'AGENT',
                permissions: LEVEL_PERMISSIONS.AGENT,
                contexts: { agentForClubIds: agentRecords.map(a => a.club_id) },
            };
        }

        // 5. Default to player
        return {
            userId,
            level: 'PLAYER',
            permissions: LEVEL_PERMISSIONS.PLAYER,
            contexts: {},
        };
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // PERMISSION CHECKS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Check if user has a specific permission
     */
    async hasPermission(userId: string, permission: Permission): Promise<boolean> {
        const userPerms = await this.getUserPermissions(userId);
        return userPerms.permissions.includes(permission);
    },

    /**
     * Check permission with detailed result
     */
    async checkPermission(userId: string, permission: Permission): Promise<PermissionCheck> {
        const userPerms = await this.getUserPermissions(userId);

        if (userPerms.permissions.includes(permission)) {
            return { allowed: true };
        }

        // Find required level
        let requiredLevel: AdminLevel = 'PLATFORM_ADMIN';
        for (const level of LEVEL_HIERARCHY) {
            if (LEVEL_PERMISSIONS[level].includes(permission)) {
                requiredLevel = level;
                break;
            }
        }

        return {
            allowed: false,
            reason: `Requires ${requiredLevel} access. You are: ${userPerms.level}`,
            requiredLevel,
        };
    },

    /**
     * Check if user can manage a specific club
     */
    async canManageClub(userId: string, clubId: string): Promise<boolean> {
        const userPerms = await this.getUserPermissions(userId);

        // Platform admin can manage any club
        if (userPerms.contexts.platformAdmin) return true;

        // Union admin can manage clubs in their unions
        if (userPerms.contexts.unionIds && userPerms.contexts.unionIds.length > 0) {
            if (isDemoMode) return true; // Simplify for demo

            const { data } = await supabase
                .from('union_members')
                .select('union_id')
                .eq('club_id', clubId)
                .in('union_id', userPerms.contexts.unionIds);

            if (data && data.length > 0) return true;
        }

        // Club owner can manage their own clubs
        if (userPerms.contexts.clubIds?.includes(clubId)) return true;

        return false;
    },

    /**
     * Check if user can manage a specific union
     */
    async canManageUnion(userId: string, unionId: string): Promise<boolean> {
        const userPerms = await this.getUserPermissions(userId);

        if (userPerms.contexts.platformAdmin) return true;
        if (userPerms.contexts.unionIds?.includes(unionId)) return true;

        return false;
    },

    /**
     * Check if user is at or above a certain admin level
     */
    isAtLeastLevel(userLevel: AdminLevel, requiredLevel: AdminLevel): boolean {
        const userIndex = LEVEL_HIERARCHY.indexOf(userLevel);
        const requiredIndex = LEVEL_HIERARCHY.indexOf(requiredLevel);
        return userIndex <= requiredIndex; // Lower index = higher level
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // ROLE MANAGEMENT (Platform Admin Only)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Promote user to platform admin (Platform Admin only)
     */
    async promoteToAdmin(adminUserId: string, targetUserId: string): Promise<boolean> {
        const adminPerms = await this.getUserPermissions(adminUserId);
        if (!adminPerms.permissions.includes('MANAGE_PLATFORM_ADMINS')) {
            throw new Error('Only Platform Admins can promote other admins');
        }

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const { error } = await supabase
            .from('profiles')
            .update({ role: 'admin' })
            .eq('id', targetUserId);

        if (error) throw error;
        return true;
    },

    /**
     * Demote user from platform admin (Platform Admin only)
     */
    async demoteFromAdmin(adminUserId: string, targetUserId: string): Promise<boolean> {
        const adminPerms = await this.getUserPermissions(adminUserId);
        if (!adminPerms.permissions.includes('MANAGE_PLATFORM_ADMINS')) {
            throw new Error('Only Platform Admins can demote other admins');
        }

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const { error } = await supabase
            .from('profiles')
            .update({ role: 'user' })
            .eq('id', targetUserId);

        if (error) throw error;
        return true;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get all permissions for a level
     */
    getPermissionsForLevel(level: AdminLevel): Permission[] {
        return LEVEL_PERMISSIONS[level];
    },

    /**
     * Get display name for level
     */
    getLevelDisplayName(level: AdminLevel): string {
        const names: Record<AdminLevel, string> = {
            PLATFORM_ADMIN: 'Platform Administrator',
            UNION_ADMIN: 'Union Administrator',
            CLUB_OWNER: 'Club Owner',
            AGENT: 'Agent',
            PLAYER: 'Player',
        };
        return names[level];
    },

    /**
     * Get level color for UI
     */
    getLevelColor(level: AdminLevel): string {
        const colors: Record<AdminLevel, string> = {
            PLATFORM_ADMIN: '#FF5733', // Red/Orange
            UNION_ADMIN: '#9B59B6', // Purple
            CLUB_OWNER: '#3498DB', // Blue
            AGENT: '#2ECC71', // Green
            PLAYER: '#95A5A6', // Gray
        };
        return colors[level];
    },
};

export default PermissionService;
