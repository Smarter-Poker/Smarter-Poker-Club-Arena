/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EARLY AUTH BRIDGE — Shared state between index.html inline script, main.tsx, and App.tsx
 * ═══════════════════════════════════════════════════════════════════════════════
 * Token sources (in priority order):
 * 1. window.__EARLY_AUTH__ — set by the inline <script> in index.html (runs BEFORE modules)
 * 2. earlyAuth module export — set by the module-level handler in main.tsx
 *
 * The inline script in index.html is the PRIMARY mechanism because it runs
 * before ANY ES module evaluation. If the module tree has a runtime error,
 * the inline script still handles the ACK and stores the token.
 *
 * DO NOT import anything from main.tsx or App.tsx in this file.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Declare the window augmentation for TypeScript
declare global {
  interface Window {
    __EARLY_AUTH__?: {
      token: string | null;
      refreshToken: string | null;
      settings: Record<string, unknown> | null;
    };
  }
}

/** Module-level storage for auth received before React mounts */
export const earlyAuth: {
  token: string | null;
  refreshToken: string | null;
  settings: Record<string, unknown> | null;
} = {
  token: null,
  refreshToken: null,
  settings: null,
};

/**
 * Get the earliest available auth token.
 * Checks inline script storage first (window.__EARLY_AUTH__),
 * then falls back to the module-level earlyAuth.
 */
export function getEarlyAuthToken(): string | null {
  // Priority 1: Inline script (runs before modules)
  if (window.__EARLY_AUTH__?.token) {
    return window.__EARLY_AUTH__.token;
  }
  // Priority 2: Module-level handler
  return earlyAuth.token;
}

export function getEarlyAuthRefreshToken(): string | null {
  if (window.__EARLY_AUTH__?.refreshToken) {
    return window.__EARLY_AUTH__.refreshToken;
  }
  return earlyAuth.refreshToken;
}

export function getEarlyAuthSettings(): Record<string, unknown> | null {
  if (window.__EARLY_AUTH__?.settings) {
    return window.__EARLY_AUTH__.settings;
  }
  return earlyAuth.settings;
}
