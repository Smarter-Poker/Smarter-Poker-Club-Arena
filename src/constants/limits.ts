/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIMITS CONSTANTS — Pagination, query limits, and capacity values
 * ═══════════════════════════════════════════════════════════════════════════════
 * Replaces magic numbers for list sizes, query limits, and capacity caps.
 */

// ── Pagination & Virtual Scroll ─────────────────────────────
/** Default initial items to render in virtual lists */
export const VIRTUAL_SCROLL_INITIAL = 30;

/** Items to load per page when scrolling */
export const VIRTUAL_SCROLL_PAGE_SIZE = 20;

/** Maximum members to cache in SWR sessionStorage */
export const SWR_CACHE_MAX_ITEMS = 200;

// ── Query Limits ────────────────────────────────────────────
/** Default query limit for chat messages */
export const CHAT_MESSAGE_LIMIT = 50;

/** Default query limit for notifications */
export const NOTIFICATION_LIMIT = 50;

/** Default query limit for anti-cheat flags/events */
export const ANTI_CHEAT_QUERY_LIMIT = 50;

/** Default query limit for search results */
export const SEARCH_RESULT_LIMIT = 20;

/** Maximum members to fetch per club */
export const CLUB_MEMBERS_LIMIT = 5000;

// ── Financial Limits ────────────────────────────────────────
/** Default minimum buy-in (big blinds) */
export const DEFAULT_MIN_BUYIN_BB = 40;

/** Default maximum buy-in (big blinds) */
export const DEFAULT_MAX_BUYIN_BB = 200;

/** Default rake percentage */
export const DEFAULT_RAKE_PERCENT = 5;

/** Default rake cap */
export const DEFAULT_RAKE_CAP = 3;

// ── UI Limits ───────────────────────────────────────────────
/** Maximum characters for truncated text displays */
export const TRUNCATE_MAX_CHARS = 80;

/** Maximum table size (seats) */
export const MAX_TABLE_SEATS = 10;

/** Default action time (seconds) */
export const DEFAULT_ACTION_TIME_SEC = 15;
