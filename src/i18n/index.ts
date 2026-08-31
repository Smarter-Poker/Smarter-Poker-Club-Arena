/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  i18n — Internationalization Framework (Bible V8 Chapter 8 NFR)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lightweight, zero-dependency i18n system for Club Arena.
 * Supports 12+ languages via JSON locale files with:
 * - Interpolation: t('pot_amount', { amount: 500 }) => "Pot: 500"
 * - Pluralization: t('players_count', { count: 3 }) => "3 players"
 * - Fallback to English for missing keys
 * - Runtime locale switching without reload
 * - Type-safe translation keys
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type Locale =
  | 'en'
  | 'es'
  | 'pt'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'ru'
  | 'de'
  | 'fr'
  | 'it'
  | 'tr'
  | 'vi';

export type TranslationValues = Record<string, string | number>;

type TranslationEntry = string | { one: string; other: string };
type TranslationMap = Record<string, TranslationEntry>;

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentLocale: Locale = 'en';
const loadedLocales: Map<Locale, TranslationMap> = new Map();
const listeners: Set<(locale: Locale) => void> = new Set();

// ═══════════════════════════════════════════════════════════════════════════════
// ENGLISH TRANSLATIONS (built-in fallback — always available)
// ═══════════════════════════════════════════════════════════════════════════════

const en: TranslationMap = {
  // ── Table UI ──
  pot: 'POT',
  pot_amount: 'Pot: {{amount}}',
  total: 'TOTAL',
  side_pot: 'Side Pot {{index}}',
  community_cards: 'Community cards',
  no_cards_dealt: 'none dealt',
  stage_flop: 'FLOP',
  stage_turn: 'TURN',
  stage_river: 'RIVER',
  stage_showdown: 'SHOWDOWN',

  // ── Seat ──
  seat_empty: 'Seat {{number}}: empty',
  seat_open: 'Seat {{number}}: open - click to sit',
  seat_player: 'Seat {{number}}: {{name}}',
  seat_active: '(acting now)',
  seat_folded: '(folded)',
  seat_all_in: '(all in)',
  sit: '+ SIT',
  stack: 'stack {{amount}}',

  // ── Actions ──
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  raise: 'Raise',
  bet: 'Bet',
  all_in: 'All In',
  confirm_all_in: 'CONFIRM ALL-IN ({{amount}})',
  cancel: 'Cancel',
  back: 'Back',
  raise_to: 'Raise {{amount}}',
  call_amount: 'Call {{amount}}',

  // ── Action shortcuts ──
  shortcut_fold: 'Fold (F or Q)',
  shortcut_check_call: 'Check/Call (C or W)',
  shortcut_raise: 'Raise/Bet (R or E)',

  // ── Raise panel ──
  raise_amount_label: 'Raise amount',
  raise_amount_edit: 'Edit bet amount {{amount}} - opens numeric keyboard',
  type_exact_amount: 'Type exact bet amount',
  bet_preset: 'Bet {{label}}',
  bet_all_in: 'Bet all in',
  open_raise_panel: 'Open raise panel',
  confirm_all_in_amount: 'Confirm all in {{amount}}',
  cancel_all_in: 'Cancel all in',

  // ── Pre-actions ──
  check_fold: 'Check/Fold',
  call_any: 'Call Any',
  check_back: 'Check',

  // ── Timer ──
  time_remaining: '{{seconds}} seconds remaining',
  time_bank: 'Time bank',
  time_bank_active: 'Time bank active',
  time_expired: 'Time expired',

  // ── Chat ──
  send_message: 'Send message',
  type_message: 'Type a message...',
  chat: 'Chat',

  // ── Tournament ──
  tournament: 'Tournament',
  cash_game: 'Cash Game',
  blinds: 'Blinds',
  level: 'Level {{number}}',
  players_remaining: { one: '{{count}} player remaining', other: '{{count}} players remaining' },
  buy_in: 'Buy-in',
  prize_pool: 'Prize Pool',
  next_break: 'Next Break',

  // ── Lobby ──
  create_table: 'Create Table',
  join_table: 'Join Table',
  leave_table: 'Leave Table',
  sit_out: 'Sit Out',
  sit_in: 'Sit In',
  settings: 'Settings',
  hand_history: 'Hand History',

  // ── Connection ──
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
  connection_lost: 'Connection lost',
  connection_restored: 'Connection restored',

  // ── Notifications ──
  your_turn: 'Your turn to act',
  your_turn_reminder: 'Still your turn!',
  you_won: 'You won {{amount}}!',
  hand_result: '{{name}} wins {{amount}}',

  // ── Errors ──
  action_failed: 'Action failed',
  invalid_amount: 'Invalid amount',
  insufficient_chips: 'Not enough chips',
  table_full: 'Table is full',
  not_your_turn: 'Not your turn',

  // ── Misc ──
  loading: 'Loading...',
  spectator: 'Spectator',
  dealer: 'Dealer',
  small_blind: 'Small Blind',
  big_blind: 'Big Blind',
  ante: 'Ante',
  straddle: 'Straddle',
  bomb_pot: 'Bomb Pot',
};

