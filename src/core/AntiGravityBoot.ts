/**
 * 🚀 ANTI-GRAVITY AUTO-BOOT MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * This module runs AUTOMATICALLY at app startup.
 * It verifies all required systems and fails-closed if anything is missing.
 * 
 * HARD REQUIREMENTS:
 * 1. ANTIGRAVITY_ENABLED must be 'true'
 * 2. VITE_SUPABASE_URL must exist
 * 3. VITE_SUPABASE_ANON_KEY must exist
 * 4. Supabase must respond to a health check
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface BootStatus {
    antigravityOk: boolean;
    supabaseOk: boolean;
    errors: string[];
    timestamp: string;
}

let bootStatus: BootStatus | null = null;
let supabaseClient: SupabaseClient | null = null;

/**
 * PRIMARY BOOT ENTRYPOINT
 * Must be called before app renders.
 * Returns the boot status for fail-closed logic.
 */
export async function initAntiGravity(): Promise<BootStatus> {
    console.log('🚀 [ANTIGRAVITY] Initializing...');

    const errors: string[] = [];
    let antigravityOk = false;
    let supabaseOk = false;

    // ═══════════════════════════════════════════════════════════════════════════
    // 1. VERIFY ENV VARS
    // ═══════════════════════════════════════════════════════════════════════════
    const ANTIGRAVITY_ENABLED = import.meta.env.VITE_ANTIGRAVITY_ENABLED;
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (ANTIGRAVITY_ENABLED !== 'true') {
        errors.push('VITE_ANTIGRAVITY_ENABLED is not set to "true"');
    }

    if (!SUPABASE_URL) {
        errors.push('VITE_SUPABASE_URL is missing');
    }

    if (!SUPABASE_ANON_KEY) {
        errors.push('VITE_SUPABASE_ANON_KEY is missing');
    }

    // If all env vars present, mark antigravity as OK
    if (ANTIGRAVITY_ENABLED === 'true' && SUPABASE_URL && SUPABASE_ANON_KEY) {
        antigravityOk = true;
        console.log('✅ ANTIGRAVITY_OK:true');
    } else {
        console.error('❌ ANTIGRAVITY_OK:false', errors);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 2. SUPABASE PROOF (Health Check)
    // ═══════════════════════════════════════════════════════════════════════════
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
        try {
            supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

            // Lightweight health query: get current session (no auth needed)
            const { data, error } = await supabaseClient.auth.getSession();

            if (error) {
                errors.push(`Supabase Auth Error: ${error.message}`);
                console.error('❌ SUPABASE_OK:false', error.message);
            } else {
                supabaseOk = true;
                console.log('✅ SUPABASE_OK:true');
            }
        } catch (e: any) {
            errors.push(`Supabase Connection Failed: ${e.message}`);
            console.error('❌ SUPABASE_OK:false', e.message);
        }
    } else {
        errors.push('Supabase credentials missing, cannot perform health check');
        console.error('❌ SUPABASE_OK:false (credentials missing)');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3. BUILD STATUS OBJECT
    // ═══════════════════════════════════════════════════════════════════════════
    bootStatus = {
        antigravityOk,
        supabaseOk,
        errors,
        timestamp: new Date().toISOString()
    };

    // Final Heartbeat
    if (antigravityOk && supabaseOk) {
        console.log('💚 [ANTIGRAVITY] HEARTBEAT: All Systems Operational');
    } else {
        console.error('🔴 [ANTIGRAVITY] HEARTBEAT: System Offline', errors);
    }

    return bootStatus;
}

/**
 * GET BOOT STATUS
 * Can be called anywhere after boot to check system health.
 */
export function getBootStatus(): BootStatus | null {
    return bootStatus;
}

/**
 * GET SUPABASE CLIENT
 * Returns the initialized Supabase client for app-wide use.
 */
export function getSupabaseClient(): SupabaseClient | null {
    return supabaseClient;
}

/**
 * IS SYSTEM ONLINE
 * Quick check for fail-closed logic.
 */
export function isSystemOnline(): boolean {
    return bootStatus?.antigravityOk === true && bootStatus?.supabaseOk === true;
}
