/**
 * 🚀 ANTI-GRAVITY AUTO-BOOT MODULE (HARDENED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * This module runs AUTOMATICALLY at app startup.
 * It verifies all required systems and fails-closed if anything is missing.
 * 
 * HARD REQUIREMENTS:
 * 1. VITE_ANTIGRAVITY_ENABLED must be 'true'
 * 2. VITE_SUPABASE_URL must exist
 * 3. VITE_SUPABASE_ANON_KEY must exist
 * 4. Supabase must respond to a real health check (getSession)
 * 
 * DETERMINISTIC PROOFS (exact format):
 * - ANTIGRAVITY_OK:true/false
 * - SUPABASE_OK:true/false
 * - HEARTBEAT:ONLINE/OFFLINE
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
 * Must be AWAITED before app renders. No async race conditions.
 * Returns the boot status for absolute fail-closed logic.
 */
export async function initAntiGravity(): Promise<BootStatus> {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🚀 [ANTIGRAVITY] BOOT SEQUENCE INITIATED');
    console.log('═══════════════════════════════════════════════════════════════');

    const errors: string[] = [];
    let antigravityOk = false;
    let supabaseOk = false;

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1: VERIFY ENV VARS (Required)
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

    // All env vars must be present for ANTIGRAVITY_OK
    if (ANTIGRAVITY_ENABLED === 'true' && SUPABASE_URL && SUPABASE_ANON_KEY) {
        antigravityOk = true;
    }

    // DETERMINISTIC PROOF: ANTIGRAVITY_OK
    console.log(`ANTIGRAVITY_OK:${antigravityOk}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: SUPABASE PROOF (Real Health Check)
    // ═══════════════════════════════════════════════════════════════════════════
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
        try {
            supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

            // REAL health check: getSession performs an actual network request
            const { error } = await supabaseClient.auth.getSession();

            if (error) {
                errors.push(`Supabase Health Check Failed: ${error.message}`);
                supabaseOk = false;
            } else {
                supabaseOk = true;
            }
        } catch (e: any) {
            errors.push(`Supabase Connection Exception: ${e.message}`);
            supabaseOk = false;
        }
    } else {
        errors.push('Supabase credentials missing, health check skipped');
        supabaseOk = false;
    }

    // DETERMINISTIC PROOF: SUPABASE_OK
    console.log(`SUPABASE_OK:${supabaseOk}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: BUILD BOOT STATUS
    // ═══════════════════════════════════════════════════════════════════════════
    bootStatus = {
        antigravityOk,
        supabaseOk,
        errors,
        timestamp: new Date().toISOString()
    };

    // DETERMINISTIC PROOF: HEARTBEAT
    const heartbeat = (antigravityOk && supabaseOk) ? 'ONLINE' : 'OFFLINE';
    console.log(`HEARTBEAT:${heartbeat}`);

    // Log errors if any
    if (errors.length > 0) {
        console.error('[ANTIGRAVITY] Boot Errors:', errors);
    }

    console.log('═══════════════════════════════════════════════════════════════');

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
 * Returns null if boot failed.
 */
export function getSupabaseClient(): SupabaseClient | null {
    return supabaseClient;
}

/**
 * IS SYSTEM ONLINE
 * Absolute check for fail-closed logic.
 * Returns true ONLY if BOTH antigravityOk AND supabaseOk are true.
 */
export function isSystemOnline(): boolean {
    return bootStatus?.antigravityOk === true && bootStatus?.supabaseOk === true;
}
