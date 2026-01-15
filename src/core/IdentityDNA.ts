/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🧬 IDENTITY DNA — Authentication & User Profile Layer
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Identity DNA is the user identity backbone of Club Arena, managing:
 * - Real Supabase authentication with session persistence
 * - Auth state change listeners
 * - User profile hydration from database
 * - Secure logout with full store cleanup
 * 
 * NO DEMO DATA - All operations are real.
 */

import { Session, AuthChangeEvent } from '@supabase/supabase-js';
import { useUserStore } from '../stores/useUserStore';
import { supabase } from '../lib/supabase';
import { masterBus } from './MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    vip_level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
    created_at: string;
    updated_at?: string;
}

export interface IdentityDNAStatus {
    loaded: boolean;
    authenticated: boolean;
    userId: string | null;
    username: string | null;
    sessionExpiresAt: string | null;
    timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IDENTITY DNA SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

class IdentityDNACore {
    private status: IdentityDNAStatus | null = null;
    private authListener: { data: { subscription: { unsubscribe: () => void } } } | null = null;
    private initialized: boolean = false;

    /**
     * Initialize Identity DNA
     * Sets up auth listener and loads current session
     */
    async init(): Promise<IdentityDNAStatus> {
        if (this.initialized) {
            console.log('🧬 [IDENTITY DNA] Already initialized');
            return this.status!;
        }

        console.log('═══════════════════════════════════════════════════════════════');
        console.log('🧬 [IDENTITY DNA] LOADING USER IDENTITY LAYER');
        console.log('═══════════════════════════════════════════════════════════════');

        // Set up auth state listener FIRST
        this.setupAuthListener();

        // Check for existing session
        let authenticated = false;
        let userId: string | null = null;
        let username: string | null = null;
        let sessionExpiresAt: string | null = null;

        try {
            const { data: { session }, error } = await supabase.auth.getSession();

            if (session && !error) {
                authenticated = true;
                userId = session.user.id;
                username = session.user.email?.split('@')[0] || null;
                sessionExpiresAt = session.expires_at
                    ? new Date(session.expires_at * 1000).toISOString()
                    : null;

                console.log(`  ├─ Session: ✓ (${userId})`);
                console.log(`  ├─ User: ${username}`);
                console.log(`  └─ Expires: ${sessionExpiresAt || 'Never'}`);

                // Hydrate user store with session data
                await this.hydrateUserFromSession(session);

                // Emit auth event
                masterBus.emit('AUTH_STATE_CHANGED', {
                    userId,
                    isAuthenticated: true,
                });
            } else {
                console.log('  ├─ Session: ✗ (No active session)');
                console.log('  └─ Mode: Guest');
            }
        } catch (e) {
            console.error('  └─ Session Check Failed:', e);
        }

        // Build status
        this.status = {
            loaded: true,
            authenticated,
            userId,
            username,
            sessionExpiresAt,
            timestamp: new Date().toISOString(),
        };

        this.initialized = true;

        // DETERMINISTIC PROOF
        console.log('───────────────────────────────────────────────────────────────');
        console.log(`IDENTITY_DNA:${this.status.loaded ? 'LOADED' : 'FAILED'}`);
        console.log(`AUTH_STATUS:${authenticated ? 'AUTHENTICATED' : 'GUEST'}`);
        console.log('═══════════════════════════════════════════════════════════════');

        return this.status;
    }

    /**
     * Set up Supabase auth state listener
     * This persists throughout the app lifecycle
     */
    private setupAuthListener(): void {
        console.log('  ├─ Setting up auth state listener...');

        this.authListener = supabase.auth.onAuthStateChange(
            async (event: AuthChangeEvent, session: Session | null) => {
                console.log(`🧬 [AUTH EVENT] ${event}`, session?.user?.id || 'No user');

                switch (event) {
                    case 'SIGNED_IN':
                        if (session) {
                            await this.hydrateUserFromSession(session);
                            this.updateStatus(true, session);
                            masterBus.emit('AUTH_STATE_CHANGED', {
                                userId: session.user.id,
                                isAuthenticated: true,
                            });
                        }
                        break;

                    case 'SIGNED_OUT':
                        this.clearUser();
                        this.updateStatus(false, null);
                        masterBus.emit('AUTH_STATE_CHANGED', {
                            userId: null,
                            isAuthenticated: false,
                        });
                        break;

                    case 'TOKEN_REFRESHED':
                        if (session) {
                            this.updateStatus(true, session);
                            console.log('🧬 [AUTH] Token refreshed successfully');
                        }
                        break;

                    case 'USER_UPDATED':
                        if (session) {
                            await this.hydrateUserFromSession(session);
                            masterBus.emit('USER_PROFILE_LOADED', {
                                userId: session.user.id,
                            });
                        }
                        break;
                }
            }
        );

        console.log('  ├─ Auth listener: ✓');
    }

