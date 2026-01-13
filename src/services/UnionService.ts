/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🏛️ UNION SERVICE — Multi-Club Network Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages unions (networks of clubs) with:
 * - Union CRUD operations
 * - Club membership management
 * - Cross-club settlement consolidation
 * - Union-wide statistics and reporting
 */

import { supabase, isDemoMode } from '../lib/supabase';
import { SettlementService } from './SettlementService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Union {
    id: string;
    name: string;
    description: string;
    owner_id: string;
    created_at: string;
    member_count: number;
    club_count: number;
    online_count: number;
    logo_url?: string;
    status: 'active' | 'pending' | 'suspended';
    settings?: UnionSettings;
}

export interface UnionSettings {
    taxRate: number; // Union's cut from clubs (default 10%)
    minRakeShare: number;
    requireApproval: boolean;
    allowCrossClubPlay: boolean;
}

export interface UnionClub {
    club_id: string;
    union_id: string;
    club_name: string;
    club_owner: string;
    member_count: number;
    joined_at: string;
    status: 'active' | 'pending';
    weeklyRake?: number;
    weeklyPlayers?: number;
}

export interface UnionConsolidatedReport {
    unionId: string;
    periodId: string;
    periodStart: string;
    periodEnd: string;

    // Aggregate metrics
    totalClubs: number;
    totalPlayers: number;
    totalHandsDealt: number;

    // Financial
    totalRakeCollected: number;
    totalUnionTax: number;
    totalAgentCommissions: number;
    totalPlayerRakeback: number;
    netUnionRevenue: number;

    // Per-club breakdown
    clubBreakdowns: UnionClubBreakdown[];
}

