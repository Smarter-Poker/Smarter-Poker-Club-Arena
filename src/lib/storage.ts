/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💾 STORAGE — Local Storage & Session Utilities
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get item from localStorage with type safety
 */
export function getLocalStorage<T>(key: string, defaultValue: T): T {
  try {
    const item = localStorage.getItem(key);
    if (item === null) return defaultValue;
    return JSON.parse(item) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Set item in localStorage
 */
export function setLocalStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }
}

/**
 * Remove item from localStorage
 */
export function removeLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn('Failed to remove from localStorage:', error);
  }
}

/**
 * Clear all localStorage
 */
export function clearLocalStorage(): void {
  try {
    localStorage.clear();
  } catch (error) {
    console.warn('Failed to clear localStorage:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get item from sessionStorage with type safety
 */
export function getSessionStorage<T>(key: string, defaultValue: T): T {
  try {
    const item = sessionStorage.getItem(key);
    if (item === null) return defaultValue;
    return JSON.parse(item) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Set item in sessionStorage
 */
export function setSessionStorage<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn('Failed to save to sessionStorage:', error);
  }
}

/**
 * Remove item from sessionStorage
 */
export function removeSessionStorage(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch (error) {
    console.warn('Failed to remove from sessionStorage:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE WITH EXPIRY
// ═══════════════════════════════════════════════════════════════════════════════

interface StoredWithExpiry<T> {
  value: T;
  expiry: number;
}

/**
 * Set item with expiration time
 */
export function setWithExpiry<T>(key: string, value: T, ttlMs: number): void {
  const item: StoredWithExpiry<T> = {
    value,
    expiry: Date.now() + ttlMs,
  };
  setLocalStorage(key, item);
}

/**
 * Get item with expiration check
 */
export function getWithExpiry<T>(key: string, defaultValue: T): T {
  const item = getLocalStorage<StoredWithExpiry<T> | null>(key, null);

  if (!item) return defaultValue;

  if (Date.now() > item.expiry) {
    removeLocalStorage(key);
    return defaultValue;
  }

  return item.value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE KEYS (Centralized key management)
// ═══════════════════════════════════════════════════════════════════════════════

export const STORAGE_KEYS = {
  // ── Auth ──
  AUTH_TOKEN: 'club_arena_auth_token',
  REFRESH_TOKEN: 'club_arena_refresh_token',
  USER_PROFILE: 'club_arena_user_profile',
  SSO_AUTH: 'smarter-poker-auth', // Shared SSO key with World Hub
  SUPABASE_AUTH_MIGRATION: 'supabase_auth_migration_done',

  // ── User Preferences ──
  THEME: 'club_arena_theme',
  SOUNDS: 'club_arena_sounds', // Canonical sound toggle (NOT 'soundsEnabled')
  SOUND_ENABLED: 'club_arena_sound_enabled', // Legacy — prefer SOUNDS
  VIBRATIONS: 'vibrationsEnabled', // Haptic feedback toggle
  SHOW_STACK_BB: 'showStackInBB', // Display stack in big blinds
  NOTIFICATIONS_ENABLED: 'club_arena_notifications_enabled',
  LANGUAGE: 'club_arena_language',
  CARD_COLOR: 'club_arena_card_color', // Card back color preset
  USE_REAL_NAME: 'club_arena_use_real_name', // Show real name instead of alias

  // ── Table Settings ──
  TABLE_THEME: 'club_arena_table_theme',
  TABLE_FELT_THEME: 'club-arena-table-theme', // Table felt color
  TABLE_SETTINGS: 'club-arena-table-settings', // Combined table settings JSON
  CARD_STYLE: 'club_arena_card_style',
  DECK_STYLE: 'club_arena_deck', // Deck style selection
  AUTO_MUCK: 'club_arena_auto_muck',
  SHOW_BIG_BLINDS: 'club_arena_show_bbs',
  FOUR_COLOR_DECK: 'club_arena_four_color',
  MUTED_PLAYERS: 'ca_muted_players', // JSON array of muted player IDs

  // ── UI State ──
  SIDEBAR_COLLAPSED: 'club_arena_sidebar_collapsed',
  ACTIVE_CLUB_ID: 'club_arena_active_club',
  RECENT_TABLES: 'club_arena_recent_tables',
  LAST_CLUB: 'club_arena_last_club', // Last visited club ID
  LAST_VISITED: 'club_arena_last_visited', // Last visited club (carousel)
  PINNED_CLUBS: 'club_arena_pinned_clubs', // Pinned clubs JSON array
  CLUB_ORDER: 'club_arena_club_order', // Custom carousel order
  INTRO_SHOWN: 'club_arena_intro_shown', // Intro tutorial completed
  TUTORIAL_COMPLETED: 'tutorial_completed', // Legacy tutorial flag
  WELCOME_ACCEPTED: 'club_arena_welcome_accepted', // Welcome modal dismissed
  QUICK_ACTIONS_RECENT: 'quickActionsRecent', // Recent quick actions

  // ── Cache ──
  LOBBY_CACHE: 'club_arena_lobby_cache',
  PLAYER_STATS_CACHE: 'club_arena_player_stats',
  CLUB_STATS_CACHE: 'smp_club_stats_cache',
  CLUB_STATS_CACHE_TS: 'smp_club_stats_cache_ts',
  CLUBS_CACHE: 'club_arena_clubs_cache', // Cached club list
  CLUBS_CACHE_TS: 'club_arena_clubs_cache_ts', // Cache timestamp
  CLUBS_PAGE_CACHE: 'clubs_page_clubs_cache',
  CAROUSEL_CLUBS_CACHE: 'club_carousel_clubs_cache',
  CAROUSEL_UNIONS_CACHE: 'club_carousel_unions_cache',
  CLUBS_PAGE_UNIONS_CACHE: 'clubs_page_unions_cache',
  SHARK_STATS_SWR: 'shark_club_stats_swr',
  PLAYER_STATS_SWR: 'club-arena-player-stats', // usePlayerStats hook cache

  // ── Filter Persistence ──
  LOBBY_FILTER: 'club_arena_lobby_filter',
  LOBBY_SORT: 'club_arena_lobby_sort',
  HAND_HISTORY_FILTER: 'club_arena_hh_filter',
  LEADERBOARD_PREFS: 'club_arena_leaderboard',
  CHAT_PREFS: 'club_arena_chat_prefs',
  TOURNAMENT_FILTER: 'club_arena_tournament_filter',
  FAVORITE_TABLES: 'favorite_tables',
  RECENT_SEARCHES: 'recentSearches',

  // ── Notifications ──
  NOTIF_PREFERENCES: 'notif_preferences',
  NOTIF_DIGEST_MODE: 'notif_digest_mode',
  NOTIF_SOUNDS: 'notif_sounds',
  DND_UNTIL: 'dnd_until',
  LAST_DAILY_RESET_REMINDER: 'last_daily_reset_reminder',

  // ── PWA ──
  PWA_INSTALLED: 'pwa_installed',
  PWA_DISMISS_COUNT: 'pwa_dismiss_count',
  PWA_PROMPT_DISMISSED: 'pwa_prompt_dismissed',

  // ── Settings Page ──
  //
  // 2026-08-26: this was 'club-arena-settings', which is ALSO the zustand
  // persist name in src/stores/useSettingsStore.ts. SettingsPage.saveSettings
  // wrote a flat UserSettings object here and then called setTheme twelve
  // lines later; zustand's persist middleware immediately overwrote the same
  // key with its own {state, version} envelope. On the next load — including
  // every useVisibilityRefresh when the user came back to the tab —
  // validateSettings() parsed that envelope, matched none of its own fields
  // and silently returned DEFAULT_SETTINGS. The page reset itself mid-session
  // and no save ever survived.
  //
  // The two stores now own separate keys. Do NOT point this back at
  // 'club-arena-settings'; useSettingsStore still holds that one.
  SETTINGS: 'club-arena-user-settings',

  // ── Offline & Recovery ──
  OFFLINE_QUEUE: 'offline_mutation_queue',
  CHUNK_RELOAD: 'club_arena_chunk_reload',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPED STORAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  language: string;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  soundEnabled: true,
  notificationsEnabled: true,
  language: 'en',
};

/**
 * Get user preferences
 */
export function getPreferences(): UserPreferences {
  return {
    theme: getLocalStorage(STORAGE_KEYS.THEME, DEFAULT_PREFERENCES.theme),
    soundEnabled: getLocalStorage(STORAGE_KEYS.SOUND_ENABLED, DEFAULT_PREFERENCES.soundEnabled),
    notificationsEnabled: getLocalStorage(
      STORAGE_KEYS.NOTIFICATIONS_ENABLED,
      DEFAULT_PREFERENCES.notificationsEnabled
    ),
    language: getLocalStorage(STORAGE_KEYS.LANGUAGE, DEFAULT_PREFERENCES.language),
  };
}

/**
 * Save user preferences
 */
export function savePreferences(prefs: Partial<UserPreferences>): void {
  if (prefs.theme !== undefined) {
    setLocalStorage(STORAGE_KEYS.THEME, prefs.theme);
  }
  if (prefs.soundEnabled !== undefined) {
    setLocalStorage(STORAGE_KEYS.SOUND_ENABLED, prefs.soundEnabled);
  }
  if (prefs.notificationsEnabled !== undefined) {
    setLocalStorage(STORAGE_KEYS.NOTIFICATIONS_ENABLED, prefs.notificationsEnabled);
  }
  if (prefs.language !== undefined) {
    setLocalStorage(STORAGE_KEYS.LANGUAGE, prefs.language);
  }
}

// ── REMOVED 2026-08-26: orphan third settings store ──────────────────────
// `TableSettings` / `getTableSettings` / `saveTableSettings` and the
// AUTO_MUCK / SHOW_BIG_BLINDS keys had ZERO consumers repo-wide. The live
// stores are useUserTableSettings (Supabase `user_table_settings`, canonical)
// and useTableSettings (localStorage `club-arena-table-settings`). A third
// set of defaults that nothing reads is a trap: it looks like the source of
// truth for auto-muck and stack display, and it is not.

/**
 * Add to recent tables list
 */
export function addRecentTable(tableId: string): void {
  const recent = getLocalStorage<string[]>(STORAGE_KEYS.RECENT_TABLES, []);
  const filtered = recent.filter((id) => id !== tableId);
  const updated = [tableId, ...filtered].slice(0, 10); // Keep last 10
  setLocalStorage(STORAGE_KEYS.RECENT_TABLES, updated);
}

/**
 * Get recent tables
 */
export function getRecentTables(): string[] {
  return getLocalStorage<string[]>(STORAGE_KEYS.RECENT_TABLES, []);
}
