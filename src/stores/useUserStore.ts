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
import { reportError } from '../utils/errorReporter';
import { clearCachedIdentity } from '../lib/cachedIdentity';
import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';

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
  /**
   * THE COLUMNS `playerDisplayName` NEEDS (Dan 2026-09-02).
   *
   * "THE REAL NAME SHOULD NEVER BE DISPLAYED, IT SHOULD ALWAYS BE USING THE
   * POKER ALIAS."
   *
   * The store carried `username` and `display_name` and nothing else, so every
   * screen reading from it could only choose between a login handle and a
   * column that holds the LEGAL NAME on 264 of 1,308 production rows. The club
   * card chose `display_name` and greeted Dan as "Dan Bekavac" rather than
   * "KingFish" - not because the card picked wrongly, but because the alias it
   * should have shown was never loaded.
   *
   * These are the fields `NameableProfile` resolves over. All eight are granted
   * to `authenticated`, verified against the live schema before being added -
   * see the note on the select in loadProfile: ONE ungranted column 403s the
   * whole statement, and the store then silently never populates.
   */
  alias?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name_preference?: string | null;
  use_real_name?: boolean | null;
  avatar_url: string | null;
  vip_level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  player_number?: number;
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
        // First-paint identity cache (2026-08-28): forget the name/face on
        // logout so the next account on this device cannot cold-open as the
        // previous one.
        clearCachedIdentity();
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
          /* The same name fields as loadProfile. setUser is the path used by
             the auth listener and the identity cache, so a user who arrives
             through it rather than through loadProfile must not end up with a
             store that cannot resolve their alias. */
          alias: userData.alias ?? null,
          first_name: userData.first_name ?? null,
          last_name: userData.last_name ?? null,
          full_name: userData.full_name ?? null,
          display_name_preference: userData.display_name_preference ?? null,
          use_real_name: userData.use_real_name ?? null,
          avatar_url: userData.avatar_url || null,
          vip_level: userData.vip_level || 'bronze',
          player_number: userData.player_number,
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
          /**
           * Dan 2026-08-20: `select('*')` here 403'd on every single load.
           * `profiles` has 114 columns and `authenticated` may SELECT 103 —
           * email, phone, stripe_customer_id and eight others are deliberately
           * ungranted, and Postgres rejects the whole statement rather than
           * the column. The store therefore never populated and the failure
           * was invisible. Explicit columns, all of them granted.
           */
          const { data, error } = await supabase
            .from('profiles')
            .select(
              /* PLAYER_NAME_COLUMNS rather than a hand-written list: it is the
                 one place that says which columns `playerDisplayName` needs,
                 and a screen that resolves a name from a store missing one of
                 them silently falls through to the wrong answer - which is how
                 the club card came to print a real name. Every column in it is
                 granted to `authenticated` (checked against the live schema);
                 if that ever stops being true this select 403s WHOLE, per the
                 note above, so add to that constant with the same care. */
              `id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, tier, created_at, player_number`
            )
            .eq('id', userId)
            .maybeSingle();

          if (error) {
            // PGRST116 = no rows returned (profile doesn't exist yet)
            if (error.code !== 'PGRST116') {
              reportError(error, 'useUserStore.USER_STORE_Load_profile_error');
            }
            set({ isLoading: false });
            return null;
          }

          if (!data) {
            set({ isLoading: false });
            return null;
          }

          const profile: UserProfile = {
            id: data.id,
            username: data.username || 'Player',
            display_name: data.display_name,
            /* Carried through so `playerDisplayName` can do its job from the
               store alone. Without these the resolver silently degrades to
               username-or-display_name, which is the bug, not the fix. */
            alias: data.alias ?? null,
            first_name: data.first_name ?? null,
            last_name: data.last_name ?? null,
            full_name: data.full_name ?? null,
            display_name_preference: data.display_name_preference ?? null,
            use_real_name: data.use_real_name ?? null,
            avatar_url: data.avatar_url,
            vip_level: data.tier || 'bronze', // DB uses `tier`, not `vip_level`
            player_number: data.player_number,
            // `stats` is NOT a column on profiles (verified against the live
            // schema), so this was always DEFAULT_STATS via the `||`. Kept
            // explicit so the default reads as intent rather than as a
            // fallback quietly covering a missing field.
            stats: DEFAULT_STATS,
            created_at: data.created_at,
          };

          set({
            user: profile,
            isAuthenticated: true,
            isLoading: false,
          });

          return profile;
        } catch (e) {
          reportError(e, 'useUserStore.USER_STORE_Unexpected_error');
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
