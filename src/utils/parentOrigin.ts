/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PARENT ORIGIN — Secure postMessage target origin for iframe communication
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Club Arena runs inside an iframe on smarter.poker. All postMessage calls to
 * the parent window MUST use a specific target origin instead of wildcard '*'.
 *
 * This module:
 *   1. Stores the validated parent origin once the first trusted message arrives
 *   2. Provides a safe getter for all outbound postMessage calls
 *   3. Falls back to 'https://smarter.poker' if no message has been received yet
 *
 * SECURITY: Using '*' as postMessage target leaks data to any embedder.
 *           Using a specific origin ensures only the trusted parent can read it.
 */

// The validated parent origin, set when we first receive a trusted message
let _resolvedOrigin: string | null = null;

// Allowed origins — same list used by App.tsx and main.tsx for inbound validation
const TRUSTED_ORIGINS = [
  'https://smarter.poker',
  'https://www.smarter.poker',
  'http://localhost:3000',
];

/**
 * Check if an origin is trusted (for inbound message validation)
 */
export function isTrustedOrigin(origin: string): boolean {
  if (TRUSTED_ORIGINS.includes(origin)) return true;
  if (origin === window.location.origin) return true; // Same-origin iframe proxy

  // FIX 6: Tightened subdomain check — must be exactly *.smarter.poker
  // Previously origin.endsWith('.smarter.poker') matched 'https://evil-smarter.poker'
  if (origin.startsWith('https://')) {
    const host = origin.substring(8); // strip https://
    const suffix = '.smarter.poker';
    if (host.length > suffix.length && host.endsWith(suffix)) return true;
  }

  return false;
}

/**
 * Store the validated parent origin from an inbound message.
 * Called by App.tsx / main.tsx when they receive the first trusted postMessage.
 */
export function setParentOrigin(origin: string): void {
  if (isTrustedOrigin(origin)) {
    _resolvedOrigin = origin;
  }
}

/**
 * Get the target origin for outbound postMessage calls.
 *
 * Priority:
 *   1. The validated origin from an actual received message (most accurate)
 *   2. Same-origin (if document.referrer is on smarter.poker)
 *   3. Default: 'https://smarter.poker' (safe fallback)
 *
 * NEVER returns '*'.
 */
export function getParentOrigin(): string {
  if (_resolvedOrigin) return _resolvedOrigin;

  // Try to infer from document.referrer (set by the embedding page)
  try {
    if (document.referrer) {
      const refOrigin = new URL(document.referrer).origin;
      if (isTrustedOrigin(refOrigin)) {
        _resolvedOrigin = refOrigin;
        return refOrigin;
      }
    }
  } catch {
    /* invalid referrer URL */
  }

  // Safe default — the production parent
  return 'https://smarter.poker';
}

/**
 * Safe wrapper for window.parent.postMessage that ALWAYS uses a specific origin.
 * Drop-in replacement for `window.parent.postMessage(data, '*')`.
 */
export function postToParent(data: unknown): void {
  try {
    window.parent.postMessage(data, getParentOrigin());
  } catch {
    /* cross-origin safety — frame may be detached */
  }
}
