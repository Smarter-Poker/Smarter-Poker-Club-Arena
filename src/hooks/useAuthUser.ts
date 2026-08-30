/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useAuthUser — Resilient User Hydration Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 * Returns the current user from the store. If user is null but there's
 * a valid Supabase session, automatically re-hydrates the user store.
 *
 * Use this instead of `useUserStore().user` in any component that NEEDS
 * the user object (registration, wallet, profile, etc.).
 */

import { useEffect, useState } from 'react';
import { useUserStore } from '../stores/useUserStore';
import { supabase } from '../lib/supabase';

export function useAuthUser() {
  const { user, isAuthenticated } = useUserStore();
  const [isHydrating, setIsHydrating] = useState(false);

  useEffect(() => {
    // If user is already loaded, nothing to do
    if (user) return;

    let cancelled = false;

    async function rehydrate() {
      setIsHydrating(true);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (cancelled) return;

        if (session) {
          const userId = session.user.id;
          const email = session.user.email;
          const metadata = session.user.user_metadata;

          // Set basic info immediately
          useUserStore.getState().setUser({
            id: userId,
            username: email?.split('@')[0] || 'Player',
            display_name: metadata?.display_name || metadata?.full_name || null,
            avatar_url: metadata?.avatar_url || null,
          });

          // Try loading full profile (non-blocking)
          useUserStore
            .getState()
            .loadProfile(userId)
            .catch((e) => console.warn('[useAuthUser] Failed to load user profile:', e));
        }
      } catch (err) {
        // Silent — IdentityDNA listener will handle it eventually
        console.warn('[useAuthUser] Re-hydration failed:', err);
      } finally {
        if (!cancelled) setIsHydrating(false);
      }
    }

    rehydrate();

    return () => {
      cancelled = true;
    };
  }, [user]);

  return { user, isAuthenticated: isAuthenticated || !!user, isHydrating };
}
