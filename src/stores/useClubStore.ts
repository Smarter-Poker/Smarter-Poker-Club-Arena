/**
 * ♠ CLUB ARENA — Club Store (Zustand)
 * Global state management for clubs and memberships
 */

import { create } from 'zustand';
import { clubService } from '../services/ClubService';
import type { Club, ClubMember } from '../types/database.types';

interface ClubState {
    // Current user's clubs
    myClubs: Club[];
    isLoadingClubs: boolean;

    // Currently selected club
    currentClub: Club | null;
    currentClubMembers: ClubMember[];

    // User's membership in current club
    currentMembership: ClubMember | null;

    // Actions
    fetchMyClubs: (userId: string) => Promise<void>;
    selectClub: (clubId: string) => Promise<void>;
    createClub: (userId: string, name: string, description: string) => Promise<Club>;
    joinClub: (clubId: string, userId: string) => Promise<void>;
    leaveClub: (clubId: string, userId: string) => Promise<void>;

    // Discovery
    searchResults: Club[];
    searchClubs: (query: string) => Promise<void>;
    getClubByCode: (code: number) => Promise<Club | null>;

    // Reset
    reset: () => void;
}

const initialState = {
    myClubs: [],
    isLoadingClubs: false,
    currentClub: null,
    currentClubMembers: [],
    currentMembership: null,
    searchResults: [],
};

export const useClubStore = create<ClubState>((set, get) => ({
    ...initialState,

    fetchMyClubs: async (userId: string) => {
        set({ isLoadingClubs: true });
        try {
            const clubs = await clubService.getMyClubs(userId);
            set({ myClubs: clubs, isLoadingClubs: false });
        } catch (error) {
            console.error('Failed to fetch clubs:', error);
            set({ isLoadingClubs: false });
        }
    },

    selectClub: async (clubId: string) => {
        try {
            const club = await clubService.getClub(clubId);
            if (!club) {
                set({ currentClub: null, currentClubMembers: [] });
                return;
            }

            const members = await clubService.getMembers(clubId);

            // Find current user's membership
            // In real app, would use auth.currentUser.id
            const currentMembership = members.find(m => m.role === 'owner') || null;

            set({
                currentClub: club,
                currentClubMembers: members,
                currentMembership,
            });
        } catch (error) {
            console.error('Failed to select club:', error);
        }
    },

    createClub: async (userId: string, name: string, description: string) => {
        const club = await clubService.createClub(userId, name, description);
        set((state) => ({
            myClubs: [...state.myClubs, club],
        }));
        return club;
    },

    joinClub: async (clubId: string, userId: string) => {
        await clubService.requestJoin(clubId, userId);
        // Refresh clubs list
        await get().fetchMyClubs(userId);
    },

    leaveClub: async (clubId: string, userId: string) => {
        // Would call clubService.leavClub
        set((state) => ({
            myClubs: state.myClubs.filter((c) => c.id !== clubId),
        }));
    },

    searchClubs: async (query: string) => {
        if (!query.trim()) {
            set({ searchResults: [] });
            return;
        }
        const results = await clubService.searchClubs(query);
        set({ searchResults: results });
    },

    getClubByCode: async (code: number) => {
        return clubService.getClubByPublicId(code);
    },

    reset: () => set(initialState),
}));