loadedLocales.set('en', en);

// ═══════════════════════════════════════════════════════════════════════════════
// CORE API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Translate a key with optional interpolation values.
 *
 * @example
 *   t('pot_amount', { amount: 500 })  // "Pot: 500"
 *   t('players_remaining', { count: 1 }) // "1 player remaining"
 *   t('players_remaining', { count: 3 }) // "3 players remaining"
 */
export function t(key: string, values?: TranslationValues): string {
  const locale = loadedLocales.get(currentLocale);
  const fallback = loadedLocales.get('en')!;

  const entry = locale?.[key] ?? fallback[key];

  if (entry === undefined) {
    // Development: warn about missing key
    if (import.meta.env?.DEV) {
      console.warn(`[i18n] Missing translation key: "${key}"`);
    }
    return key; // Return key as-is (better than empty string)
  }

  // Handle pluralization
  let template: string;
  if (typeof entry === 'object') {
    const count = values?.count;
    template = count === 1 ? entry.one : entry.other;
  } else {
    template = entry;
  }

  // Handle interpolation: {{variable}} → value
  if (values) {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
      const val = values[varName];
      return val !== undefined ? String(val) : `{{${varName}}}`;
    });
  }

  return template;
}

/**
 * Get the current locale.
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Set the active locale. Falls back to 'en' if locale not loaded.
 * Notifies all listeners (React components re-render via useLocale hook).
 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
  // Persist preference
  try {
    localStorage.setItem('club-arena-locale', locale);
  } catch {
    // SSR or storage unavailable
  }
  // Notify listeners
  for (const fn of listeners) {
    fn(locale);
  }
}

/**
 * Register a locale's translations. Merges with existing if already loaded.
 * Use this for lazy-loading non-English locales.
 */
export function registerLocale(locale: Locale, translations: TranslationMap): void {
  const existing = loadedLocales.get(locale);
  if (existing) {
    loadedLocales.set(locale, { ...existing, ...translations });
  } else {
    loadedLocales.set(locale, translations);
  }
}

/**
 * Subscribe to locale changes. Returns unsubscribe function.
 */
export function onLocaleChange(callback: (locale: Locale) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Get list of all available locale codes.
 */
export function getAvailableLocales(): Locale[] {
  return ['en', 'es', 'pt', 'zh', 'ja', 'ko', 'ru', 'de', 'fr', 'it', 'tr', 'vi'];
}

/**
 * Get human-readable name for a locale.
 */
export function getLocaleName(locale: Locale): string {
  const names: Record<Locale, string> = {
    en: 'English',
    es: 'Espanol',
    pt: 'Portugues',
    zh: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
    ru: 'Russian',
    de: 'Deutsch',
    fr: 'Francais',
    it: 'Italiano',
    tr: 'Turkce',
    vi: 'Tieng Viet',
  };
  return names[locale] || locale;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT — restore saved preference
// ═══════════════════════════════════════════════════════════════════════════════

try {
  const saved = localStorage.getItem('club-arena-locale') as Locale | null;
  if (saved && getAvailableLocales().includes(saved)) {
    currentLocale = saved;
  }
} catch {
  // SSR or storage unavailable — use default 'en'
}
