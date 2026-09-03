/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TIMING CONSTANTS — Centralized debounce, animation, and retry values
 * ═══════════════════════════════════════════════════════════════════════════════
 * Replaces magic numbers scattered across the codebase.
 * Import from here instead of hardcoding values.
 */

// ── Debounce Delays ─────────────────────────────────────────
/** Standard debounce for search inputs (ms) */
export const DEBOUNCE_SEARCH_MS = 300;

/** Standard debounce for bus event subscriptions (ms) */
export const DEBOUNCE_BUS_MS = 500;

/** Debounce for expensive computations (ms) */
export const DEBOUNCE_HEAVY_MS = 1000;

// ── Animation Timing ────────────────────────────────────────
/** Stagger delay between list items appearing (ms) */
export const STAGGER_ITEM_MS = 60;

/** Standard transition duration (ms) */
export const TRANSITION_MS = 300;

/** Modal enter/exit animation (ms) */
export const MODAL_ANIMATION_MS = 200;

/** Toast notification display duration (ms) */
export const TOAST_DURATION_MS = 3000;

/** Success message display before redirect (ms) */
export const SUCCESS_REDIRECT_MS = 1200;

// ── Retry & Network ────────────────────────────────────────
/** Default retry attempts for Supabase operations */
export const DEFAULT_RETRY_COUNT = 3;

/** Delay between retries (ms) */
export const RETRY_DELAY_MS = 1000;

/** Network request timeout (ms) */
export const REQUEST_TIMEOUT_MS = 10000;

/** Reconnection attempt delay (ms) */
export const RECONNECT_DELAY_MS = 2000;

/** Maximum reconnection attempts before giving up */
export const MAX_RECONNECT_ATTEMPTS = 10;

// ── Polling & Refresh ───────────────────────────────────────
/** Visibility refresh interval (ms) */
export const VISIBILITY_REFRESH_MS = 30000;

/** Real-time presence heartbeat interval (ms) */
export const PRESENCE_HEARTBEAT_MS = 15000;

/** Auto-save interval for drafts (ms) */
export const AUTO_SAVE_MS = 5000;
