/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — User Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state for current user and authentication
 *
 * NO DEMO DATA - All user data comes from real Supabase auth/database
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerStats {
  total_hands: number;
  vpip: number;
  pfr: number;
  aggression_factor: number;
  bb_per_100: number;
  biggest_pot: number;
  total_profit: number;
  games_played: number;
}

export interface UserProfile {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  vip_level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond'; // Maps to DB `tier` column
  stats?: PlayerStats;
  created_at: string;
}

interface UserState {
  // Current user
  user: UserProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Session
  currentClubId: string | null;

  // Auth actions
  login: (user: UserProfile) => void;
  logout: () => void;
  setUser: (user: Partial<UserProfile> & { id: string }) => void;
  updateProfile: (updates: Partial<UserProfile>) => void;
  loadProfile: (userId: string) => Promise<UserProfile | null>;

  // Club context
  setCurrentClub: (clubId: string | null) => void;

  // Chips (aggregate across clubs)
  totalChips: number;
  updateTotalChips: (chips: number) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT STATS (for new users)
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════════════════

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      currentClubId: null,
      totalChips: 0,

      login: (user: UserProfile) => {
        set({
          user,
          isAuthenticated: true,
          isLoading: false,
        });
      },

      logout: () => {
        // CRITICAL: Only clear store state here. Do NOT call supabase.auth.signOut().
        // IdentityDNA owns the signOut lifecycle. Calling signOut() here creates a
        // recursive loop: logout() → signOut() → SIGNED_OUT event → clearUser() →
        // logout() → signOut() again. This corrupts auth state and causes spurious
        // redirects to /auth during navigation.
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
          stats: userData.stats || DEFAULT_STATS,
          created_at: userData.created_at || new Date().toISOString(),
        };
        set({
          user,
          isAuthenticated: true,
          totalChips: (userData as any).chip_balance || 0,
        });
      },

      /**
       * Load user profile from Supabase profiles table
       */
      loadProfile: async (userId: string): Promise<UserProfile | null> => {
        set({ isLoading: true });

        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

          if (error) {
            // PGRST116 = no rows returned (profile doesn't exist yet)
            if (error.code !== 'PGRST116') {
              console.error('[Store] [USER STORE] Load profile error:', error.message);
            }
            set({ isLoading: false });
            return null;
          }

          const profile: UserProfile = {
            id: data.id,
            username: data.username || 'Player',
            display_name: data.display_name,
            avatar_url: data.avatar_url,
            vip_level: data.tier || 'bronze', // DB uses `tier`, not `vip_level`
            stats: data.stats || DEFAULT_STATS,
            created_at: data.created_at,
          };

          set({
            user: profile,
            isAuthenticated: true,
            isLoading: false,
          });

          return profile;
        } catch (e) {
          console.error('[Store] [USER STORE] Unexpected error:', e);
          set({ isLoading: false });
          return null;
        }
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
        // Only persist essential session info
        currentClubId: state.currentClubId,
      }),
    }
  )
);
