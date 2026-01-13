/**
 * ♠ CLUB ARENA — User Store (Zustand)
 * Global state for current user and authentication
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserProfile, PlayerStats } from '../types/database.types';

interface UserState {
    // Current user
    user: UserProfile | null;
    isAuthenticated: boolean;
    isLoading: boolean;

    // Session
    currentClubId: string | null;

    // Demo mode user
    initDemoUser: () => void;

    // Auth actions
    login: (user: UserProfile) => void;
    logout: () => void;
    setUser: (user: Partial<UserProfile> & { id: string }) => void;
    updateProfile: (updates: Partial<UserProfile>) => void;

    // Club context
    setCurrentClub: (clubId: string | null) => void;

    // Chips (aggregate across clubs)
    totalChips: number;
    updateTotalChips: (chips: number) => void;
}

const DEFAULT_STATS: PlayerStats = {
    total_hands: 0,
    vpip: 0,
    pfr: 0,
    aggression_factor: 0,
    bb_per_100: 0,
    biggest_pot: 0,
    total_profit: 0,
    games_played: 0,
};

const DEMO_USER: UserProfile = {
    id: 'demo-user',
    username: 'Player123',
    display_name: 'Demo Player',
    avatar_url: null,
    vip_level: 'gold',
    stats: {
        total_hands: 15420,
        vpip: 24.5,
        pfr: 18.2,
        aggression_factor: 2.1,
        bb_per_100: 4.2,
        biggest_pot: 1250,
        total_profit: 8540,
        games_played: 234,
    },
    created_at: '2025-01-01T00:00:00Z',
};

export const useUserStore = create<UserState>()(
    persist(
        (set) => ({
            user: null,
            isAuthenticated: false,
            isLoading: false,
            currentClubId: null,
            totalChips: 0,

            initDemoUser: () => {
                set({
                    user: DEMO_USER,
                    isAuthenticated: true,
                    totalChips: 50000,
                });
            },

            login: (user: UserProfile) => {
                set({
                    user,
                    isAuthenticated: true,
                    isLoading: false,
                });
            },

            logout: () => {
                set({
                    user: null,
                    isAuthenticated: false,
                    currentClubId: null,
                    totalChips: 0,
                });
            },

            updateProfile: (updates: Partial<UserProfile>) => {
                set((state) => ({
                    user: state.user ? { ...state.user, ...updates } : null,
                }));
            },

            setUser: (userData: Partial<UserProfile> & { id: string }) => {
                const user: UserProfile = {
                    id: userData.id,
                    username: userData.username || 'Player',
                    display_name: userData.display_name || userData.username || 'Player',
                    avatar_url: userData.avatar_url || null,
                    vip_level: userData.vip_level || 'bronze',
                    stats: userData.stats || {
                        total_hands: 0,
                        vpip: 0,
                        pfr: 0,
                        aggression_factor: 0,
                        bb_per_100: 0,
                        biggest_pot: 0,
                        total_profit: 0,
                        games_played: 0,
                    },
                    created_at: userData.created_at || new Date().toISOString(),
                };
                set({
                    user,
                    isAuthenticated: true,
                    totalChips: (userData as any).chip_balance || 0,
                });
            },

            setCurrentClub: (clubId: string | null) => {
                set({ currentClubId: clubId });
            },

            updateTotalChips: (chips: number) => {
                set({ totalChips: chips });
            },
        }),
        {
            name: 'club-arena-user',
            partialize: (state) => ({
                user: state.user,
                isAuthenticated: state.isAuthenticated,
                currentClubId: state.currentClubId,
            }),
        }
    )
);
