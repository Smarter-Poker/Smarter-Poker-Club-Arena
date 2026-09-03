/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARED AUTH UTILITIES — Single source of truth for JWT/localStorage auth
 * ═══════════════════════════════════════════════════════════════════════════════
 * Extracted from 5 files that each had their own JWT parsing / localStorage
 * session reading logic:
 *   - IdentityDNA.ts (readLocalSession)
 *   - supabase.ts (getAuthUser, getTokenExpiry)
 *   - AuthGuard.tsx (hasLocalSession, hydrateStoreFromLocalStorage)
 *   - useAuthUser.ts (getSession() hydration)
 *
 * All auth-related localStorage reads now go through this module.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Shared SSO storage key — MUST match Hub's 'smarter-poker-auth' for same-origin SSO */

import { reportError } from '../utils/errorReporter';

export const AUTH_STORAGE_KEY = 'smarter-poker-auth';

/** Buffer for JWT expiry checks (60s to handle clock skew) */
const EXPIRY_BUFFER_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// JWT PARSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a JWT payload without verification.
 * Returns the decoded payload object or null if malformed.
 */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

/**
 * Get JWT expiry time in milliseconds (Unix epoch).
 * Returns null if token is malformed or has no exp claim.
 */
export function getTokenExpiry(token: string): number | null {
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  return typeof payload.exp === 'number' ? (payload.exp as number) * 1000 : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL SESSION READING
// ═══════════════════════════════════════════════════════════════════════════════

/** Full local session data parsed from localStorage JWT */
export interface LocalSession {
  userId: string;
  email?: string;
  username: string | null;
  /** Expiry time in ms (Unix epoch), or null if no exp claim */
  expiresAt: number | null;
  /** Raw access token from localStorage */
  accessToken: string;
  /** Full parsed session data object from localStorage */
  rawData: Record<string, unknown>;
}

/**
 * Read the auth session from localStorage directly — instant, no SDK calls.
 * The shared storageKey 'smarter-poker-auth' is written by both Hub and Club Arena (SSO).
 *
 * Returns full session info if a non-expired JWT exists, or null.
 * This is the SINGLE canonical implementation — all auth code should use this.
 */
export function readLocalSession(): LocalSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const token = data?.access_token;
    if (!token || typeof token !== 'string') return null;

    const payload = parseJwtPayload(token);
    if (!payload) return null;

    // Check expiry (with buffer for clock skew)
    if (
      typeof payload.exp === 'number' &&
      (payload.exp as number) * 1000 < Date.now() - EXPIRY_BUFFER_MS
    ) {
      return null; // Expired
    }

    const userId = payload.sub as string;
    if (!userId || typeof userId !== 'string') return null;

    const email = payload.email as string | undefined;
    const username = email?.split('@')[0] || null;
    const expiresAt = typeof payload.exp === 'number' ? (payload.exp as number) * 1000 : null;

    return { userId, email, username, expiresAt, accessToken: token, rawData: data };
  } catch (e) {
    reportError(e, 'authUtils.readLocalSession');
    return null; // Corrupted localStorage or malformed JWT
  }
}

/**
 * Quick boolean check: does localStorage contain a non-expired session?
 * Used by AuthGuard for synchronous auth checks without full parsing.
 */
export function hasLocalSession(): boolean {
  return readLocalSession() !== null;
}
