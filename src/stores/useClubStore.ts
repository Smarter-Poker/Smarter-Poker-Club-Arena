/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Club Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state management for clubs, memberships, and discovery
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
    Club,
    ClubWithDistance,
    ClubMember,
    ClubLocation
} from '@/types/club.types';
import { ClubsService } from '@/services/ClubsService';

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 STORE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ClubState {
    // Discovery
    nearbyClubs: ClubWithDistance[];
    searchResults: Club[];
    isDiscovering: boolean;
    isSearching: boolean;

    // User's clubs
    memberships: (ClubMember & { club: Club })[];
    isLoadingMemberships: boolean;

    // Current club context
    activeClub: Club | null;
    activeClubMembers: ClubMember[];
    isLoadingClub: boolean;

    // User location
    userLocation: ClubLocation | null;

    // Discovery Tab State
    activeTab: 'discover' | 'my-clubs' | 'create';

    // Actions
    setUserLocation: (location: ClubLocation) => void;
    discoverNearby: (radiusKm?: number) => Promise<void>;
    searchClubs: (query: string) => Promise<void>;
    loadMemberships: () => Promise<void>;
    loadClub: (identifier: string) => Promise<void>;
    loadClubMembers: (clubId: string) => Promise<void>;
    joinClub: (clubId: string) => Promise<void>;
    leaveClub: (clubId: string) => Promise<void>;
    createClub: (data: Parameters<typeof ClubsService.create>[0]) => Promise<Club>;
    setActiveTab: (tab: 'discover' | 'my-clubs' | 'create') => void;
    reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏪 STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

const initialState = {
    nearbyClubs: [],
    searchResults: [],
    isDiscovering: false,
    isSearching: false,
    memberships: [],
    isLoadingMemberships: false,
    activeClub: null,
    activeClubMembers: [],
    isLoadingClub: false,
    userLocation: null,
    activeTab: 'discover' as const,
};

export const useClubStore = create<ClubState>()(
    persist(
        (set, get) => ({
            ...initialState,

            setUserLocation: (location) => {
                set({ userLocation: location });
            },

            discoverNearby: async (radiusKm = 50) => {
                const { userLocation } = get();
                if (!userLocation) {
                    console.warn('⚠️ User location not set for discovery');
                    return;
                }

                set({ isDiscovering: true });
                try {
                    const clubs = await ClubsService.discoverNearby(userLocation, radiusKm);
                    set({ nearbyClubs: clubs });
                } catch (error) {
                    console.error('🔴 Discovery failed:', error);
                } finally {
                    set({ isDiscovering: false });
                }
            },

            searchClubs: async (query) => {
                if (!query.trim()) {
                    set({ searchResults: [] });
                    return;
                }

                set({ isSearching: true });
                try {
                    const results = await ClubsService.search(query);
                    set({ searchResults: results });
                } catch (error) {
                    console.error('🔴 Search failed:', error);
                } finally {
                    set({ isSearching: false });
                }
            },

            loadMemberships: async () => {
                set({ isLoadingMemberships: true });
                try {
                    const memberships = await ClubsService.getUserMemberships();
                    set({ memberships });
                } catch (error) {
                    console.error('🔴 Load memberships failed:', error);
                } finally {
                    set({ isLoadingMemberships: false });
                }
            },

            loadClub: async (identifier) => {
                set({ isLoadingClub: true, activeClub: null });
                try {
                    const club = await ClubsService.get(identifier);
                    set({ activeClub: club });
                } catch (error) {
                    console.error('🔴 Load club failed:', error);
                } finally {
                    set({ isLoadingClub: false });
                }
            },

            loadClubMembers: async (clubId) => {
                try {
                    const members = await ClubsService.getMembers(clubId);
                    set({ activeClubMembers: members });
                } catch (error) {
                    console.error('🔴 Load members failed:', error);
                }
            },

            joinClub: async (clubId) => {
                try {
                    await ClubsService.join(clubId);
                    // Refresh memberships
                    await get().loadMemberships();
                } catch (error) {
                    console.error('🔴 Join failed:', error);
                    throw error;
                }
            },

            leaveClub: async (clubId) => {
                try {
                    await ClubsService.leave(clubId);
                    // Refresh memberships
                    await get().loadMemberships();
                } catch (error) {
                    console.error('🔴 Leave failed:', error);
                    throw error;
                }
            },

            createClub: async (data) => {
                try {
                    const club = await ClubsService.create(data);
                    // Refresh memberships to include new club
                    await get().loadMemberships();
                    return club;
                } catch (error) {
                    console.error('🔴 Create failed:', error);
                    throw error;
                }
            },

            setActiveTab: (tab) => {
                set({ activeTab: tab });
            },

            reset: () => {
                set(initialState);
            },
        }),
        {
            name: 'club-engine-store',
            partialize: (state) => ({
                // Only persist location and tab preference
                userLocation: state.userLocation,
                activeTab: state.activeTab,
            }),
        }
    )
);
