/**
 * ♠ CLUB ARENA — Club Service
 * Manages clubs, memberships, and club operations
 */

import { supabase, isDemoMode } from '../lib/supabase';
import type { Club, ClubMember, ClubSettings, MemberRole } from '../types/database.types';

// Demo data for offline mode
const DEMO_CLUBS: Club[] = [
    {
        id: '1',
        club_id: 123456,
        name: 'Ace High Club',
        description: 'Premier poker club for serious players. High stakes action daily.',
        avatar_url: null,
        owner_id: 'demo-user',
        is_public: true,
        requires_approval: false,
        gps_restricted: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        settings: {
            default_rake_percent: 5,
            rake_cap: 15,
            time_bank_seconds: 30,
            allow_straddle: true,
            allow_run_it_twice: true,
            min_buy_in_bb: 40,
            max_buy_in_bb: 200,
        },
    },
    {
        id: '2',
        club_id: 789012,
        name: 'Diamond League',
        description: 'Exclusive club for premium players.',
        avatar_url: null,
        owner_id: 'other-user',
        is_public: true,
        requires_approval: true,
        gps_restricted: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        settings: {
            default_rake_percent: 4,
            rake_cap: 20,
            time_bank_seconds: 45,
            allow_straddle: true,
            allow_run_it_twice: true,
            min_buy_in_bb: 50,
            max_buy_in_bb: 300,
        },
    },
];

class ClubService {
    // ═══════════════════════════════════════════════════════════════════════════════
    // Club Operations
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Get all clubs the current user is a member of
     */
    async getMyClubs(userId: string): Promise<Club[]> {
        if (isDemoMode) {
            return DEMO_CLUBS;
        }

        const { data, error } = await supabase
            .from('club_members')
            .select('club_id, clubs(*)')
            .eq('user_id', userId)
            .eq('status', 'active');

        if (error) throw error;
        return (data || []).map((m) => m.clubs as unknown as Club);
    }

