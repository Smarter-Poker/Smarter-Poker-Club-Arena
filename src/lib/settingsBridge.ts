/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTINGS BRIDGE — the /settings page <-> the table's own settings store
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from SettingsPage on 2026-08-18 so the mapping can be unit-tested
 * without booting the page (which pulls in the Supabase client). The mapping is
 * the whole point of the fix: before it, /settings wrote its own localStorage
 * key and profiles.settings, and the table read neither.
 */
import type { TableUserSettings } from '../hooks/useTableSettings';

/**
 * 2026-08-18 — this page used to persist ~30 settings to localStorage and to
 * profiles.settings, show "Settings saved!", and change nothing at the table.
 * The table reads a DIFFERENT store (useTableSettings -> the
 * club-arena-table-settings key), and TablePage's SETTINGS_UPDATED listener
 * forwarded only two keys, one of which this page never sent.
 *
 * Every setting below now either reaches a real consumer or is not on the page.
 * The table-facing ones are written straight into the table's own store on save
 * (see saveSettings), which both persists them and broadcasts SETTINGS_CHANGED
 * so an open table applies them live. Settings that no code could consume —
 * background music, voice announcements, a second table-felt picker in a
 * vocabulary the table does not understand, an auto-muck-losing-hands switch
 * that is actually a table rule set by the host, a run-it-twice auto-accept
 * that does not exist — were removed rather than left decorative.
 */
export interface UserSettings {
  // Audio
  soundEnabled: boolean;
  soundVolume: number;

  // Display
  theme: 'dark' | 'light' | 'auto';
  cardBack: string;
  fourColorDeck: boolean;
  animationSpeed: 'slow' | 'normal' | 'fast';
  showPotOdds: boolean;

  // Gameplay
  confirmAllIn: boolean;
  /** Skip the show/muck prompt when hero wins uncontested. */
  autoMuckWinners: boolean;

  // Notifications
  tournamentReminders: boolean;
  clubActivity: boolean;
  handWonNotifications: boolean;
  achievementNotifications: boolean;
  friendAlerts: boolean;
  settlementAlerts: boolean;

}

export const DEFAULT_SETTINGS: UserSettings = {
  soundEnabled: true,
  soundVolume: 80,

  theme: 'dark',
  cardBack: 'classic_blue',
  fourColorDeck: false,
  animationSpeed: 'normal',
  showPotOdds: false,

  confirmAllIn: true,
  autoMuckWinners: false,


  tournamentReminders: true,
  clubActivity: true,
  handWonNotifications: false,
  achievementNotifications: true,
  friendAlerts: true,
  settlementAlerts: true,

};

/**
 * Validate and sanitize settings loaded from localStorage or external sources.
 * Ensures only expected types/ranges are applied — prevents injection via DevTools.
 */
export function validateSettings(raw: unknown): UserSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const s = raw as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;

  const bool = (key: string): boolean =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : (d as any)[key];
  const num = (key: string, min: number, max: number): number => {
    const v = s[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
      ? v
      : (d as any)[key];
  };
  const enumVal = <T extends string>(key: string, allowed: T[]): T => {
    return allowed.includes(s[key] as T) ? (s[key] as T) : (d as any)[key];
  };
  return {
    soundEnabled: bool('soundEnabled'),
    soundVolume: num('soundVolume', 0, 100),
    theme: enumVal('theme', ['dark', 'light', 'auto']),
    cardBack: enumVal(
      'cardBack',
      CARD_BACKS.map((b) => b.id)
    ),
    fourColorDeck: bool('fourColorDeck'),
    animationSpeed: enumVal('animationSpeed', ['slow', 'normal', 'fast']),
    showPotOdds: bool('showPotOdds'),
    confirmAllIn: bool('confirmAllIn'),
    autoMuckWinners: bool('autoMuckWinners'),
    tournamentReminders: bool('tournamentReminders'),
    clubActivity: bool('clubActivity'),
    handWonNotifications: bool('handWonNotifications'),
    achievementNotifications: bool('achievementNotifications'),
    friendAlerts: bool('friendAlerts'),
    settlementAlerts: bool('settlementAlerts'),
  };
}

// The felt is chosen at the table itself (Theme menu -> Table), which writes
// user_theme_settings.table_id and is what TablePage actually renders. The
// duplicate "Table Felt Color" picker that used to live here wrote a third
// vocabulary ('green' | 'red' | ...) that neither resolveSkin nor the
// data-felt-theme CSS understood, so four of its five options changed nothing
// and the fifth was already the default. It was removed rather than reskinned.

// These ids must match the .card-back--<id> rules in
// src/components/table/CardImage.css. The previous list
// ('classic' | 'modern' | 'minimal' | 'premium') matched none of them, so every
// option rendered the same unstyled back.
export const CARD_BACKS = [
  { id: 'classic_blue', name: 'Classic Blue' },
  { id: 'classic_red', name: 'Classic Red' },
  { id: 'diamond', name: 'Diamond' },
  { id: 'gold', name: 'Gold' },
  { id: 'dragon', name: 'Dragon' },
  { id: 'neon', name: 'Neon' },
  { id: 'galaxy', name: 'Galaxy' },
  { id: 'royal', name: 'Royal' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The bridge that was missing.
 *
 * The table reads useTableSettings (localStorage key club-arena-table-settings).
 * This page wrote localStorage key club-arena-settings plus profiles.settings,
 * which nothing at the table reads — hence "Settings saved!" changing nothing.
 * Every key below is one the table genuinely consumes; the file:line of each
 * consumer is noted so a future edit can check the other end still exists.
 */
export function toTableSettings(s: UserSettings): Partial<TableUserSettings> {
  return {
    // soundService.setMasterVolume — TablePage useEffect on soundVolume
    isSoundEnabled: s.soundEnabled,
    soundVolume: s.soundVolume,
    // SeatSlot cardBack -> <CardBack style> -> .card-back--<id>
    cardBack: s.cardBack,
    // SeatSlot / CommunityCards deckStyle
    fourColorDeck: s.fourColorDeck,
    // --animation-speed CSS custom property. It is a DURATION MULTIPLIER, so
    // a bigger number is a SLOWER animation. Inverting this is the easy bug.
    animationSpeed: s.animationSpeed === 'slow' ? 1.5 : s.animationSpeed === 'fast' ? 0.5 : 1,
    // ActionPanel showPotOdds
    showPotOdds: s.showPotOdds,
    // ActionPanel confirmAllIn
    confirmAllIn: s.confirmAllIn,
    // TablePage: suppress the show/muck prompt on an uncontested win
    autoMuckWinners: s.autoMuckWinners,
  };
}

/** The same mapping in reverse, so this page opens showing what the table is using. */
export function fromTableSettings(t: TableUserSettings, base: UserSettings): UserSettings {
  return {
    ...base,
    soundEnabled: t.isSoundEnabled,
    soundVolume: t.soundVolume,
    cardBack: CARD_BACKS.some((b) => b.id === t.cardBack) ? t.cardBack : base.cardBack,
    fourColorDeck: t.fourColorDeck,
    animationSpeed: t.animationSpeed >= 1.5 ? 'slow' : t.animationSpeed <= 0.5 ? 'fast' : 'normal',
    showPotOdds: t.showPotOdds,
    confirmAllIn: t.confirmAllIn,
    autoMuckWinners: t.autoMuckWinners,
  };
}
