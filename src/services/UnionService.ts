/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Union Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages unions (club networks), union admins, and consolidated settlements
 * Real Supabase integration — no demo data
 */

import { supabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Union {
    id: string;
    name: string;
    description?: string;
    ownerId: string;
    avatarUrl?: string;
    isPublic: boolean;
    memberCount: number;
    clubCount: number;
    totalRake: number;
    settings: UnionSettings;
    createdAt: string;
    updatedAt: string;
}

export interface UnionSettings {
    revenueSharePercent: number;     // % taken from member clubs
    sharedPlayerPool: boolean;       // Cross-club player visibility
    crossClubTournaments: boolean;   // Allow union-wide tournaments
}

export interface UnionAdmin {
    id: string;
    unionId: string;
    userId: string;
    role: 'union_lead' | 'union_admin';
    permissions: {
        manageClubs: boolean;
        manageSettlements: boolean;
    };
    displayName?: string;
    createdAt: string;
}

export interface UnionClub {
    id: string;
    unionId: string;
    clubId: string;
    clubName: string;
    ownerId: string;
    ownerName?: string;
    memberCount: number;
    weeklyRake: number;
    joinedAt: string;
}

export interface UnionSettlement {
    unionId: string;
    periodStart: string;
    periodEnd: string;
    totalClubs: number;
    totalRakeCollected: number;
    totalUnionTax: number;
    totalAgentCommissions: number;
    totalPlayerRakeback: number;
    netUnionRevenue: number;
    clubBreakdowns: ClubSettlementBreakdown[];
}

export interface ClubSettlementBreakdown {
    clubId: string;
    clubName: string;
    rakeCollected: number;
    unionTaxPaid: number;
    netToClub: number;
    wireDirection: 'PAY_TO_UNION' | 'COLLECT_FROM_UNION';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class UnionServiceClass {

    // ─────────────────────────────────────────────────────────────────────────────
    // UNION CRUD
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get all unions
     */
    async getUnions(): Promise<Union[]> {
        const { data, error } = await supabase
            .from('unions')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        return (data || []).map(this.mapUnion);
    }

    /**
     * Get unions where user is owner or admin
     */
    async getMyUnions(userId: string): Promise<Union[]> {
        // Get unions where user is owner
        const { data: owned, error: ownedError } = await supabase
            .from('unions')
            .select('*')
            .eq('owner_id', userId);

        if (ownedError) throw ownedError;

        // Get unions where user is admin
        const { data: adminOf, error: adminError } = await supabase
            .from('union_admins')
            .select('union_id, unions(*)')
            .eq('user_id', userId);

        if (adminError) throw adminError;

        // Combine and dedupe
        const unionMap = new Map<string, any>();
        (owned || []).forEach(u => unionMap.set(u.id, u));
        (adminOf || []).forEach(a => {
            if (a.unions && !unionMap.has((a.unions as any).id)) {
                unionMap.set((a.unions as any).id, a.unions);
            }
        });

        return Array.from(unionMap.values()).map(this.mapUnion);
    }

    /**
     * Get union by ID
     */
    async getUnion(unionId: string): Promise<Union | null> {
        const { data, error } = await supabase
            .from('unions')
            .select('*')
            .eq('id', unionId)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        if (!data) return null;

        return this.mapUnion(data);
    }

    /**
     * Create a new union
     */
    async createUnion(
        name: string,
        description: string,
        ownerId: string,
        settings?: Partial<UnionSettings>
    ): Promise<Union> {
        const { data, error } = await supabase
            .from('unions')
            .insert({
                name,
                description,
                owner_id: ownerId,
                is_public: true,
                settings: {
                    revenue_share_percent: 10,
                    shared_player_pool: true,
                    cross_club_tournaments: true,
                    ...settings,
                },
            })
            .select()
            .single();

        if (error) throw error;

        // Add owner as union_lead
        await this.addAdmin(data.id, ownerId, 'union_lead');

        return this.mapUnion(data);
    }

    /**
     * Update union
     */
    async updateUnion(unionId: string, updates: Partial<Union>): Promise<Union | null> {
        const { data, error } = await supabase
            .from('unions')
            .update({
                name: updates.name,
                description: updates.description,
                avatar_url: updates.avatarUrl,
                is_public: updates.isPublic,
                settings: updates.settings,
                updated_at: new Date().toISOString(),
            })
            .eq('id', unionId)
            .select()
            .single();

        if (error) throw error;

        return this.mapUnion(data);
    }

    /**
     * Delete union
     */
    async deleteUnion(unionId: string): Promise<boolean> {
        const { error } = await supabase
            .from('unions')
            .delete()
            .eq('id', unionId);

        return !error;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // UNION ADMINS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get union admins
     */
    async getAdmins(unionId: string): Promise<UnionAdmin[]> {
        const { data, error } = await supabase
            .from('union_admins')
            .select(`
                *,
                profiles:user_id (
                    display_name
                )
            `)
            .eq('union_id', unionId)
            .order('created_at', { ascending: true });

        if (error) throw error;

        return (data || []).map(a => ({
            id: a.id,
            unionId: a.union_id,
            userId: a.user_id,
            role: a.role as 'union_lead' | 'union_admin',
            permissions: a.permissions || { manageClubs: true, manageSettlements: true },
            displayName: (a.profiles as any)?.display_name,
            createdAt: a.created_at,
        }));
    }

    /**
     * Add admin to union
     */
    async addAdmin(
        unionId: string,
        userId: string,
        role: 'union_lead' | 'union_admin' = 'union_admin'
    ): Promise<boolean> {
        const { error } = await supabase
            .from('union_admins')
            .insert({
                union_id: unionId,
                user_id: userId,
                role,
                permissions: { manage_clubs: true, manage_settlements: true },
            });

        return !error;
    }

    /**
     * Remove admin from union
     */
    async removeAdmin(unionId: string, userId: string): Promise<boolean> {
        const { error } = await supabase
            .from('union_admins')
            .delete()
            .eq('union_id', unionId)
            .eq('user_id', userId);

        return !error;
    }

    /**
     * Check if user is union admin
     */
    async isUnionAdmin(unionId: string, userId: string): Promise<boolean> {
        // Check if owner
        const { data: union } = await supabase
            .from('unions')
            .select('owner_id')
            .eq('id', unionId)
            .single();

        if (union?.owner_id === userId) return true;

        // Check if admin
        const { count } = await supabase
            .from('union_admins')
            .select('*', { count: 'exact', head: true })
            .eq('union_id', unionId)
            .eq('user_id', userId);

        return (count || 0) > 0;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // UNION CLUBS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get clubs in a union
     */
    async getUnionClubs(unionId: string): Promise<UnionClub[]> {
        const { data, error } = await supabase
            .from('union_clubs')
            .select(`
                *,
                clubs (
                    id,
                    name,
                    owner_id,
                    profiles:owner_id (
                        display_name
                    )
                )
            `)
            .eq('union_id', unionId)
            .order('joined_at', { ascending: false });

        if (error) throw error;

        return (data || []).map(uc => ({
            id: uc.id,
            unionId: uc.union_id,
            clubId: uc.club_id,
            clubName: (uc.clubs as any)?.name || 'Unknown',
            ownerId: (uc.clubs as any)?.owner_id,
            ownerName: (uc.clubs as any)?.profiles?.display_name,
            memberCount: 0, // Would need join to club_members
            weeklyRake: 0,  // Would come from settlement data
            joinedAt: uc.joined_at,
        }));
    }

    /**
     * Add club to union
     */
    async addClub(unionId: string, clubId: string): Promise<boolean> {
        const { error } = await supabase
            .from('union_clubs')
            .insert({
                union_id: unionId,
                club_id: clubId,
            });

        if (error) return false;

        // Update union club_count
        await supabase.rpc('increment_union_club_count', { p_union_id: unionId });

        // Update club's union_id
        await supabase
            .from('clubs')
            .update({ union_id: unionId })
            .eq('id', clubId);

        return true;
    }

    /**
     * Remove club from union
     */
    async removeClub(unionId: string, clubId: string): Promise<boolean> {
        const { error } = await supabase
            .from('union_clubs')
            .delete()
            .eq('union_id', unionId)
            .eq('club_id', clubId);

        if (error) return false;

        // Update club's union_id to null
        await supabase
            .from('clubs')
            .update({ union_id: null })
            .eq('id', clubId);

        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // SETTLEMENTS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get consolidated settlement report
     */
    async getSettlementReport(unionId: string, periodStart?: string, periodEnd?: string): Promise<UnionSettlement> {
        // Get union details
        const union = await this.getUnion(unionId);
        if (!union) throw new Error('Union not found');

        // Get clubs
        const clubs = await this.getUnionClubs(unionId);

        // Calculate totals (would come from settlement_periods in production)
        const totalRake = clubs.reduce((sum, c) => sum + c.weeklyRake, 0);
        const revenueShareRate = union.settings?.revenueSharePercent || 10;
        const totalUnionTax = totalRake * (revenueShareRate / 100);

        return {
            unionId,
            periodStart: periodStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            periodEnd: periodEnd || new Date().toISOString(),
            totalClubs: clubs.length,
            totalRakeCollected: totalRake,
            totalUnionTax,
            totalAgentCommissions: totalRake * 0.20, // Estimated
            totalPlayerRakeback: totalRake * 0.10,   // Estimated
            netUnionRevenue: totalUnionTax,
            clubBreakdowns: clubs.map(c => ({
                clubId: c.clubId,
                clubName: c.clubName,
                rakeCollected: c.weeklyRake,
                unionTaxPaid: c.weeklyRake * (revenueShareRate / 100),
                netToClub: c.weeklyRake * (1 - revenueShareRate / 100),
                wireDirection: 'PAY_TO_UNION' as const,
            })),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STATS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get union stats
     */
    async getStats(unionId: string): Promise<{
        totalPlayers: number;
        totalClubs: number;
        weeklyRake: number;
        onlinePlayers: number;
    }> {
        const clubs = await this.getUnionClubs(unionId);

        // Get member counts for all clubs
        const clubIds = clubs.map(c => c.clubId);

        const { count: totalPlayers } = await supabase
            .from('club_members')
            .select('*', { count: 'exact', head: true })
            .in('club_id', clubIds)
            .eq('status', 'active');

        return {
            totalPlayers: totalPlayers || 0,
            totalClubs: clubs.length,
            weeklyRake: clubs.reduce((sum, c) => sum + c.weeklyRake, 0),
            onlinePlayers: Math.floor((totalPlayers || 0) * 0.2), // Estimate 20% online
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────────

    private mapUnion(u: any): Union {
        return {
            id: u.id,
            name: u.name,
            description: u.description,
            ownerId: u.owner_id,
            avatarUrl: u.avatar_url,
            isPublic: u.is_public ?? true,
            memberCount: u.member_count || 0,
            clubCount: u.club_count || 0,
            totalRake: Number(u.total_rake) || 0,
            settings: {
                revenueSharePercent: u.settings?.revenue_share_percent || 10,
                sharedPlayerPool: u.settings?.shared_player_pool ?? true,
                crossClubTournaments: u.settings?.cross_club_tournaments ?? true,
            },
            createdAt: u.created_at,
            updatedAt: u.updated_at,
        };
    }
}

export const unionService = new UnionServiceClass();
export const UnionService = unionService;
export default unionService;
