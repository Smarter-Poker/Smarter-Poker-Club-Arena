/**
 * ♠ CLUB ARENA — Union Service
 * Management of unions and inter-club networks
 */

import { isDemoMode } from '../lib/supabase';

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
}

export interface UnionClub {
    club_id: string;
    union_id: string;
    club_name: string;
    club_owner: string;
    member_count: number;
    joined_at: string;
    status: 'active' | 'pending';
}

const DEMO_UNIONS: Union[] = [
    {
        id: 'u1',
        name: 'Global Poker Union',
        description: 'The largest poker union worldwide. 24/7 action at all stakes. High security and verified players only.',
        owner_id: 'user_1',
        created_at: '2024-01-15T00:00:00Z',
        member_count: 12500,
        club_count: 45,
        online_count: 2340,
        status: 'active',
        logo_url: '🌐',
    },
    {
        id: 'u2',
        name: 'High Stakes Network',
        description: 'Premium network for serious mid-to-high stakes players. Minimum buy-in requirements enforced.',
        owner_id: 'user_2',
        created_at: '2024-03-10T00:00:00Z',
        member_count: 890,
        club_count: 12,
        online_count: 234,
        status: 'active',
        logo_url: '💎',
    },
    {
        id: 'u3',
        name: 'Tournament Alliance',
        description: 'Daily tournaments with massive guaranteed prize pools. Satellites running 24/7.',
        owner_id: 'user_3',
        created_at: '2024-06-20T00:00:00Z',
        member_count: 5600,
        club_count: 28,
        online_count: 890,
        status: 'active',
        logo_url: '🏆',
    },
];

const DEMO_UNION_CLUBS: UnionClub[] = [
    { club_id: 'c1', union_id: 'u1', club_name: 'Diamond Club', club_owner: 'Alice', member_count: 120, joined_at: '2025-01-01', status: 'active' },
    { club_id: 'c2', union_id: 'u1', club_name: 'Spade Social', club_owner: 'Bob', member_count: 85, joined_at: '2025-01-05', status: 'active' },
    { club_id: 'c3', union_id: 'u1', club_name: 'River Rats', club_owner: 'Charlie', member_count: 200, joined_at: '2025-01-10', status: 'active' },
    { club_id: 'c4', union_id: 'u2', club_name: 'Whale\'s Den', club_owner: 'Dave', member_count: 40, joined_at: '2025-02-01', status: 'active' },
];

class UnionService {
    async getUnions(): Promise<Union[]> {
        if (isDemoMode) {
            // Simulate network delay
            await new Promise(resolve => setTimeout(resolve, 500));
            return DEMO_UNIONS;
        }
        return [];
    }

    async getUnionById(unionId: string): Promise<Union | null> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 300));
            return DEMO_UNIONS.find(u => u.id === unionId) || null;
        }
        return null;
    }

    async getUnionClubs(unionId: string): Promise<UnionClub[]> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 400));
            return DEMO_UNION_CLUBS.filter(uc => uc.union_id === unionId);
        }
        return [];
    }

    async joinUnion(unionId: string, clubId: string): Promise<boolean> {
        // Logic to request joining
        await new Promise(resolve => setTimeout(resolve, 600));
        return true;
    }

    async createUnion(name: string, description: string, ownerId: string): Promise<Union | null> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 800));
            const newUnion: Union = {
                id: `u${Date.now()}`,
                name,
                description,
                owner_id: ownerId,
                created_at: new Date().toISOString(),
                member_count: 1, // Owner starts as member
                club_count: 1, // Owner's club
                online_count: 0,
                status: 'active',
                logo_url: '🆕',
            };
            DEMO_UNIONS.push(newUnion);
            return newUnion;
        }
        return null;
    }
}

export const unionService = new UnionService();
