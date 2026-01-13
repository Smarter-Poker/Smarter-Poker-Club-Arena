/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🚀 ANTI-GRAVITY BOOT — Fail-Closed System Initialization
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module ensures the application fails gracefully when required
 * environment variables or services are unavailable. The system will
 * display a "System Offline" screen instead of crashing unpredictably.
 * 
 * BOOT SEQUENCE:
 * 1. Verify required environment variables
 * 2. Test Supabase connectivity (heartbeat)
 * 3. Initialize application state
 * 4. Allow rendering OR show SystemOffline
 */

import React, { useEffect, useState, useCallback, ReactNode } from 'react';
import { supabase, isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BootStatus {
    stage: 'initializing' | 'checking_env' | 'testing_connection' | 'ready' | 'offline';
    checks: {
        envVars: boolean | null;
        supabase: boolean | null;
        timestamp: number;
    };
    errors: string[];
    isDemoMode: boolean;
}

interface AntiGravityBootProps {
    children: ReactNode;
    onBootComplete?: (status: BootStatus) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUIRED ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════════════════

const REQUIRED_ENV_VARS = [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
] as const;

// Optional but recommended
const OPTIONAL_ENV_VARS = [
    'VITE_ANTIGRAVITY_ENABLED',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

function checkEnvironmentVariables(): { success: boolean; missing: string[] } {
    const missing: string[] = [];

    for (const varName of REQUIRED_ENV_VARS) {
        const value = import.meta.env[varName];
        if (!value || value.trim() === '') {
            missing.push(varName);
        }
    }

    return {
        success: missing.length === 0,
        missing
    };
}

async function testSupabaseConnection(): Promise<{ success: boolean; error?: string }> {
    try {
        // Simple health check - just try to access the API
        const { error } = await supabase.from('clubs').select('id').limit(1);

        // Some errors are expected (like no rows), but connection errors are failures
        if (error && error.message.includes('Failed to fetch')) {
            return { success: false, error: 'Network connection failed' };
        }

        // Even if table doesn't exist, connection worked
        return { success: true };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown connection error'
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM OFFLINE SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

interface SystemOfflineProps {
    status: BootStatus;
    onRetry: () => void;
}

function SystemOffline({ status, onRetry }: SystemOfflineProps) {
    return (
        <div style={styles.container}>
            <div style={styles.innerContainer}>
                {/* Logo/Icon */}
                <div style={styles.iconContainer}>
                    <span style={styles.icon}>⚠️</span>
                </div>

                {/* Title */}
                <h1 style={styles.title}>System Offline</h1>
                <p style={styles.subtitle}>
                    Club Arena is currently unavailable
                </p>

                {/* Error Details */}
                <div style={styles.errorBox}>
                    <h3 style={styles.errorTitle}>Diagnostic Information</h3>
                    <ul style={styles.errorList}>
                        {status.errors.map((error, i) => (
                            <li key={i} style={styles.errorItem}>
                                <span style={styles.errorBullet}>✗</span>
                                {error}
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Status Indicators */}
                <div style={styles.statusGrid}>
                    <div style={styles.statusItem}>
                        <span style={status.checks.envVars ? styles.checkPass : styles.checkFail}>
                            {status.checks.envVars ? '✓' : '✗'}
                        </span>
                        <span>Environment Variables</span>
                    </div>
                    <div style={styles.statusItem}>
                        <span style={status.checks.supabase ? styles.checkPass : styles.checkFail}>
                            {status.checks.supabase ? '✓' : '✗'}
                        </span>
                        <span>Database Connection</span>
                    </div>
                </div>

                {/* Retry Button */}
                <button style={styles.retryButton} onClick={onRetry}>
                    Retry Connection
                </button>

                {/* Demo Mode Option */}
                {!status.isDemoMode && (
                    <p style={styles.demoHint}>
                        Development mode available with demo data
                    </p>
                )}

                {/* Timestamp */}
                <p style={styles.timestamp}>
                    Last check: {new Date(status.checks.timestamp).toLocaleTimeString()}
                </p>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOADING SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

interface LoadingScreenProps {
    stage: BootStatus['stage'];
}

function LoadingScreen({ stage }: LoadingScreenProps) {
    const stageMessages: Record<BootStatus['stage'], string> = {
        initializing: 'Initializing systems...',
        checking_env: 'Verifying configuration...',
        testing_connection: 'Connecting to database...',
        ready: 'Loading application...',
        offline: 'System offline',
    };

    return (
        <div style={styles.loadingContainer}>
            <div style={styles.loadingContent}>
                {/* Animated Logo */}
                <div style={styles.logoContainer}>
                    <span style={styles.logo}>♠</span>
                    <span style={styles.logoGlow}>♠</span>
                </div>

                {/* Title */}
                <h1 style={styles.loadingTitle}>Club Arena</h1>

                {/* Spinner */}
                <div style={styles.spinner} />

                {/* Stage Message */}
                <p style={styles.stageMessage}>{stageMessages[stage]}</p>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function AntiGravityBoot({ children, onBootComplete }: AntiGravityBootProps) {
    const [status, setStatus] = useState<BootStatus>({
        stage: 'initializing',
        checks: {
            envVars: null,
            supabase: null,
            timestamp: Date.now(),
        },
        errors: [],
        isDemoMode,
    });

    const runBootSequence = useCallback(async () => {
        const errors: string[] = [];

        // Reset status
        setStatus(prev => ({
            ...prev,
            stage: 'checking_env',
            errors: [],
            checks: { envVars: null, supabase: null, timestamp: Date.now() },
        }));

        // STEP 1: Check environment variables
        const envCheck = checkEnvironmentVariables();

        if (!envCheck.success && !isDemoMode) {
            envCheck.missing.forEach(v => errors.push(`Missing: ${v}`));
        }

        setStatus(prev => ({
            ...prev,
            stage: 'testing_connection',
            checks: { ...prev.checks, envVars: envCheck.success || isDemoMode },
        }));

        // STEP 2: Test Supabase connection (skip detailed check in demo mode)
        let supabaseCheck = { success: true, error: undefined as string | undefined };

        if (!isDemoMode) {
            supabaseCheck = await testSupabaseConnection();
            if (!supabaseCheck.success && supabaseCheck.error) {
                errors.push(`Database: ${supabaseCheck.error}`);
            }
        }

        // STEP 3: Determine final status
        const isReady = (envCheck.success || isDemoMode) && supabaseCheck.success;

        const finalStatus: BootStatus = {
            stage: isReady ? 'ready' : 'offline',
            checks: {
                envVars: envCheck.success || isDemoMode,
                supabase: supabaseCheck.success,
                timestamp: Date.now(),
            },
            errors,
            isDemoMode,
        };

        setStatus(finalStatus);

        // Notify parent
        onBootComplete?.(finalStatus);
    }, [onBootComplete]);

    // Run boot sequence on mount
    useEffect(() => {
        runBootSequence();
    }, [runBootSequence]);

    // Render based on status
    if (status.stage === 'offline') {
        return <SystemOffline status={status} onRetry={runBootSequence} />;
    }

    if (status.stage !== 'ready') {
        return <LoadingScreen stage={status.stage} />;
    }

    // READY — Render children
    return <>{children}</>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const styles: Record<string, React.CSSProperties> = {
    // System Offline
    container: {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0A0A0F 0%, #12121A 100%)',
        color: '#FFFFFF',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    },
    innerContainer: {
        textAlign: 'center',
        maxWidth: '500px',
        padding: '2rem',
    },
    iconContainer: {
        marginBottom: '1.5rem',
    },
    icon: {
        fontSize: '4rem',
        filter: 'drop-shadow(0 0 20px rgba(244, 63, 94, 0.5))',
    },
    title: {
        fontSize: '2rem',
        fontWeight: 700,
        margin: '0 0 0.5rem 0',
        background: 'linear-gradient(135deg, #F43F5E 0%, #F59E0B 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
    },
    subtitle: {
        fontSize: '1rem',
        color: '#A0A0B0',
        margin: '0 0 2rem 0',
    },
    errorBox: {
        background: 'rgba(244, 63, 94, 0.1)',
        border: '1px solid rgba(244, 63, 94, 0.3)',
        borderRadius: '12px',
        padding: '1.25rem',
        marginBottom: '1.5rem',
        textAlign: 'left',
    },
    errorTitle: {
        fontSize: '0.875rem',
        fontWeight: 600,
        color: '#F43F5E',
        margin: '0 0 0.75rem 0',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
    },
    errorList: {
        listStyle: 'none',
        margin: 0,
        padding: 0,
    },
    errorItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.875rem',
        color: '#E0E0E8',
        padding: '0.375rem 0',
    },
    errorBullet: {
        color: '#F43F5E',
        fontWeight: 600,
    },
    statusGrid: {
        display: 'flex',
        justifyContent: 'center',
        gap: '2rem',
        marginBottom: '2rem',
    },
    statusItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.875rem',
        color: '#A0A0B0',
    },
    checkPass: {
        color: '#10B981',
        fontWeight: 600,
        fontSize: '1rem',
    },
    checkFail: {
        color: '#F43F5E',
        fontWeight: 600,
        fontSize: '1rem',
    },
    retryButton: {
        background: 'linear-gradient(135deg, #4169E1 0%, #5B7FEE 100%)',
        color: '#FFFFFF',
        border: 'none',
        borderRadius: '8px',
        padding: '0.875rem 2rem',
        fontSize: '1rem',
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        boxShadow: '0 4px 15px rgba(65, 105, 225, 0.3)',
    },
    demoHint: {
        fontSize: '0.75rem',
        color: '#606070',
        marginTop: '1rem',
    },
    timestamp: {
        fontSize: '0.75rem',
        color: '#606070',
        marginTop: '1.5rem',
    },

    // Loading Screen
    loadingContainer: {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0A0A0F 0%, #12121A 100%)',
        color: '#FFFFFF',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    },
    loadingContent: {
        textAlign: 'center',
    },
    logoContainer: {
        position: 'relative',
        marginBottom: '1.5rem',
    },
    logo: {
        fontSize: '5rem',
        color: '#4169E1',
        position: 'relative',
        zIndex: 1,
    },
    logoGlow: {
        position: 'absolute',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        fontSize: '5rem',
        color: '#4169E1',
        filter: 'blur(20px)',
        opacity: 0.5,
        animation: 'pulse 2s ease-in-out infinite',
    },
    loadingTitle: {
        fontSize: '1.75rem',
        fontWeight: 700,
        margin: '0 0 2rem 0',
        background: 'linear-gradient(135deg, #4169E1 0%, #5B7FEE 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
    },
    spinner: {
        width: '40px',
        height: '40px',
        border: '3px solid rgba(65, 105, 225, 0.2)',
        borderTopColor: '#4169E1',
        borderRadius: '50%',
        margin: '0 auto 1.5rem',
        animation: 'spin 1s linear infinite',
    },
    stageMessage: {
        fontSize: '0.875rem',
        color: '#A0A0B0',
        margin: 0,
    },
};

// Export default for convenience
export default AntiGravityBoot;
