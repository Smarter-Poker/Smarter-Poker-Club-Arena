/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🛡️ CLUB ARENA — Auth Guard Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Protects routes that require authentication.
 * Redirects to /auth if not authenticated.
 */

import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

interface AuthGuardProps {
    children: ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
    const [isLoading, setIsLoading] = useState(true);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const location = useLocation();

    useEffect(() => {
        // Check current session
        async function checkAuth() {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                setIsAuthenticated(!!session);
            } catch (error) {
                console.error('🛡️ [AUTH GUARD] Session check failed:', error);
                setIsAuthenticated(false);
            } finally {
                setIsLoading(false);
            }
        }

        checkAuth();

        // Listen for auth changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (event, session) => {
                setIsAuthenticated(!!session);
                setIsLoading(false);
            }
        );

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    // Show loading state
    if (isLoading) {
        return (
            <div style={{
                position: 'fixed',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(135deg, #0A0A0F 0%, #12121A 100%)',
                color: '#FFFFFF',
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>♠</div>
                    <div style={{ color: '#A0A0B8' }}>Loading...</div>
                </div>
            </div>
        );
    }

    // Redirect to auth if not authenticated
    if (!isAuthenticated) {
        return <Navigate to="/auth" state={{ from: location }} replace />;
    }

    // Render protected content
    return <>{children}</>;
}

/**
 * Inverse guard - redirects authenticated users away from auth page
 */
export function GuestGuard({ children }: AuthGuardProps) {
    const [isLoading, setIsLoading] = useState(true);
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    useEffect(() => {
        async function checkAuth() {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                setIsAuthenticated(!!session);
            } catch (error) {
                setIsAuthenticated(false);
            } finally {
                setIsLoading(false);
            }
        }

        checkAuth();
    }, []);

    if (isLoading) {
        return null;
    }

    // Redirect to home if already authenticated
    if (isAuthenticated) {
        return <Navigate to="/" replace />;
    }

    return <>{children}</>;
}
