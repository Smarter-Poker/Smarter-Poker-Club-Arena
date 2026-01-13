/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Clubs Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Primary service layer for club management, discovery, and membership
 */

import { supabase } from '@/lib/supabase';
import type {
    Club,
    ClubWithDistance,
    ClubMember,
    ClubLocation,
    ClubChallenge,
    MemberRole
} from '@/types/club.types';

// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 CLUB DISCOVERY (PostGIS)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover clubs within a specified radius using PostGIS
 * @param location User's current location
 * @param radiusKm Search radius in kilometers (default 50km)
 * @returns Clubs sorted by proximity with < 50ms latency
 */
export async function discoverNearbyClubs(
    location: ClubLocation,
    radiusKm: number = 50
): Promise<ClubWithDistance[]> {
    const { data, error } = await supabase.rpc('fn_discover_clubs', {
        user_lat: location.latitude,
        user_lng: location.longitude,
        radius_km: radiusKm,
    });

    if (error) {
        console.error('🔴 Club discovery failed:', error);
        throw new Error('Failed to discover nearby clubs');
    }

    return data || [];
}

/**
 * Search clubs by name with pattern matching
 */
export async function searchClubs(query: string): Promise<Club[]> {
    const { data, error } = await supabase
        .from('clubs')
        .select('*')
        .ilike('name', `%${query}%`)
        .eq('is_public', true)
        .order('member_count', { ascending: false })
        .limit(20);

    if (error) {
        console.error('🔴 Club search failed:', error);
        throw new Error('Failed to search clubs');
    }

    return data || [];
}

/**
 * Get a single club by ID or slug
 */
export async function getClub(identifier: string): Promise<Club | null> {
    // Try by ID first, then by slug
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

    const { data, error } = await supabase
        .from('clubs')
        .select('*')
        .eq(isUUID ? 'id' : 'slug', identifier)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        console.error('🔴 Get club failed:', error);
        throw new Error('Failed to get club');
    }

    return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏛️ CLUB MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new club with automatic slug generation
 */
export async function createClub(clubData: {
    name: string;
    description?: string;
    color_theme?: string;
    is_public?: boolean;
    location?: ClubLocation;
    city?: string;
    country?: string;
}): Promise<Club> {
    // Generate URL-friendly slug
    const slug = clubData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    const { data: user } = await supabase.auth.getUser();
    if (!user.user) throw new Error('Authentication required');

    const { data, error } = await supabase
        .from('clubs')
        .insert({
            name: clubData.name,
            slug,
            description: clubData.description,
            color_theme: clubData.color_theme || 'royal-blue',
            is_public: clubData.is_public ?? true,
            requires_approval: false,
            owner_id: user.user.id,
            city: clubData.city,
            country: clubData.country,
        })
        .select()
        .single();

    if (error) {
        console.error('🔴 Club creation failed:', error);
        throw new Error('Failed to create club');
    }

    // Auto-join as owner
    await joinClub(data.id, 'owner');

    return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 👥 MEMBERSHIP MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Join a club with role assignment
 */
export async function joinClub(
    clubId: string,
    role: MemberRole = 'member'
): Promise<ClubMember> {
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) throw new Error('Authentication required');

    const { data, error } = await supabase
        .from('club_members')
        .insert({
            club_id: clubId,
            user_id: user.user.id,
            role,
            tier: 'bronze',
            xp: 0,
            diamonds: 0,
            reputation_xp: 0,
            trust_score: 50, // Starting trust score
            rank_level: 0,
            sessions_played: 0,
            orange_ball_status: 'cold',
        })
        .select()
        .single();

    if (error) {
        console.error('🔴 Join club failed:', error);
        throw new Error('Failed to join club');
    }

    return data;
}

/**
 * Leave a club
 */
export async function leaveClub(clubId: string): Promise<void> {
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) throw new Error('Authentication required');

    const { error } = await supabase
        .from('club_members')
        .delete()
        .eq('club_id', clubId)
        .eq('user_id', user.user.id);

    if (error) {
        console.error('🔴 Leave club failed:', error);
        throw new Error('Failed to leave club');
    }
}

/**
 * Get user's club memberships
 */
export async function getUserMemberships(): Promise<(ClubMember & { club: Club })[]> {
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) return [];

    const { data, error } = await supabase
        .from('club_members')
        .select(`
      *,
      club:clubs(*)
    `)
        .eq('user_id', user.user.id);

    if (error) {
        console.error('🔴 Get memberships failed:', error);
        throw new Error('Failed to get memberships');
    }

    return data || [];
}

/**
 * Get club members with profiles
 */
export async function getClubMembers(clubId: string): Promise<ClubMember[]> {
    const { data, error } = await supabase
        .from('club_members')
        .select(`
      *,
      profile:profiles(username, avatar_url)
    `)
        .eq('club_id', clubId)
        .order('xp', { ascending: false });

    if (error) {
        console.error('🔴 Get club members failed:', error);
        throw new Error('Failed to get club members');
    }

    return data || [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏆 CHALLENGES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get active challenges for a club
 */
export async function getClubChallenges(clubId: string): Promise<ClubChallenge[]> {
    const { data, error } = await supabase
        .from('club_challenges')
        .select('*')
        .eq('club_id', clubId)
        .eq('status', 'active')
        .order('ends_at', { ascending: true });

    if (error) {
        console.error('🔴 Get challenges failed:', error);
        throw new Error('Failed to get challenges');
    }

    return data || [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 STATS & LEADERBOARDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get club leaderboard
 */
export async function getClubLeaderboard(
    clubId: string,
    period: 'daily' | 'weekly' | 'monthly' | 'all_time' = 'weekly'
): Promise<ClubMember[]> {
    const { data, error } = await supabase
        .from('club_members')
        .select(`
      *,
      profile:profiles(username, avatar_url)
    `)
        .eq('club_id', clubId)
        .order('xp', { ascending: false })
        .limit(50);

    if (error) {
        console.error('🔴 Get leaderboard failed:', error);
        throw new Error('Failed to get leaderboard');
    }

    return data || [];
}

// Export service object for cleaner imports
export const ClubsService = {
    discoverNearby: discoverNearbyClubs,
    search: searchClubs,
    get: getClub,
    create: createClub,
    join: joinClub,
    leave: leaveClub,
    getUserMemberships,
    getMembers: getClubMembers,
    getChallenges: getClubChallenges,
    getLeaderboard: getClubLeaderboard,
};