    /**
     * Get a single club by ID
     */
    async getClub(clubId: string): Promise<Club | null> {
        if (isDemoMode) {
            return DEMO_CLUBS.find((c) => c.id === clubId) || null;
        }

        const { data, error } = await supabase
            .from('clubs')
            .select('*')
            .eq('id', clubId)
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Get club by 6-digit public ID
     */
    async getClubByPublicId(publicId: number): Promise<Club | null> {
        if (isDemoMode) {
            return DEMO_CLUBS.find((c) => c.club_id === publicId) || null;
        }

        const { data, error } = await supabase
            .from('clubs')
            .select('*')
            .eq('club_id', publicId)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return data;
    }

    /**
     * Search public clubs
     */
    async searchClubs(query: string): Promise<Club[]> {
        if (isDemoMode) {
            return DEMO_CLUBS.filter((c) =>
                c.name.toLowerCase().includes(query.toLowerCase())
            );
        }

        const { data, error } = await supabase
            .from('clubs')
            .select('*')
            .eq('is_public', true)
            .ilike('name', `%${query}%`)
            .limit(20);

        if (error) throw error;
        return data || [];
    }

    /**
     * Create a new club
     */
    async createClub(
        ownerId: string,
        name: string,
        description: string,
        settings: Partial<ClubSettings> = {}
    ): Promise<Club> {
        if (isDemoMode) {
            const newClub: Club = {
                id: crypto.randomUUID(),
                club_id: Math.floor(100000 + Math.random() * 900000),
                name,
                description,
                avatar_url: null,
                owner_id: ownerId,
                is_public: true,
                requires_approval: false,
                gps_restricted: false,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                settings: {
                    default_rake_percent: 5,
                    rake_cap: 15,
                    time_bank_seconds: 30,
                    allow_straddle: true,
                    allow_run_it_twice: true,
                    min_buy_in_bb: 40,
                    max_buy_in_bb: 200,
                    ...settings,
                },
            };
            DEMO_CLUBS.push(newClub);
            return newClub;
        }

        // Generate unique 6-digit club ID
        const clubId = Math.floor(100000 + Math.random() * 900000);

        const { data, error } = await supabase
            .from('clubs')
            .insert({
                club_id: clubId,
                name,
                description,
                owner_id: ownerId,
                settings: {
                    default_rake_percent: 5,
                    rake_cap: 15,
                    time_bank_seconds: 30,
                    allow_straddle: true,
                    allow_run_it_twice: true,
                    min_buy_in_bb: 40,
                    max_buy_in_bb: 200,
                    ...settings,
                },
            })
            .select()
            .single();

        if (error) throw error;

        // Auto-add owner as a member
        await this.addMember(data.id, ownerId, 'owner');

        return data;
    }

    /**
     * Update club settings
     */
    async updateClub(clubId: string, updates: Partial<Club>): Promise<Club> {
        if (isDemoMode) {
            const idx = DEMO_CLUBS.findIndex((c) => c.id === clubId);
            if (idx !== -1) {
                DEMO_CLUBS[idx] = { ...DEMO_CLUBS[idx], ...updates };
                return DEMO_CLUBS[idx];
            }
            throw new Error('Club not found');
        }

        const { data, error } = await supabase
            .from('clubs')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', clubId)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Membership Operations
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Get all members of a club
     */
    async getMembers(clubId: string): Promise<ClubMember[]> {
        if (isDemoMode) {
            return [
                {
                    id: '1',
                    club_id: clubId,
                    user_id: 'demo-user',
                    role: 'owner',
                    nickname: 'Player123',
                    chip_balance: 50000,
                    joined_at: new Date().toISOString(),
                    status: 'active',
                    agent_id: null,
                },
                {
                    id: '2',
                    club_id: clubId,
                    user_id: 'user-2',
                    role: 'agent',
                    nickname: 'AceMaster',
                    chip_balance: 25000,
                    joined_at: new Date().toISOString(),
                    status: 'active',
                    agent_id: null,
                },
            ];
        }

        const { data, error } = await supabase
            .from('club_members')
            .select('*')
            .eq('club_id', clubId)
            .order('role', { ascending: true });

        if (error) throw error;
        return data || [];
    }

    /**
     * Add a member to a club
     */
    async addMember(
        clubId: string,
        userId: string,
        role: MemberRole = 'member'
    ): Promise<ClubMember> {
        if (isDemoMode) {
            return {
                id: crypto.randomUUID(),
                club_id: clubId,
                user_id: userId,
                role,
                nickname: null,
                chip_balance: 0,
                joined_at: new Date().toISOString(),
                status: 'active',
                agent_id: null,
            };
        }

        const { data, error } = await supabase
            .from('club_members')
            .insert({
                club_id: clubId,
                user_id: userId,
                role,
                status: role === 'owner' ? 'active' : 'pending',
                chip_balance: 0,
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Request to join a club
     */
    async requestJoin(clubId: string, userId: string): Promise<ClubMember> {
        const club = await this.getClub(clubId);
        if (!club) throw new Error('Club not found');

        const status = club.requires_approval ? 'pending' : 'active';
        return this.addMember(clubId, userId, 'member');
    }

    /**
     * Approve or reject a membership request
     */
    async handleMembershipRequest(
        memberId: string,
        approved: boolean
    ): Promise<void> {
        if (isDemoMode) return;

        if (approved) {
            await supabase
                .from('club_members')
                .update({ status: 'active' })
                .eq('id', memberId);
        } else {
            await supabase.from('club_members').delete().eq('id', memberId);
        }
    }

    /**
     * Get online member count for a club
     */
    async getOnlineCount(clubId: string): Promise<number> {
        if (isDemoMode) {
            return Math.floor(Math.random() * 50);
        }

        // This would typically check presence/session data
        const { count, error } = await supabase
            .from('club_members')
            .select('*', { count: 'exact', head: true })
            .eq('club_id', clubId)
            .eq('status', 'active');

        if (error) throw error;
        return Math.floor((count || 0) * 0.3); // Assume ~30% online
    }
}

export const clubService = new ClubService();