export interface UnionClubBreakdown {
    clubId: string;
    clubName: string;
    rakeCollected: number;
    unionTaxPaid: number;
    playerCount: number;
    handsDealt: number;
    netToClub: number;
    wireDirection: 'PAY_TO_UNION' | 'COLLECT_FROM_UNION';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_UNIONS: Union[] = [
    {
        id: 'u1',
        name: 'Global Poker Union',
        description: 'The largest poker union worldwide. 24/7 action at all stakes.',
        owner_id: 'user_1',
        created_at: '2024-01-15T00:00:00Z',
        member_count: 12500,
        club_count: 45,
        online_count: 2340,
        status: 'active',
        logo_url: '🌐',
        settings: { taxRate: 0.10, minRakeShare: 0.05, requireApproval: true, allowCrossClubPlay: true },
    },
    {
        id: 'u2',
        name: 'High Stakes Network',
        description: 'Premium network for serious mid-to-high stakes players.',
        owner_id: 'user_2',
        created_at: '2024-03-10T00:00:00Z',
        member_count: 890,
        club_count: 12,
        online_count: 234,
        status: 'active',
        logo_url: '💎',
        settings: { taxRate: 0.08, minRakeShare: 0.05, requireApproval: true, allowCrossClubPlay: true },
    },
    {
        id: 'u3',
        name: 'Tournament Alliance',
        description: 'Daily tournaments with massive guaranteed prize pools.',
        owner_id: 'user_3',
        created_at: '2024-06-20T00:00:00Z',
        member_count: 5600,
        club_count: 28,
        online_count: 890,
        status: 'active',
        logo_url: '🏆',
        settings: { taxRate: 0.12, minRakeShare: 0.05, requireApproval: false, allowCrossClubPlay: true },
    },
];

const DEMO_UNION_CLUBS: UnionClub[] = [
    { club_id: 'c1', union_id: 'u1', club_name: 'Diamond Club', club_owner: 'Alice', member_count: 120, joined_at: '2025-01-01', status: 'active', weeklyRake: 15000, weeklyPlayers: 89 },
    { club_id: 'c2', union_id: 'u1', club_name: 'Spade Social', club_owner: 'Bob', member_count: 85, joined_at: '2025-01-05', status: 'active', weeklyRake: 8500, weeklyPlayers: 45 },
    { club_id: 'c3', union_id: 'u1', club_name: 'River Rats', club_owner: 'Charlie', member_count: 200, joined_at: '2025-01-10', status: 'active', weeklyRake: 22000, weeklyPlayers: 156 },
    { club_id: 'c4', union_id: 'u2', club_name: "Whale's Den", club_owner: 'Dave', member_count: 40, joined_at: '2025-02-01', status: 'active', weeklyRake: 45000, weeklyPlayers: 28 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class UnionServiceClass {
    // ─────────────────────────────────────────────────────────────────────────────
    // BASIC CRUD
    // ─────────────────────────────────────────────────────────────────────────────

    async getUnions(): Promise<Union[]> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return DEMO_UNIONS;
        }

        const { data, error } = await supabase
            .from('unions')
            .select('*')
            .order('member_count', { ascending: false });

        if (error) throw error;
        return data.map(this.mapUnion);
    }

    async getUnionById(unionId: string): Promise<Union | null> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 300));
            return DEMO_UNIONS.find(u => u.id === unionId) || null;
        }

        const { data, error } = await supabase
            .from('unions')
            .select('*')
            .eq('id', unionId)
            .single();

        if (error) return null;
        return this.mapUnion(data);
    }

    async createUnion(name: string, description: string, ownerId: string, settings?: Partial<UnionSettings>): Promise<Union | null> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 800));
            const newUnion: Union = {
                id: `u${Date.now()}`,
                name,
                description,
                owner_id: ownerId,
                created_at: new Date().toISOString(),
                member_count: 1,
                club_count: 1,
                online_count: 0,
                status: 'active',
                logo_url: '🆕',
                settings: {
                    taxRate: settings?.taxRate ?? 0.10,
                    minRakeShare: settings?.minRakeShare ?? 0.05,
                    requireApproval: settings?.requireApproval ?? true,
                    allowCrossClubPlay: settings?.allowCrossClubPlay ?? true,
                },
            };
            DEMO_UNIONS.push(newUnion);
            return newUnion;
        }

        const { data, error } = await supabase
            .from('unions')
            .insert({
                name,
                description,
                owner_id: ownerId,
                settings,
            })
            .select()
            .single();

        if (error) throw error;
        return this.mapUnion(data);
    }

    async updateUnion(unionId: string, updates: Partial<Union>): Promise<Union | null> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 400));
            const union = DEMO_UNIONS.find(u => u.id === unionId);
            if (union) {
                Object.assign(union, updates);
                return union;
            }
            return null;
        }

        const { data, error } = await supabase
            .from('unions')
            .update(updates)
            .eq('id', unionId)
            .select()
            .single();

        if (error) throw error;
        return this.mapUnion(data);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CLUB MEMBERSHIP
    // ─────────────────────────────────────────────────────────────────────────────

    async getUnionClubs(unionId: string): Promise<UnionClub[]> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 400));
            return DEMO_UNION_CLUBS.filter(uc => uc.union_id === unionId);
        }

        const { data, error } = await supabase
            .from('union_members')
            .select(`
        club_id,
        union_id,
        joined_at,
        status,
        clubs (
          name,
          owner_id,
          member_count
        )
      `)
            .eq('union_id', unionId);

        if (error) throw error;
        return data.map((um: any) => ({
            club_id: um.club_id,
            union_id: um.union_id,
            club_name: um.clubs?.name || 'Unknown',
            club_owner: um.clubs?.owner_id || 'Unknown',
            member_count: um.clubs?.member_count || 0,
            joined_at: um.joined_at,
            status: um.status,
        }));
    }

    async joinUnion(unionId: string, clubId: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 600));
            return true;
        }

        const union = await this.getUnionById(unionId);
        const status = union?.settings?.requireApproval ? 'pending' : 'active';

        const { error } = await supabase
            .from('union_members')
            .insert({
                union_id: unionId,
                club_id: clubId,
                status,
            });

        if (error) throw error;
        return true;
    }

    async leaveUnion(unionId: string, clubId: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 400));
            return true;
        }

        const { error } = await supabase
            .from('union_members')
            .delete()
            .eq('union_id', unionId)
            .eq('club_id', clubId);

        if (error) throw error;
        return true;
    }

    async approveClub(unionId: string, clubId: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const club = DEMO_UNION_CLUBS.find(c => c.club_id === clubId && c.union_id === unionId);
            if (club) club.status = 'active';
            return true;
        }

        const { error } = await supabase
            .from('union_members')
            .update({ status: 'active' })
            .eq('union_id', unionId)
            .eq('club_id', clubId);

        if (error) throw error;
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // SETTLEMENT CONSOLIDATION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Generate consolidated settlement report for a union
     */
    async getConsolidatedReport(unionId: string, periodId?: string): Promise<UnionConsolidatedReport> {
        const union = await this.getUnionById(unionId);
        const clubs = await this.getUnionClubs(unionId);
        const period = periodId
            ? await SettlementService.getPeriodHistory(1).then(p => p[0])
            : await SettlementService.getCurrentPeriod();

        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 600));

            const taxRate = union?.settings?.taxRate ?? 0.10;
            const clubBreakdowns: UnionClubBreakdown[] = clubs.map(club => {
                const rake = club.weeklyRake || 10000;
                const tax = rake * taxRate;
                return {
                    clubId: club.club_id,
                    clubName: club.club_name,
                    rakeCollected: rake,
                    unionTaxPaid: tax,
                    playerCount: club.weeklyPlayers || 50,
                    handsDealt: Math.floor((club.weeklyPlayers || 50) * 100),
                    netToClub: rake - tax,
                    wireDirection: 'PAY_TO_UNION' as const,
                };
            });

            const totalRake = clubBreakdowns.reduce((sum, c) => sum + c.rakeCollected, 0);
            const totalTax = clubBreakdowns.reduce((sum, c) => sum + c.unionTaxPaid, 0);

            return {
                unionId,
                periodId: period.id,
                periodStart: period.startAt,
                periodEnd: period.endAt,
                totalClubs: clubs.length,
                totalPlayers: clubBreakdowns.reduce((sum, c) => sum + c.playerCount, 0),
                totalHandsDealt: clubBreakdowns.reduce((sum, c) => sum + c.handsDealt, 0),
                totalRakeCollected: totalRake,
                totalUnionTax: totalTax,
                totalAgentCommissions: totalRake * 0.30,
                totalPlayerRakeback: totalRake * 0.15,
                netUnionRevenue: totalTax,
                clubBreakdowns,
            };
        }

        // Real implementation would aggregate from club_settlements table
        const { data, error } = await supabase.rpc('get_union_consolidated_report', {
            p_union_id: unionId,
            p_period_id: periodId || period.id,
        });

        if (error) throw error;
        return data;
    }

    /**
     * Calculate inter-club wires for the union
     */
    async calculateUnionWires(unionId: string, periodId?: string): Promise<UnionClubBreakdown[]> {
        const report = await this.getConsolidatedReport(unionId, periodId);
        return report.clubBreakdowns;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // STATISTICS
    // ─────────────────────────────────────────────────────────────────────────────

    async getUnionStats(unionId: string): Promise<{
        totalPlayers: number;
        activeTables: number;
        weeklyRake: number;
        weeklyHandsDealt: number;
    }> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 300));
            return {
                totalPlayers: 12500,
                activeTables: 45,
                weeklyRake: 125000,
                weeklyHandsDealt: 156000,
            };
        }

        const { data, error } = await supabase.rpc('get_union_stats', {
            p_union_id: unionId,
        });

        if (error) throw error;
        return data;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────────

    private mapUnion(u: any): Union {
        return {
            id: u.id,
            name: u.name,
            description: u.description,
            owner_id: u.owner_id,
            created_at: u.created_at,
            member_count: u.member_count || 0,
            club_count: u.club_count || 0,
            online_count: u.online_count || 0,
            logo_url: u.logo_url,
            status: u.status,
            settings: u.settings,
        };
    }
}

export const unionService = new UnionServiceClass();
export const UnionService = unionService;
