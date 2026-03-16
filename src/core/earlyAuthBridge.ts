/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EARLY AUTH BRIDGE — Shared state between main.tsx and App.tsx
 * ═══════════════════════════════════════════════════════════════════════════════
 * This module exists solely to avoid circular dependencies.
 * main.tsx writes to earlyAuth (before boot), App.tsx reads from it (on mount).
 *
 * DO NOT import anything from main.tsx or App.tsx in this file.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

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
