/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state management for clubs, memberships, and discovery
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Club, ClubWithDistance, ClubMember, ClubLocation } from '@/types/club.types';
import type { CreateClubData } from '@/services/ClubsService';
import { ClubJoinService } from '@/services/ClubJoinService';
import { reportError } from '../utils/errorReporter';

const getClubsService = async () => (await import('@/services/ClubsService')).ClubsService;

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
  createClub: (data: CreateClubData) => Promise<Club>;
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
          console.warn('[Store] User location not set for discovery');
          return;
        }

        set({ isDiscovering: true });
        try {
          const service = await getClubsService();
          const clubs = await service.discoverNearby(userLocation, radiusKm);
          set({ nearbyClubs: clubs });
        } catch (error) {
          reportError(error, 'useClubStore.Discovery_failed');
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
          const service = await getClubsService();
          const results = await service.search(query);
          set({ searchResults: results });
        } catch (error) {
          reportError(error, 'useClubStore.Search_failed');
        } finally {
          set({ isSearching: false });
        }
      },

      loadMemberships: async () => {
        set({ isLoadingMemberships: true });
        try {
          const service = await getClubsService();
          const memberships = await service.getUserMemberships();
          set({ memberships });
        } catch (error) {
          reportError(error, 'useClubStore.Load_memberships_failed');
        } finally {
          set({ isLoadingMemberships: false });
        }
      },

      loadClub: async (identifier) => {
        set({ isLoadingClub: true, activeClub: null });
        try {
          const service = await getClubsService();
          const club = await service.get(identifier);
          set({ activeClub: club });
        } catch (error) {
          reportError(error, 'useClubStore.Load_club_failed');
        } finally {
          set({ isLoadingClub: false });
        }
      },

      loadClubMembers: async (clubId) => {
        try {
          const service = await getClubsService();
          const members = await service.getMembers(clubId);
          set({ activeClubMembers: members });
        } catch (error) {
          reportError(error, 'useClubStore.Load_members_failed');
        }
      },

      joinClub: async (clubId) => {
        try {
          const result = await ClubJoinService.join({ identifier: clubId });
          if (!result.success) throw new Error(result.error || 'Failed to join club');
          // Refresh memberships
          await get().loadMemberships();
        } catch (error) {
          reportError(error, 'useClubStore.Join_failed');
          throw error;
        }
      },

      leaveClub: async (clubId) => {
        try {
          const service = await getClubsService();
          await service.leave(clubId);
          // Refresh memberships
          await get().loadMemberships();
        } catch (error) {
          reportError(error, 'useClubStore.Leave_failed');
          throw error;
        }
      },

      createClub: async (data) => {
        try {
          const service = await getClubsService();
          const club = await service.create(data);
          // Refresh memberships to include new club
          await get().loadMemberships();
          return club;
        } catch (error) {
          reportError(error, 'useClubStore.Create_failed');
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