    /**
     * Hydrate user store from session and load full profile
     */
    private async hydrateUserFromSession(session: Session): Promise<void> {
        const userId = session.user.id;
        const email = session.user.email;
        const metadata = session.user.user_metadata;

        // First, set basic info from session
        useUserStore.getState().setUser({
            id: userId,
            username: email?.split('@')[0] || 'Player',
            display_name: metadata?.display_name || metadata?.full_name || null,
            avatar_url: metadata?.avatar_url || null,
        });

        // Then, try to load full profile from database
        try {
            const profile = await this.loadUserProfile(userId);
            if (profile) {
                useUserStore.getState().setUser({
                    id: profile.id,
                    username: profile.username,
                    display_name: profile.display_name,
                    avatar_url: profile.avatar_url,
                    vip_level: profile.vip_level,
                });
                console.log('🧬 [PROFILE] Loaded from database:', profile.username);
            }
        } catch (e) {
            console.warn('🧬 [PROFILE] Could not load from database, using session data');
        }
    }

    /**
     * Load user profile from Supabase profiles table
     */
    async loadUserProfile(userId: string): Promise<UserProfile | null> {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (error) {
            // Profile might not exist yet - this is okay for new users
            if (error.code !== 'PGRST116') {
                console.error('🧬 [PROFILE] Load error:', error.message);
            }
            return null;
        }

        return data as UserProfile;
    }

    /**
     * Clear user data on logout
     */
    private clearUser(): void {
        useUserStore.getState().logout();
        console.log('🧬 [IDENTITY DNA] User data cleared');
    }

    /**
     * Update internal status
     */
    private updateStatus(authenticated: boolean, session: Session | null): void {
        this.status = {
            loaded: true,
            authenticated,
            userId: session?.user?.id || null,
            username: session?.user?.email?.split('@')[0] || null,
            sessionExpiresAt: session?.expires_at
                ? new Date(session.expires_at * 1000).toISOString()
                : null,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Perform secure logout
     */
    async logout(): Promise<void> {
        console.log('🧬 [IDENTITY DNA] Logging out...');

        try {
            const { error } = await supabase.auth.signOut();
            if (error) {
                console.error('🧬 [LOGOUT] Error:', error.message);
                throw error;
            }
            // Auth listener will handle the rest
        } catch (e) {
            // Force clear even if Supabase fails
            this.clearUser();
            throw e;
        }
    }

    /**
     * Get current status
     */
    getStatus(): IdentityDNAStatus | null {
        return this.status;
    }

    /**
     * Check if loaded
     */
    isLoaded(): boolean {
        return this.status?.loaded === true;
    }

    /**
     * Check if authenticated
     */
    isAuthenticated(): boolean {
        return this.status?.authenticated === true;
    }

    /**
     * Get current user ID
     */
    getUserId(): string | null {
        return this.status?.userId || null;
    }

    /**
     * Cleanup (for unmounting)
     */
    cleanup(): void {
        if (this.authListener) {
            this.authListener.data.subscription.unsubscribe();
            this.authListener = null;
        }
        this.initialized = false;
        this.status = null;
        console.log('🧬 [IDENTITY DNA] Cleanup complete');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// Singleton instance
export const identityDNA = new IdentityDNACore();

// Convenience functions
export async function initIdentityDNA(): Promise<IdentityDNAStatus> {
    return identityDNA.init();
}

export function getIdentityDNAStatus(): IdentityDNAStatus | null {
    return identityDNA.getStatus();
}

export function isIdentityDNALoaded(): boolean {
    return identityDNA.isLoaded();
}

export function isAuthenticated(): boolean {
    return identityDNA.isAuthenticated();
}
