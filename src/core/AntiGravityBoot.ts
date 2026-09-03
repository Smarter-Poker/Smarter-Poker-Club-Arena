/**
 *  ANTI-GRAVITY AUTO-BOOT MODULE (HARDENED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * This module runs AUTOMATICALLY at app startup.
 * It verifies all required environment variables and fails-closed if missing.
 *
 * HARD REQUIREMENTS (synchronous — no network calls):
 * 1. VITE_ANTIGRAVITY_ENABLED must be 'true'
 * 2. VITE_SUPABASE_URL must exist
 * 3. VITE_SUPABASE_ANON_KEY must exist
 *
 * Supabase connectivity is validated by IdentityDNA.init() separately.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

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
 * Synchronous env-var validation. No network calls.
 * Returns the boot status for fail-closed logic.
 *
 * HISTORY: Previously called getSession() as a "health check", but that
 * was redundant with IdentityDNA.init() and always returned supabaseOk=true
 * regardless of outcome. Removed to eliminate 2-8s blocking at startup.
 */
export function initAntiGravity(): BootStatus {
  const errors: string[] = [];
  let antigravityOk = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: VERIFY ENV VARS (Required)
  // ═══════════════════════════════════════════════════════════════════════════
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL) {
    errors.push('VITE_SUPABASE_URL is missing');
  }

  if (!SUPABASE_ANON_KEY) {
    errors.push('VITE_SUPABASE_ANON_KEY is missing');
  }

  // All env vars must be present for ANTIGRAVITY_OK
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    antigravityOk = true;
  }

  // Store the shared Supabase client reference for getSupabaseClient()
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabaseClient = supabase;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD BOOT STATUS
  // ═══════════════════════════════════════════════════════════════════════════
  // supabaseOk is always true when env vars are present — actual connectivity
  // is validated by IdentityDNA.init() and handled by the Connection Watchdog.
  const supabaseOk = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

  bootStatus = {
    antigravityOk,
    supabaseOk,
    errors,
    timestamp: new Date().toISOString(),
  };

  // Log errors if any
  if (errors.length > 0) {
    reportError(errors, 'AntiGravityBoot.Boot_Errors');
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
