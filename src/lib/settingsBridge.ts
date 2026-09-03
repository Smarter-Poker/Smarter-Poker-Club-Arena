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
import {
  normalizeCardBack,
  SELECTABLE_CARD_BACK_IDS,
  CARD_BACK_CATALOG,
} from '../components/table/CardImage';

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
  /** Dan 2026-08-28: the scrolling tournament/announcement ticker. */
  showTicker: boolean;

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
  /* 70, not 80. This was the ONE outlier among four copies of this default:
     useTableSettings, SettingsPanel and the `sound_volume` column all say 70,
     and that migration's COMMENT ON COLUMN says the client and DB "MUST agree".
     It was masked on the normal path because `fromTableSettings` overrides it
     from the table store — but `validateSettings` falls back to this value for
     any stored blob that fails validation, at which point saving raised the
     player's volume by 14% without being asked. */
  soundVolume: 70,

  theme: 'dark',
  cardBack: 'classic_blue',
  fourColorDeck: false,
  animationSpeed: 'normal',
  showPotOdds: false,
  showTicker: true,

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
    // 2026-08-20: this used to whitelist against the eight TABLE ids only, so
    // a card back bought in the store (burgundy, navy, holographic, carbon,
    // club crest, diamond foil...) was REJECTED here and silently reverted to
    // the default — diamonds spent, nothing applied. Accept every selectable
    // id; normalizeCardBack maps it to a real design at render time.
    cardBack: enumVal('cardBack', [...SELECTABLE_CARD_BACK_IDS]),
    fourColorDeck: bool('fourColorDeck'),
    animationSpeed: enumVal('animationSpeed', ['slow', 'normal', 'fast']),
    showPotOdds: bool('showPotOdds'),
    showTicker: bool('showTicker'),
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

/**
 * The card backs the /settings dropdown may offer.
 *
 * DERIVED from the one catalogue (CARD_BACK_CATALOG in CardImage.tsx) rather
 * than hand-listed. 2026-08-26: the hand-written list had drifted twice over.
 * It carried EIGHT ids against the shipped twelve — so four owned designs
 * were unreachable from this page — and, worse, five of the eight were PAID
 * (`diamond` 100, `dragon` 125, `gold` 150, `neon` 75, `galaxy` 75) and this
 * was the only card-back picker in the app that never called
 * `isCardBackUnlocked`. A player could equip a 150-diamond design from a
 * plain dropdown while the store charged everyone else for it.
 *
 * Restricted to the FREE tier for exactly that reason: a `<select>` has
 * nowhere to show a lock, a price or a purchase flow. Paid designs are sold
 * by Table Studio, which gates every category on permanent ownership.
 * Deriving means a design added to the catalogue appears here automatically
 * if it is free, and can never appear here by accident if it is not.
 */
export const CARD_BACKS = CARD_BACK_CATALOG.filter((d) => d.tier === 'standard').map((d) => ({
  id: d.id as string,
  name: d.name,
}));

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
export function toTableSettings(
  s: UserSettings,
  /**
   * What the table store currently holds. Optional so existing callers keep
   * working; passing it is what makes the animation-speed round trip lossless.
   */
  current?: TableUserSettings
): Partial<TableUserSettings> {
  /* PRESERVE A SPEED THIS PAGE CANNOT NAME. The store's scale is
     0.5 | 1 | 1.5 | 2 and this page offers three labels, so a stored 2 comes in
     as 'slow' and would go back out as 1.5 — a value silently changed by a page
     the user opened to change something else. If the label still describes the
     stored number, keep the number. */
  const labelOf = (n: number) => (n >= 1.5 ? 'slow' : n <= 0.5 ? 'fast' : 'normal');
  const animationSpeed =
    current && labelOf(current.animationSpeed) === s.animationSpeed
      ? current.animationSpeed
      : s.animationSpeed === 'slow'
        ? 1.5
        : s.animationSpeed === 'fast'
          ? 0.5
          : 1;

  return {
    // soundService.setMasterVolume — useTableSettings applyGateChanges
    isSoundEnabled: s.soundEnabled,
    soundVolume: s.soundVolume,
    // SeatSlot cardBack -> <CardBack style> -> .card-back--<id>
    cardBack: s.cardBack,
    // SeatSlot / CommunityCards deckStyle
    fourColorDeck: s.fourColorDeck,
    // --animation-speed CSS custom property. It is a DURATION MULTIPLIER, so
    // a bigger number is a SLOWER animation. Inverting this is the easy bug.
    animationSpeed,
    // ActionPanel showPotOdds
    showPotOdds: s.showPotOdds,
    // TournamentStartingTicker — Dan 2026-08-28 ticker on/off
    showTicker: s.showTicker,
    // ActionPanel confirmAllIn
    confirmAllIn: s.confirmAllIn,
    /* autoMuckWinners: NOT written. Its control was removed from SettingsPage on
       2026-08-29 because the prompt it governs has been hard-disabled since
       2026-08-23 — see the note where the toggle used to be. Writing a column
       that no control governs is how `live_notifications` got clobbered. */
  };
}

/** The same mapping in reverse, so this page opens showing what the table is using. */
export function fromTableSettings(t: TableUserSettings, base: UserSettings): UserSettings {
  return {
    ...base,
    soundEnabled: t.isSoundEnabled,
    soundVolume: t.soundVolume,
    // Keep any selectable id (store purchases included); only a genuinely
    // unknown id falls back to what the settings page already had.
    cardBack: SELECTABLE_CARD_BACK_IDS.includes(t.cardBack)
      ? t.cardBack
      : normalizeCardBack(t.cardBack) || base.cardBack,
    fourColorDeck: t.fourColorDeck,
    /* LOSSY, and knowingly so. `TableUserSettings.animationSpeed` is documented
       as 0.5 | 1 | 1.5 | 2, and this page offers three choices, so a stored 2
       reads back as 'slow' and `toTableSettings` maps 'slow' to 1.5. Opening
       /settings and pressing Save — without touching the animation control —
       used to change a 2 into a 1.5 permanently.

       `toTableSettings` now preserves an unchanged selection instead of
       re-deriving it, so the round trip is only lossy if the user actually
       picks a different speed, which is a choice rather than a side effect. */
    animationSpeed: t.animationSpeed >= 1.5 ? 'slow' : t.animationSpeed <= 0.5 ? 'fast' : 'normal',
    showPotOdds: t.showPotOdds,
    showTicker: t.showTicker,
    confirmAllIn: t.confirmAllIn,
    autoMuckWinners: t.autoMuckWinners,
  };
}

/**
 * Restore the card-back control to the last table value after the canonical
 * appearance write rejects a change. The Settings page persists the returned
 * object locally and to profiles.settings, so no surface can claim a failed
 * design is equipped.
 */
export function rollbackFailedCardBack(
  settings: UserSettings,
  previousCardBack: string
): UserSettings {
  return {
    ...settings,
    cardBack: normalizeCardBack(previousCardBack),
  };
}
